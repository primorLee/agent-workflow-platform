#!/usr/bin/env python3
"""Agent Workflow Platform session guardian.

Production-derived behavior:
- one-shot or continuous heartbeat checks;
- three consecutive failures before declaring a stopped session;
- alert cooldown to avoid notification storms;
- structured JSONL evidence;
- recovery instructions built from checkpoint, backlog, git, and STATUS.md.

No notification provider or endpoint is bundled. Pipe stdout/JSONL into the
notification system you already operate.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKFLOW_HOME = Path(
    os.environ.get("AWP_WORKFLOW_HOME", Path(__file__).resolve().parent.parent)
).resolve()
PROJECT_ROOT = Path(os.environ.get("AWP_PROJECT_DIR", WORKFLOW_HOME.parent)).resolve()
STATE_FILE = Path(
    os.environ.get("AWP_RUN_STATE", PROJECT_ROOT / ".agent-workflow" / "run-state.json")
).resolve()
LOG_FILE = Path(
    os.environ.get("AWP_GUARDIAN_LOG", PROJECT_ROOT / ".agent-workflow" / "guardian.log")
).resolve()
HISTORY_FILE = Path(
    os.environ.get(
        "AWP_GUARDIAN_HISTORY",
        PROJECT_ROOT / ".agent-workflow" / "guardian-history.jsonl",
    )
).resolve()
STATUS_FILE = Path(
    os.environ.get("AWP_STATUS_FILE", PROJECT_ROOT / "STATUS.md")
).resolve()
CHECK_INTERVAL = int(os.environ.get("AWP_GUARDIAN_CHECK_INTERVAL", "300"))
STALL_TIMEOUT = int(os.environ.get("AWP_GUARDIAN_STALL_TIMEOUT", "2700"))
ALERT_COOLDOWN = int(os.environ.get("AWP_GUARDIAN_ALERT_COOLDOWN", "1800"))

_shutdown_requested = False


def now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp() -> str:
    return now().isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def on_signal(signum: int, _frame: Any) -> None:
    global _shutdown_requested
    _shutdown_requested = True
    name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
    log(f"received {name}; shutting down gracefully")


def log(message: str) -> None:
    line = f"[{timestamp()}] {message}"
    print(line, flush=True)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def log_event(event: str, payload: dict[str, Any]) -> None:
    entry = {"timestamp": timestamp(), "event": event, **payload}
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        with HISTORY_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def load_state() -> dict[str, Any]:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def check_session_health() -> tuple[bool, str, float | None]:
    """Return (healthy, reason, heartbeat_age_seconds)."""
    session = load_state().get("session", {})
    status = session.get("status", "idle")
    if status in {"idle", "ended", "completed"}:
        return True, f"session is {status}", None

    heartbeat = session.get("last_heartbeat")
    if not heartbeat:
        return False, "active session has no heartbeat", None

    try:
        age = max(0.0, (now() - parse_timestamp(str(heartbeat))).total_seconds())
    except (TypeError, ValueError):
        return False, "heartbeat timestamp is invalid", None

    if age > STALL_TIMEOUT:
        return False, f"heartbeat is stale by {int(age)} seconds", age
    if age > STALL_TIMEOUT * 0.7:
        return True, f"heartbeat is approaching the stall threshold ({int(age)} seconds)", age
    return True, f"heartbeat is fresh ({int(age)} seconds)", age


def run_git(*args: str) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def status_summary() -> str:
    try:
        lines = STATUS_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    selected: list[str] = []
    capture = False
    for line in lines:
        lower = line.lower()
        if "in progress" in lower or "current" in lower:
            capture = True
        elif capture and line.startswith("#"):
            break
        if capture:
            selected.append(line)
            if len(selected) >= 10:
                break
    return "\n".join(selected).strip()


def generate_resume_instruction() -> str:
    state = load_state()
    checkpoint = state.get("checkpoint") or {}
    task = state.get("current_task") or {}
    session = state.get("session") or {}
    backlog = state.get("backlog") or []
    parts: list[str] = []

    if checkpoint.get("resumable"):
        parts.append(
            "[checkpoint] "
            + str(checkpoint.get("resume_instruction") or "continue the interrupted task")
        )
    else:
        if session.get("mode"):
            parts.append(f"previous mode: {session['mode']}")
        if task.get("description"):
            parts.append(f"previous task: {task['description']}")
            completed = set(task.get("completed_subtasks") or [])
            remaining = [x for x in task.get("subtasks") or [] if x not in completed]
            if remaining:
                parts.append("remaining subtasks: " + ", ".join(map(str, remaining[:5])))

    pending = [item for item in backlog if item.get("status") not in {"done", "completed"}]
    if pending:
        parts.append(f"pending backlog: {len(pending)} item(s)")
        for item in sorted(pending, key=lambda x: x.get("priority", 5))[:3]:
            parts.append(
                f"- [{item.get('id', '?')}] P{item.get('priority', 5)} "
                f"{item.get('description', 'no description')}"
            )

    recent = run_git("log", "--oneline", "-5")
    if recent:
        parts.append("recent commits:\n" + recent)
    changed = run_git("status", "--short")
    if changed:
        parts.append(f"working tree: {len(changed.splitlines())} changed file(s)")
    current = status_summary()
    if current:
        parts.append("status context:\n" + current)
    return "\n".join(parts) if parts else "no resumable state; inspect project status"


def check_once() -> bool:
    healthy, message, age = check_session_health()
    state = load_state()
    session = state.get("session") or {}
    log(("OK " if healthy else "WARN ") + message)
    log_event(
        "health_check",
        {
            "healthy": healthy,
            "message": message,
            "heartbeat_age_seconds": round(age, 3) if age is not None else None,
            "session_status": session.get("status", "idle"),
            "session_mode": session.get("mode"),
            "backlog_pending": len(
                [x for x in state.get("backlog") or [] if x.get("status") != "done"]
            ),
        },
    )
    if not healthy:
        print("\nRecovery instruction:\n" + generate_resume_instruction())
    return healthy


def watch() -> None:
    global _shutdown_requested
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, on_signal)

    failures = 0
    last_alert = 0.0
    log(f"guardian started; interval={CHECK_INTERVAL}s timeout={STALL_TIMEOUT}s")
    while not _shutdown_requested:
        try:
            healthy = check_once()
            failures = 0 if healthy else failures + 1
            current = time.monotonic()
            if failures >= 3 and current - last_alert >= ALERT_COOLDOWN:
                log(f"ALERT session failed {failures} consecutive checks")
                log_event("stalled_session", {"consecutive_failures": failures})
                last_alert = current
        except Exception as exc:  # guardian must survive its own observation errors
            log(f"check raised {type(exc).__name__}: {exc}")
            log_event("guardian_error", {"error_type": type(exc).__name__})

        deadline = time.monotonic() + CHECK_INTERVAL
        while not _shutdown_requested and time.monotonic() < deadline:
            time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))

    log("guardian stopped")
    log_event("shutdown", {"reason": "signal", "consecutive_failures": failures})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "watch", "resume"))
    args = parser.parse_args()
    if args.command == "check":
        return 0 if check_once() else 2
    if args.command == "watch":
        watch()
        return 0
    print(generate_resume_instruction())
    return 0


if __name__ == "__main__":
    sys.exit(main())