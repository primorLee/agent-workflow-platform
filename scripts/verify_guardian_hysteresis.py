#!/usr/bin/env python3
"""Deterministic, no-sleep regression check for guardian hysteresis."""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
GUARDIAN = ROOT / "workflows" / "runtime" / "guardian.py"


def load_guardian(temp_dir: Path) -> ModuleType:
    safe_environment = {
        "AWP_PROJECT_DIR": str(temp_dir),
        "AWP_RUN_STATE": str(temp_dir / "run-state.json"),
        "AWP_GUARDIAN_LOG": str(temp_dir / "guardian.log"),
        "AWP_GUARDIAN_HISTORY": str(temp_dir / "guardian-history.jsonl"),
        "AWP_STATUS_FILE": str(temp_dir / "STATUS.md"),
    }
    os.environ.update(safe_environment)
    spec = importlib.util.spec_from_file_location("awp_guardian_hysteresis_check", GUARDIAN)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load guardian module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_watch(module: ModuleType, results: list[bool], stop_after: int) -> list[dict]:
    events: list[dict] = []
    calls = 0
    clock = 1_000.0

    def fake_check_once() -> bool:
        nonlocal calls
        value = results[min(calls, len(results) - 1)]
        calls += 1
        if calls >= stop_after:
            module._shutdown_requested = True
        return value

    def fake_monotonic() -> float:
        nonlocal clock
        clock += 1.0
        return clock

    module._shutdown_requested = False
    module.CHECK_INTERVAL = 0
    module.ALERT_COOLDOWN = 100
    module.check_once = fake_check_once
    module.log = lambda _message: None
    module.log_event = lambda event, payload: events.append({"event": event, **payload})
    module.signal.signal = lambda *_args, **_kwargs: None
    module.time.monotonic = fake_monotonic
    module.time.sleep = lambda _seconds: None
    module.watch()
    return events


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="awp-guardian-hysteresis-") as raw:
        guardian = load_guardian(Path(raw))

        cooldown_events = run_watch(guardian, [False], stop_after=4)
        alerts = [event for event in cooldown_events if event["event"] == "stalled_session"]
        if len(alerts) != 1 or alerts[0].get("consecutive_failures") != 3:
            print("FAILED: guardian did not alert once at the third consecutive failure", file=sys.stderr)
            return 1

        reset_events = run_watch(
            guardian,
            [False, False, True, False, False, False, False],
            stop_after=7,
        )
        alerts = [event for event in reset_events if event["event"] == "stalled_session"]
        if len(alerts) != 1 or alerts[0].get("consecutive_failures") != 3:
            print("FAILED: guardian failure counter did not reset after a healthy check", file=sys.stderr)
            return 1

    print("guardian hysteresis passed: threshold=3, cooldown suppresses repeats, health resets counter")
    return 0


if __name__ == "__main__":
    sys.exit(main())