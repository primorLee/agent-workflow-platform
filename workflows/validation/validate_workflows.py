#!/usr/bin/env python3
"""Fail-closed validation for the public Agent Workflow Platform workflow pack."""

from __future__ import annotations

import argparse
import json
import os
import py_compile
import re
import runpy
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from jsonschema import Draft202012Validator, FormatChecker
    from jsonschema.exceptions import SchemaError
except ImportError:  # reported as a validation failure in main
    Draft202012Validator = None
    FormatChecker = None
    SchemaError = Exception

WORKFLOWS = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {".md", ".json", ".jsonl", ".py"}
RECIPE_KEYS = {"title", "tags", "trigger", "verified", "priority", "status"}
EVENT_TYPES = {"health_check", "stalled_session", "guardian_error", "shutdown"}
SCHEMA_FILES = {
    "mode": WORKFLOWS / "schemas" / "mode.schema.json",
    "gate-mappings": WORKFLOWS / "schemas" / "gate-mappings.schema.json",
    "run-state": WORKFLOWS / "schemas" / "run-state.schema.json",
    "guardian-event": WORKFLOWS / "schemas" / "guardian-event.schema.json",
}


class ValidationError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def _joined(*parts: str) -> str:
    return "".join(parts)


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"invalid JSON {path.relative_to(WORKFLOWS)}: {type(exc).__name__}")


def load_schema(name: str):
    if Draft202012Validator is None or FormatChecker is None:
        fail("jsonschema[format] is required; install requirements-validation.txt")
    schema = load_json(SCHEMA_FILES[name])
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        fail(f"invalid JSON Schema schemas/{SCHEMA_FILES[name].name}: {exc.validator}")
    return schema


def schema_errors(instance, schema_name: str):
    schema = load_schema(schema_name)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    return sorted(validator.iter_errors(instance), key=lambda error: list(error.absolute_path))


def require_schema(instance, schema_name: str, label: str) -> None:
    errors = schema_errors(instance, schema_name)
    if not errors:
        return
    error = errors[0]
    location = "/".join(str(part) for part in error.absolute_path) or "$"
    fail(f"{label} violates {schema_name} schema keyword {error.validator} at {location}")


def validate_json_files() -> int:
    count = 0
    for path in sorted(WORKFLOWS.rglob("*.json")):
        load_json(path)
        count += 1
    for path in sorted(WORKFLOWS.rglob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as exc:
            fail(f"invalid JSONL {path.relative_to(WORKFLOWS)}: {type(exc).__name__}")
        for number, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError:
                fail(f"invalid JSONL {path.relative_to(WORKFLOWS)}:{number}")
            count += 1
    return count


def validate_json_schemas() -> int:
    for name in SCHEMA_FILES:
        load_schema(name)

    for mode_name in ("daily", "parallel", "research"):
        require_schema(
            load_json(WORKFLOWS / "modes" / f"{mode_name}.json"),
            "mode",
            f"modes/{mode_name}.json",
        )
    require_schema(
        load_json(WORKFLOWS / "modes" / "gate-mappings.json"),
        "gate-mappings",
        "modes/gate-mappings.json",
    )
    require_schema(
        load_json(WORKFLOWS / "examples" / "run-state.synthetic.json"),
        "run-state",
        "examples/run-state.synthetic.json",
    )

    history = WORKFLOWS / "examples" / "guardian-history.synthetic.jsonl"
    for number, line in enumerate(history.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            require_schema(
                json.loads(line),
                "guardian-event",
                f"examples/guardian-history.synthetic.jsonl:{number}",
            )

    # Prove additionalProperties is active instead of only parsing schema files.
    invalid_mode = dict(load_json(WORKFLOWS / "modes" / "daily.json"))
    invalid_mode["unexpected_public_field"] = True
    if not schema_errors(invalid_mode, "mode"):
        fail("mode schema did not reject an unexpected top-level property")
    return len(SCHEMA_FILES) + 5


def validate_run_state() -> None:
    state = load_json(WORKFLOWS / "examples" / "run-state.synthetic.json")
    require_schema(state, "run-state", "examples/run-state.synthetic.json")
    seen: set[str] = set()
    for task in state["backlog"]:
        if task["id"] in seen:
            fail(f"duplicate task id {task['id']}")
        seen.add(task["id"])
    for task in state["backlog"]:
        unknown = set(task.get("depends", [])) - seen
        if unknown:
            fail(f"task {task['id']} has unknown dependencies {sorted(unknown)}")


def validate_guardian_history() -> None:
    path = WORKFLOWS / "examples" / "guardian-history.synthetic.jsonl"
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    if not events:
        fail("guardian history example is empty")
    for number, event in enumerate(events, 1):
        require_schema(event, "guardian-event", f"guardian history event {number}")
        if event["event"] not in EVENT_TYPES:
            fail(f"unknown guardian event {event['event']}")


def parse_frontmatter(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        fail(f"recipe has no front matter: {path.name}")
    try:
        end = lines.index("---", 1)
    except ValueError:
        fail(f"recipe front matter is not closed: {path.name}")
    values: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.startswith(" "):
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
    missing = RECIPE_KEYS - set(values)
    if missing:
        fail(f"recipe {path.name} missing front-matter keys {sorted(missing)}")
    if values["status"] not in {"active", "deprecated", "superseded"}:
        fail(f"recipe {path.name} has invalid status {values['status']}")
    return values


def validate_recipes() -> int:
    recipes = [path for path in (WORKFLOWS / "recipes").glob("*.md") if path.name != "INDEX.md"]
    if len(recipes) < 10:
        fail("expected at least ten production-derived recipes")
    for path in sorted(recipes):
        parse_frontmatter(path)
    index = (WORKFLOWS / "recipes" / "INDEX.md").read_text(encoding="utf-8")
    for path in recipes:
        if f"({path.name})" not in index:
            fail(f"recipe is not indexed: {path.name}")
    return len(recipes)


def validate_links() -> int:
    pattern = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
    count = 0
    for document in sorted(WORKFLOWS.rglob("*.md")):
        text = document.read_text(encoding="utf-8")
        for raw in pattern.findall(text):
            target = raw.strip().split("#", 1)[0]
            if not target or "://" in target or target.startswith("mailto:"):
                continue
            candidate = (document.parent / target).resolve()
            if not candidate.exists():
                candidate = (WORKFLOWS / target).resolve()
            try:
                candidate.relative_to(WORKFLOWS)
            except ValueError:
                fail(f"link escapes workflows: {document.relative_to(WORKFLOWS)} -> {raw}")
            if not candidate.exists():
                fail(f"broken link: {document.relative_to(WORKFLOWS)} -> {raw}")
            count += 1
    return count


def validate_public_boundary() -> int:
    private_identity = _joined(r"(?i)\b(?:chi", r"pflow|amp", r"copilot)\b")
    specialized_domain = _joined(
        r"(?i)\b(?:cad", r"ence|spec", r"tre|virt", r"uoso|ts", r"mc[0-9a-z+_-]*|gp",
        r"dk[0-9a-z_-]*|p", r"dk|net", r"list|semi", r"conductor|integrated cir", r"cuit)\b",
    )
    private_infrastructure = _joined(
        r"(?i)(?:chi", r"pflow-srv|chi", r"pflowai[.]com|/s", r"rv/|/ho",
        r"me/|/o", r"pt/|/ro", r"ot/|[A-Z]:\\[A-Za-z0-9_.-]+\\|ssh",
        r"pass\s+-p|proxy", r"jump)",
    )
    known_token_prefix = _joined(
        r"\b(?:gh", r"p_|github_", r"pat_|s", r"k-[A-Za-z0-9])"
    )
    banned = {
        "private product identity": re.compile(private_identity),
        "specialized design domain": re.compile(specialized_domain),
        "private infrastructure": re.compile(private_infrastructure),
        "ipv4 address": re.compile(r"(?<![0-9])(?:[0-9]{1,3}[.]){3}[0-9]{1,3}(?![0-9])"),
        "email address": re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
        "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
        "credential-like assignment": re.compile(
            r"(?i)\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\b\s*[:=]\s*['\"]?[A-Za-z0-9_+/=.-]{8,}"
        ),
        "known token prefix": re.compile(known_token_prefix),
    }
    checked = 0
    for path in sorted(WORKFLOWS.rglob("*")):
        if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
            continue
        data = path.read_bytes()
        if len(data) > 512 * 1024:
            fail(f"unexpected large public workflow file: {path.relative_to(WORKFLOWS)}")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            fail(f"non-UTF-8 public workflow file: {path.relative_to(WORKFLOWS)}")
        for label, pattern in banned.items():
            match = pattern.search(text)
            if match:
                line = text.count("\n", 0, match.start()) + 1
                fail(f"{label} in {path.relative_to(WORKFLOWS)}:{line}")
        checked += 1
    for name in ("run-state.json", "guardian-history.jsonl", "guardian.log"):
        if (WORKFLOWS / name).exists():
            fail(f"live runtime state was copied into public workflows: {name}")
    return checked


def run(
    command: list[str],
    env: dict[str, str],
    expected: int = 0,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        check=False,
    )
    if result.returncode != expected:
        fail(
            f"command returned {result.returncode}, expected {expected}: "
            f"{' '.join(command)}"
        )
    return result


def runtime_environment(project: Path, state_path: Path | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(
        {
            "AWP_PROJECT_DIR": str(project),
            "AWP_WORKFLOW_HOME": str(WORKFLOWS),
            "AWP_RUN_STATE": str(state_path or project / "state" / "run-state.json"),
            "AWP_MODES_DIR": str(WORKFLOWS / "modes"),
            "AWP_STATUS_FILE": str(project / "STATUS.md"),
            "AWP_GUARDIAN_LOG": str(project / "guardian.log"),
            "AWP_GUARDIAN_HISTORY": str(project / "guardian-history.jsonl"),
            "AWP_GUARDIAN_STALL_TIMEOUT": "60",
            "AWP_STATE_LOCK_TIMEOUT": "20",
        }
    )
    return env


def validate_resume_smoke(scheduler: Path, guardian: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="awp-resume-") as raw:
        project = Path(raw)
        state_path = project / "state" / "run-state.json"
        state_path.parent.mkdir(parents=True)
        state = load_json(WORKFLOWS / "examples" / "run-state.synthetic.json")
        current = datetime.now(timezone.utc)
        state["session"]["started_at"] = (current - timedelta(minutes=5)).isoformat()
        state["session"]["last_heartbeat"] = current.isoformat()
        state_path.write_text(json.dumps(state), encoding="utf-8")
        (project / "STATUS.md").write_text(
            "# Current\n\nIn progress: synthetic validation\n", encoding="utf-8"
        )
        env = runtime_environment(project, state_path)
        python = sys.executable
        run([python, str(scheduler), "add", "Synthetic validation task", "2"], env)
        run([python, str(scheduler), "heartbeat"], env)
        run([python, str(scheduler), "checkpoint", "Resume synthetic validation"], env)
        resumed = run([python, str(guardian), "resume"], env)
        if "Resume synthetic validation" not in resumed.stdout:
            fail("guardian resume omitted the durable checkpoint")
        selected = run([python, str(scheduler), "next", "daily"], env)
        if '"action": "execute_batch"' not in selected.stdout:
            fail("scheduler did not produce an executable batch")
        run([python, str(scheduler), "complete", "T-003"], env)
        run([python, str(guardian), "check"], env)

        stale = json.loads(state_path.read_text(encoding="utf-8"))
        stale["session"]["status"] = "active"
        stale["session"]["last_heartbeat"] = (current - timedelta(minutes=10)).isoformat()
        state_path.write_text(json.dumps(stale), encoding="utf-8")
        run([python, str(guardian), "check"], env, expected=2)
        history = project / "guardian-history.jsonl"
        if len(history.read_text(encoding="utf-8").splitlines()) != 2:
            fail("guardian did not emit exactly two smoke-test events")
        require_schema(
            json.loads(state_path.read_text(encoding="utf-8")),
            "run-state",
            "resume smoke run-state",
        )


def validate_fresh_state(scheduler: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="awp-fresh-") as raw:
        project = Path(raw)
        state_path = project / "state" / "run-state.json"
        env = runtime_environment(project, state_path)
        run([sys.executable, str(scheduler), "add", "Fresh synthetic task", "2"], env)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        require_schema(state, "run-state", "fresh scheduler state")


def validate_transient_replace_retry(scheduler: Path) -> None:
    """Prove a transient Windows sharing error does not abandon an atomic write."""
    namespace = runpy.run_path(str(scheduler))
    replace_run_state = namespace["_replace_run_state"]
    real_replace = os.replace
    attempts = 0

    def flaky_replace(source, destination):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            error = PermissionError(13, "synthetic sharing violation")
            error.winerror = 5
            raise error
        real_replace(source, destination)

    with tempfile.TemporaryDirectory(prefix="awp-replace-") as raw:
        source = Path(raw) / "state.tmp"
        destination = Path(raw) / "state.json"
        source.write_text('{"synthetic": true}', encoding="utf-8")
        os.replace = flaky_replace
        try:
            replace_run_state(source, destination)
        finally:
            os.replace = real_replace
        if attempts != 3 or not destination.exists() or source.exists():
            fail("transient atomic-replace retry did not preserve the write")


def validate_concurrent_adds(scheduler: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="awp-concurrent-") as raw:
        project = Path(raw)
        state_path = project / "state" / "run-state.json"
        env = runtime_environment(project, state_path)
        processes = [
            subprocess.Popen(
                [
                    sys.executable,
                    str(scheduler),
                    "add",
                    f"Concurrent synthetic task {index}",
                    "2",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="strict",
            )
            for index in range(24)
        ]
        results = []
        for process in processes:
            try:
                results.append((*process.communicate(timeout=30), process.returncode))
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                fail("concurrent scheduler add timed out")
        nonzero = sum(returncode != 0 for _stdout, _stderr, returncode in results)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        backlog = state.get("backlog", [])
        ids = [task.get("id") for task in backlog]
        if nonzero or len(backlog) != 24 or len(set(ids)) != 24:
            fail(
                "concurrent add lost or duplicated mutations: "
                f"expected=24 recorded={len(backlog)} nonzero={nonzero}"
            )
        require_schema(state, "run-state", "concurrent scheduler state")


def validate_atomic_batch_start(scheduler: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="awp-batch-") as raw:
        project = Path(raw)
        state_path = project / "state" / "run-state.json"
        env = runtime_environment(project, state_path)
        for index in range(2):
            run(
                [sys.executable, str(scheduler), "add", f"Batch synthetic task {index}", "2"],
                env,
            )
        preview = run([sys.executable, str(scheduler), "next", "parallel"], env)
        if '"action": "execute_batch"' not in preview.stdout:
            fail("parallel preview did not return an executable batch")
        started = run(
            [sys.executable, str(scheduler), "batch", "start", "parallel"], env
        )
        try:
            output = json.loads(started.stdout)
        except json.JSONDecodeError:
            fail("batch start did not return structured output")
        state = json.loads(state_path.read_text(encoding="utf-8"))
        batch = state.get("batches", [])[-1]
        task_ids = batch.get("task_ids", [])
        claimed = [task for task in state.get("backlog", []) if task.get("id") in task_ids]
        if output.get("task_count") != 2 or len(task_ids) != 2:
            fail("atomic batch start claimed the wrong task count")
        if any(task.get("status") != "in_progress" for task in claimed):
            fail("atomic batch start did not transition tasks to in_progress")
        if any(task.get("batch_id") != batch.get("id") for task in claimed):
            fail("claimed tasks were not bound to the created batch")
        run(
            [sys.executable, str(scheduler), "batch", "start", "parallel"],
            env,
            expected=1,
        )
        require_schema(state, "run-state", "atomic batch scheduler state")


def validate_runtime_regressions() -> None:
    scheduler = WORKFLOWS / "runtime" / "scheduler.py"
    guardian = WORKFLOWS / "runtime" / "guardian.py"
    with tempfile.TemporaryDirectory(prefix="awp-compile-") as raw:
        project = Path(raw)
        py_compile.compile(str(scheduler), cfile=str(project / "scheduler.pyc"), doraise=True)
        py_compile.compile(str(guardian), cfile=str(project / "guardian.pyc"), doraise=True)
    validate_resume_smoke(scheduler, guardian)
    validate_fresh_state(scheduler)
    validate_transient_replace_retry(scheduler)
    validate_concurrent_adds(scheduler)
    validate_atomic_batch_start(scheduler)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--links-only", action="store_true")
    args = parser.parse_args()
    try:
        links = validate_links()
        if args.links_only:
            print(f"OK: {links} local Markdown links")
            return 0
        json_values = validate_json_files()
        schemas = validate_json_schemas()
        validate_run_state()
        validate_guardian_history()
        recipes = validate_recipes()
        files = validate_public_boundary()
        validate_runtime_regressions()
    except ValidationError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    print(
        f"OK: {files} public files, {json_values} JSON values, {schemas} schema checks, "
        f"{links} local links, {recipes} recipes, runtime regressions passed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())