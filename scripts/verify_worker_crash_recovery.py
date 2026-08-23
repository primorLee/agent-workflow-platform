#!/usr/bin/env python3
"""Kill a busy local worker and prove that its fenced task is safely retried."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from submit_local_task import (  # noqa: E402
    TERMINAL,
    canonical_local_base,
    load_api_key,
    request_json,
)

COMPOSE_FILE = ROOT / "deploy" / "local" / "docker-compose.local-dev.yml"


def positive_timeout(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value) or not 30 <= value <= 3600:
        raise argparse.ArgumentTypeError("timeout must be between 30 and 3600 seconds")
    return value


def compose(*args: str, timeout: float = 30) -> None:
    result = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE_FILE), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"docker compose {args[0]} failed")


def wait_for_state(
    base: str,
    api_key: str,
    task_id: str,
    expected: set[str],
    deadline: float,
) -> dict:
    last: dict = {}
    while time.monotonic() < deadline:
        last = request_json("GET", base, f"/v1/tasks/{task_id}", api_key)
        if str(last.get("status")) in expected:
            return last
        time.sleep(0.2)
    raise TimeoutError(
        f"task did not reach {sorted(expected)}; last status={last.get('status', 'unknown')}"
    )


def main(cli_args: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8100")
    parser.add_argument("--timeout", type=positive_timeout, default=120.0)
    args = parser.parse_args(cli_args)

    worker_stopped = False
    try:
        base = canonical_local_base(args.url)
        api_key = load_api_key()
        marker = f"crash-recovered-{uuid4().hex}"
        created = request_json(
            "POST",
            base,
            "/v1/tasks",
            api_key,
            {
                "task_type": "command",
                "idempotency_key": marker,
                "payload": {
                    "argv": [
                        "python3",
                        "-c",
                        f"import time; time.sleep(15); print('{marker}')",
                    ]
                },
            },
        )
        task_id = str(UUID(str(created["id"])))
        started = time.monotonic()
        running = wait_for_state(
            base,
            api_key,
            task_id,
            {"running"},
            started + min(30, args.timeout / 3),
        )
        first_attempt = str(running.get("attempt_id") or "")
        if not first_attempt:
            raise ValueError("running task has no fenced attempt")

        # A zero-second manual stop suppresses restart policy and forces the
        # worker process away before its 15-second command can complete.
        compose("stop", "--timeout", "0", "worker-agent")
        worker_stopped = True
        requeued = wait_for_state(
            base,
            api_key,
            task_id,
            {"pending", "failed"},
            started + min(60, args.timeout / 2),
        )
        if requeued.get("status") != "pending" or int(requeued.get("retry_count") or 0) < 1:
            raise RuntimeError("expired worker claim was not requeued")

        compose("up", "-d", "worker-agent", timeout=60)
        worker_stopped = False
        finished = wait_for_state(
            base,
            api_key,
            task_id,
            TERMINAL,
            started + args.timeout,
        )
        result = finished.get("result") or {}
        output = result.get("output") or {}
        if finished.get("status") != "success" or marker not in str(output.get("stdout") or ""):
            raise RuntimeError("retried task did not complete successfully")
        if str(finished.get("attempt_id") or "") == first_attempt:
            raise RuntimeError("retried task reused a stale attempt fence")

        print(
            json.dumps(
                {
                    "status": "success",
                    "task_id": task_id,
                    "worker_was_killed": True,
                    "lease_requeued": True,
                    "attempt_was_fenced": True,
                    "retry_count": int(finished.get("retry_count") or 0),
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                },
                sort_keys=True,
            )
        )
        return 0
    except Exception as exc:
        print(f"FAILED: worker crash recovery raised {type(exc).__name__}", file=sys.stderr)
        return 1
    finally:
        if worker_stopped:
            try:
                compose("up", "-d", "worker-agent", timeout=60)
            except Exception:
                print("WARNING: worker could not be restarted", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
