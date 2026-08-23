#!/usr/bin/env python3
"""Exercise bounded backlog delivery against the real local Compose stack."""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
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


def positive_count(raw: str) -> int:
    value = int(raw)
    if not 1 <= value <= 1000:
        raise argparse.ArgumentTypeError("count must be between 1 and 1000")
    return value


def positive_timeout(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value) or not 1 <= value <= 3600:
        raise argparse.ArgumentTypeError("timeout must be between 1 and 3600 seconds")
    return value


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


def main(cli_args: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8100")
    parser.add_argument("--count", type=positive_count, default=10)
    parser.add_argument("--timeout", type=positive_timeout, default=120.0)
    args = parser.parse_args(cli_args)

    try:
        base = canonical_local_base(args.url)
        api_key = load_api_key()
    except Exception as exc:
        print(f"FAILED: local stack unavailable ({type(exc).__name__})", file=sys.stderr)
        return 2

    started = time.monotonic()
    submitted_at: dict[str, float] = {}
    terminal_at: dict[str, float] = {}
    try:
        run_id = uuid4().hex
        for index in range(args.count):
            created = request_json(
                "POST",
                base,
                "/v1/tasks",
                api_key,
                {
                    "task_type": "command",
                    "idempotency_key": f"lifecycle-{run_id}-{index}",
                    "payload": {
                        "argv": [
                            "python3" if os.name != "nt" else "python",
                            "-c",
                            f"print('lifecycle-{index}')",
                        ]
                    },
                },
            )
            task_id = str(UUID(str(created["id"])))
            submitted_at[task_id] = time.monotonic()

        deadline = started + args.timeout
        pending = set(submitted_at)
        failures: dict[str, str] = {}
        while pending and time.monotonic() < deadline:
            for task_id in list(pending):
                task = request_json("GET", base, f"/v1/tasks/{task_id}", api_key)
                status = str(task.get("status") or "unknown")
                if status in TERMINAL:
                    terminal_at[task_id] = time.monotonic()
                    pending.remove(task_id)
                    if status != "success":
                        failures[task_id] = status
            if pending:
                time.sleep(0.1)
    except Exception as exc:
        print(f"FAILED: lifecycle verification raised {type(exc).__name__}", file=sys.stderr)
        return 1

    if pending or failures:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "submitted": args.count,
                    "non_terminal": len(pending),
                    "failed": len(failures),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1

    latencies = [terminal_at[item] - submitted_at[item] for item in submitted_at]
    elapsed = time.monotonic() - started
    report = {
        "status": "success",
        "submitted": args.count,
        "completed": len(terminal_at),
        "elapsed_seconds": round(elapsed, 3),
        "throughput_tasks_per_second": round(args.count / elapsed, 3),
        "latency_seconds": {
            "min": round(min(latencies), 3),
            "median": round(statistics.median(latencies), 3),
            "p95": round(percentile(latencies, 0.95), 3),
            "max": round(max(latencies), 3),
        },
    }
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
