#!/usr/bin/env python3
"""Cross-platform validation entry point for Agent Workflow Platform.

The runner never installs dependencies and never contacts a hosted service.
Install each component's checked-in lockfile/requirements first, then select the
component to verify. With no arguments it performs the offline static gate.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable, Sequence

try:
    import yaml
except ImportError:  # reported by validate_yaml rather than at import time
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {
    ".git",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "test-results",
    "playwright-report",
    "__pycache__",
    ".pytest_cache",
    ".expo",
}
COMPONENTS = (
    "static",
    "workflows",
    "control-plane",
    "worker-agent",
    "vm-agent",
    "desktop",
    "admin",
    "mobile",
    "operations",
)
NPM_COMPONENTS = {
    "desktop": {
        "path": ROOT / "apps" / "desktop",
        "scripts": (
            "lint",
            "type-check",
            "build-only",
            "build:electron-main",

            "build:awp-cloud-mcp",
            "test",
        ),
    },
    "admin": {
        "path": ROOT / "apps" / "admin",
        "scripts": ("verify",),
    },
    "mobile": {
        "path": ROOT / "apps" / "mobile",
        "scripts": ("typecheck",),
    },
}
REQUIRED_MANIFEST_SCRIPTS = {
    "desktop": {
        "dev", "dev:web", "lint", "type-check", "test", "build-only", "verify",
        "build:electron-main", "build:awp-cloud-mcp", "agent:electron",
        "openai-compatible:electron", "test:agent-launcher", "test:reference-provider",
    },
    "admin": {"dev", "typecheck", "test", "build", "preview", "verify"},
    "mobile": {"start", "android", "ios", "web", "typecheck"},
}
GITHUB_HOSTED_RUNNERS = {"ubuntu-latest", "windows-latest", "macos-latest"}
PINNED_ACTION_REFERENCE = re.compile(r"^[^@\s]+@[0-9a-fA-F]{40}$")
VM_AGENT_GO_VERSION = "1.25.13"
TEXT_EXTENSIONS = {
    ".bat", ".cfg", ".cjs", ".css", ".env", ".example", ".go", ".html", ".js",
    ".json", ".jsonl", ".md", ".mjs", ".mod", ".ps1", ".py", ".service",
    ".sh", ".socket", ".sum", ".svg", ".target", ".timer", ".toml", ".ts",
    ".tsx", ".txt", ".vue", ".yaml", ".yml",
}
TEXT_NAMES = {"Dockerfile", "Makefile", ".gitattributes", ".gitignore"}
MOJIBAKE_MARKERS = tuple(chr(code) for code in (0xFFFD, 0x9225, 0x951B, 0x9983))


class ValidationError(RuntimeError):
    pass


def relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def is_skipped(path: Path) -> bool:
    try:
        parts = path.relative_to(ROOT).parts
    except ValueError:
        parts = path.parts
    return any(
        part in SKIP_PARTS or part.startswith(("dist-", "build-"))
        for part in parts
    )


def iter_files(base: Path, predicate) -> Iterable[Path]:
    if not base.exists():
        raise ValidationError(f"missing path: {relative(base)}")
    for path in sorted(base.rglob("*")):
        if path.is_file() and not is_skipped(path) and predicate(path):
            yield path


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise ValidationError(f"cannot read UTF-8 file {relative(path)}: {exc}") from exc


def is_shell_script(path: Path) -> bool:
    if path.suffix.lower() == ".sh" or path.name == "APKBUILD":
        return True
    try:
        first_line = read_text(path).splitlines()[0]
    except (ValidationError, IndexError):
        return False
    return bool(
        first_line.startswith("#!")
        and re.search(r"(?:^|[/\s])(?:ba|da|a|k|z)?sh(?:\s|$)|openrc-run", first_line)
    )


def load_json(path: Path):
    try:
        return json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise ValidationError(
            f"invalid JSON {relative(path)}:{exc.lineno}:{exc.colno}: {exc.msg}"
        ) from exc


def load_yaml(path: Path):
    if yaml is None:
        raise ValidationError(
            "PyYAML is required for the static gate; install requirements-validation.txt"
        )
    try:
        return yaml.safe_load(read_text(path))
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        suffix = f":{mark.line + 1}:{mark.column + 1}" if mark else ""
        raise ValidationError(f"invalid YAML {relative(path)}{suffix}") from exc


def validate_manifests() -> int:
    count = 0
    for component, spec in NPM_COMPONENTS.items():
        directory = spec["path"]
        manifest_path = directory / "package.json"
        lock_path = directory / "package-lock.json"
        manifest = load_json(manifest_path)
        if not lock_path.is_file():
            raise ValidationError(f"missing npm lockfile: {relative(lock_path)}")
        scripts = manifest.get("scripts")
        if not isinstance(scripts, dict):
            raise ValidationError(f"package scripts missing: {relative(manifest_path)}")
        missing = REQUIRED_MANIFEST_SCRIPTS[component] - set(scripts)
        if missing:
            raise ValidationError(
                f"{component} package scripts missing: {', '.join(sorted(missing))}"
            )
        count += 2

    go_mod = ROOT / "services" / "vm-agent" / "go.mod"
    go_sum = ROOT / "services" / "vm-agent" / "go.sum"
    go_text = read_text(go_mod)
    if "module github.com/primorLee/agent-workflow-platform/services/vm-agent" not in go_text:
        raise ValidationError("vm-agent module path is not the public repository path")
    go_directives = re.findall(r"(?m)^go\s+(\d+\.\d+(?:\.\d+)?)$", go_text)
    if go_directives != [VM_AGENT_GO_VERSION]:
        raise ValidationError(
            f"vm-agent go directive must be exactly {VM_AGENT_GO_VERSION}"
        )
    if re.search(r"(?m)^toolchain\s+", go_text):
        raise ValidationError(
            "vm-agent go.mod must omit a redundant toolchain directive"
        )
    if not go_sum.is_file():
        raise ValidationError("vm-agent go.sum is missing")
    count += 2

    for service in ("control-plane", "worker-agent"):
        directory = ROOT / "services" / service
        for name in ("requirements.txt", "README.md"):
            path = directory / name
            if not path.is_file():
                raise ValidationError(f"missing service file: {relative(path)}")
            count += 1
    return count


def validate_data_files() -> tuple[int, int]:
    # TypeScript config files are JSONC and are parsed by the component
    # typecheck. Every other checked-in .json file must be strict JSON.
    json_paths = set(
        iter_files(
            ROOT,
            lambda path: path.suffix.lower() == ".json"
            and not path.name.lower().startswith("tsconfig"),
        )
    )
    for path in sorted(json_paths):
        load_json(path)

    yaml_paths = list(
        iter_files(
            ROOT,
            lambda path: path.name.lower().endswith(
                (".yaml", ".yml", ".yaml.example", ".yml.example")
            ),
        )
    )
    for path in yaml_paths:
        load_yaml(path)
    return len(json_paths), len(yaml_paths)


def validate_python_syntax() -> int:
    count = 0
    for path in iter_files(ROOT, lambda item: item.suffix == ".py"):
        try:
            compile(read_text(path), str(path), "exec")
        except SyntaxError as exc:
            raise ValidationError(
                f"invalid Python {relative(path)}:{exc.lineno}:{exc.offset}"
            ) from exc
        count += 1
    return count


def validate_text_integrity() -> int:
    count = 0
    for path in iter_files(
        ROOT,
        lambda item: item.suffix.lower() in TEXT_EXTENSIONS or item.name in TEXT_NAMES,
    ):
        text = read_text(path)
        for marker in MOJIBAKE_MARKERS:
            if marker in text or marker in path.name:
                raise ValidationError(f"mojibake marker in {relative(path)}")
        count += 1
    return count


def validate_markdown_links() -> int:
    required = (ROOT / "README.md", ROOT / "README.zh-CN.md", ROOT / "PROVENANCE.md")
    for document in required:
        if not document.is_file():
            raise ValidationError(f"missing documentation: {relative(document)}")
    documents = list(iter_files(ROOT, lambda path: path.suffix.lower() == ".md"))
    link_pattern = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
    count = 0
    for document in documents:
        for raw_target in link_pattern.findall(read_text(document)):
            target = raw_target.strip().split("#", 1)[0]
            if not target or "://" in target or target.startswith(("mailto:", "#")):
                continue
            candidate = (document.parent / target).resolve()
            try:
                candidate.relative_to(ROOT)
            except ValueError as exc:
                raise ValidationError(
                    f"documentation link escapes repository: {relative(document)} -> {raw_target}"
                ) from exc
            if not candidate.exists():
                raise ValidationError(
                    f"broken documentation link: {relative(document)} -> {raw_target}"
                )
            count += 1
    return count


def validate_env_example() -> int:
    path = ROOT / ".env.example"
    text = read_text(path)
    url_pattern = re.compile(r"(?i)\b(?:https?|wss?)://([^/:\s]+)")
    hosts = url_pattern.findall(text)
    invalid_hosts = [host for host in hosts if host not in {"127.0.0.1", "localhost", "[::1]"}]
    if invalid_hosts:
        raise ValidationError(".env.example contains a non-localhost URL")

    generated_roots: set[str] = set()
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ValidationError(f"invalid .env.example assignment at line {number}")
        key, value = stripped.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValidationError(f"invalid .env.example key at line {number}")
        if value.startswith("./"):
            generated_roots.add(value[2:].split("/", 1)[0] + "/")

    ignore_lines = {
        line.strip()
        for line in read_text(ROOT / ".gitignore").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    required_ignores = generated_roots | {"services/worker-agent/agent.yaml"}
    missing = required_ignores - ignore_lines
    if missing:
        raise ValidationError(
            ".env.example output or generated worker config is not ignored: "
            + ", ".join(sorted(missing))
        )
    return len(hosts)


def _runner_values(job: dict) -> set[str]:
    runs_on = job.get("runs-on")
    if isinstance(runs_on, str) and runs_on in GITHUB_HOSTED_RUNNERS:
        return {runs_on}
    if runs_on == "${{ matrix.os }}":
        matrix = (job.get("strategy") or {}).get("matrix") or {}
        values = matrix.get("os") or []
        if isinstance(values, list) and values:
            return {str(value) for value in values}
    return set()


def validate_ci_policy() -> int:
    workflow_dir = ROOT / ".github" / "workflows"
    workflows = list(iter_files(workflow_dir, lambda path: path.suffix.lower() in {".yml", ".yaml"}))
    if not workflows:
        raise ValidationError("no root GitHub Actions workflow found")
    checked_jobs = 0
    for path in workflows:
        raw = read_text(path)
        if re.search(r"\$\{\{\s*secrets\.", raw, re.IGNORECASE):
            raise ValidationError(f"CI references repository secrets: {relative(path)}")
        if re.search(r"(?i)\bself-hosted\b", raw):
            raise ValidationError(f"CI references a self-hosted runner: {relative(path)}")
        if re.search(r"(?i)uses:\s*actions/cache@", raw):
            raise ValidationError(
                f"CI uses an unrestricted cache action; use setup-* lockfile caches: {relative(path)}"
            )
        document = load_yaml(path)
        if not isinstance(document, dict) or not isinstance(document.get("jobs"), dict):
            raise ValidationError(f"CI workflow has no jobs mapping: {relative(path)}")
        permissions = document.get("permissions")
        if permissions != {"contents": "read"}:
            raise ValidationError(f"CI permissions must be exactly contents: read: {relative(path)}")
        for job_name, job in document["jobs"].items():
            if not isinstance(job, dict):
                raise ValidationError(f"CI job is not a mapping: {job_name}")
            runners = _runner_values(job)
            if not runners or not runners <= GITHUB_HOSTED_RUNNERS:
                raise ValidationError(f"CI job is not GitHub-hosted-only: {job_name}")
            if not isinstance(job.get("timeout-minutes"), int):
                raise ValidationError(f"CI job has no numeric timeout: {job_name}")
            steps = job.get("steps") or []
            if not isinstance(steps, list):
                raise ValidationError(f"CI job steps are not a list: {job_name}")
            for step in steps:
                if not isinstance(step, dict):
                    raise ValidationError(f"CI job step is not a mapping: {job_name}")
                reference = step.get("uses")
                if reference is None or str(reference).startswith("./"):
                    continue
                if not isinstance(reference, str) or not PINNED_ACTION_REFERENCE.fullmatch(reference):
                    raise ValidationError(
                        "CI action references must use an immutable 40-character commit SHA: "
                        f"{job_name}: {reference}"
                    )
            checked_jobs += 1
    return checked_jobs


def clean_environment() -> dict[str, str]:
    prefixes = ("AWP_", "VITE_AWP_", "EXPO_PUBLIC_AWP_")
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith(prefixes)
    }
    environment.update(
        {
            "AWP_ENV": "test",
            "AWP_DEV_API_KEY": "awp-local-dev-key",
            "AWP_WS_BROKER": "memory",

            "AWP_REDIS_URL": "",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "CI": "true",
            "NO_UPDATE_NOTIFIER": "1",
        }
    )
    return environment


def find_windows_git_bash() -> str | None:
    """Find Git Bash from the Git executable first, then standard installs."""
    candidates: list[Path] = []
    git = shutil.which("git")
    if git:
        git_path = Path(git).resolve()
        git_root = git_path.parent.parent
        candidates.extend(
            (
                git_root / "bin" / "bash.exe",
                git_root / "usr" / "bin" / "bash.exe",
            )
        )
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        value = os.environ.get(variable)
        if value:
            candidates.append(Path(value) / "Git" / "bin" / "bash.exe")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Programs" / "Git" / "bin" / "bash.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def resolve_command(command: Sequence[str]) -> list[str]:
    executable = command[0]
    if Path(executable).is_file():
        return list(command)
    resolved = shutil.which(executable)
    if not resolved and executable == "bash" and os.name == "nt":
        resolved = find_windows_git_bash()
    if not resolved:
        raise ValidationError(f"required executable not found: {executable}")
    return [resolved, *command[1:]]


def run(label: str, command: Sequence[str], cwd: Path, environment: dict[str, str] | None = None) -> None:
    resolved = resolve_command(command)
    print(f"RUN  {label} ({relative(cwd)})", flush=True)
    result = subprocess.run(
        resolved,
        cwd=cwd,
        env=environment or clean_environment(),
        check=False,
    )
    if result.returncode != 0:
        raise ValidationError(f"{label} failed with exit code {result.returncode}")
    print(f"PASS {label}", flush=True)


def validate_static(history: bool) -> None:
    manifests = validate_manifests()
    json_count, yaml_count = validate_data_files()
    python_count = validate_python_syntax()
    text_count = validate_text_integrity()
    links = validate_markdown_links()
    local_urls = validate_env_example()
    jobs = validate_ci_policy()
    run(
        "public boundary negative cases",
        [
            sys.executable,
            str(ROOT / "scripts" / "verify_public_boundary_fail_closed.py"),
        ],
        ROOT,
    )
    boundary_command = [sys.executable, str(ROOT / "scripts" / "check_public_boundary.py"), str(ROOT)]
    if history:
        boundary_command.append("--history")
    run("public boundary", boundary_command, ROOT)
    print(
        "PASS static: "
        f"{manifests} manifest inputs, {json_count} JSON, {yaml_count} YAML, "
        f"{python_count} Python files, {text_count} UTF-8 text files, "
        f"{links} local links, {local_urls} localhost URLs, {jobs} CI jobs",
        flush=True,
    )


def validate_component(component: str, history: bool) -> None:
    environment = clean_environment()
    if component == "static":
        validate_static(history)
    elif component == "workflows":
        run(
            "workflow pack",
            [sys.executable, "validation/validate_workflows.py"],
            ROOT / "workflows",
            environment,
        )
        run(
            "guardian hysteresis",
            [sys.executable, str(ROOT / "scripts" / "verify_guardian_hysteresis.py")],
            ROOT,
            environment,
        )
    elif component == "control-plane":
        run(
            "control-plane tests",
            [sys.executable, "-m", "pytest", "-q", "tests"],
            ROOT / "services" / "control-plane",
            environment,
        )
    elif component == "worker-agent":
        run(
            "worker-agent tests",
            [sys.executable, "-m", "pytest", "-q", "tests"],
            ROOT / "services" / "worker-agent",
            environment,
        )
    elif component == "vm-agent":
        directory = ROOT / "services" / "vm-agent"
        run("vm-agent tests", ["go", "test", "./..."], directory, environment)
        run(
            "vm-agent replay stress",
            ["go", "test", "-count=10", "./internal/replay"],
            directory,
            environment,
        )
        run("vm-agent vet", ["go", "vet", "./..."], directory, environment)
        with tempfile.TemporaryDirectory(prefix="awp-vm-agent-build-") as build_dir:
            suffix = ".exe" if os.name == "nt" else ""
            output = str(Path(build_dir) / f"awp-vm-agent{suffix}")
            run(
                "vm-agent build",
                ["go", "build", "-o", output, "./cmd/awp-vm-agent"],
                directory,
                environment,
            )
    elif component in NPM_COMPONENTS:
        spec = NPM_COMPONENTS[component]
        directory = spec["path"]
        for script in spec["scripts"]:
            run(f"{component} npm:{script}", ["npm", "run", script], directory, environment)
    elif component == "operations":
        run(
            "operations tests",
            [sys.executable, "-m", "pytest", "-q", "tests"],
            ROOT / "ops",
            environment,
        )
        roots = (ROOT / "deploy", ROOT / "ops", ROOT / "services" / "vm-agent")
        scripts: list[Path] = []
        for base in roots:
            for path in iter_files(base, is_shell_script):
                scripts.append(path)
        if not scripts:
            raise ValidationError("no operations shell scripts found")
        for path in scripts:
            run(f"shell syntax {relative(path)}", ["bash", "-n", str(path)], ROOT, environment)
        print(f"PASS operations: {len(scripts)} shell scripts", flush=True)
    else:  # argparse protects this branch
        raise ValidationError(f"unknown component: {component}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--component",
        action="append",
        choices=COMPONENTS,
        help="component to validate; may be repeated (default: static)",
    )
    parser.add_argument("--all", action="store_true", help="validate every component")
    parser.add_argument(
        "--history",
        action="store_true",
        help="with the static component, scan all reachable Git blobs",
    )
    args = parser.parse_args()
    selected = list(COMPONENTS) if args.all else (args.component or ["static"])
    selected = list(dict.fromkeys(selected))
    try:
        for component in selected:
            validate_component(component, args.history)
    except ValidationError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    print("All selected validations passed: " + ", ".join(selected))
    return 0


if __name__ == "__main__":
    sys.exit(main())
