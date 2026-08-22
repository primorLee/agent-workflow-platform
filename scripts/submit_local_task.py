#!/usr/bin/env python3
"""Submit one localhost command task and wait for its worker result."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

TERMINAL = {"success", "failed", "error", "cancelled"}
ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = ROOT / "deploy" / "local" / "docker-compose.local-dev.yml"
ALLOWED_BASES = {"http://127.0.0.1:8100", "http://localhost:8100"}
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Never forward the Authorization header to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            "redirects are disabled",
            headers,
            fp,
        )


def private_opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        RejectRedirects(),
    )


def canonical_local_base(raw: str) -> str:
    if raw != raw.strip() or raw.rstrip("/") not in ALLOWED_BASES:
        raise ValueError("only the documented localhost control plane is allowed")
    base = raw.rstrip("/")
    parsed = urlsplit(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("localhost base URL is not canonical")
    return base


def validate_api_key(raw: str) -> str:
    if not isinstance(raw, str) or len(raw.encode("utf-8")) < 16:
        raise ValueError("local API key is too short")
    if raw != raw.strip() or any(ch.isspace() or ord(ch) < 0x20 for ch in raw):
        raise ValueError("local API key is not canonical")
    return raw


def request_json(
    method: str,
    base: str,
    path: str,
    api_key: str,
    body: dict[str, Any] | None = None,
    *,
    opener=None,
):
    base = canonical_local_base(base)
    if not path.startswith("/v1/") or "//" in path or "?" in path or "#" in path:
        raise ValueError("request path is not canonical")
    api_key = validate_api_key(api_key)
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
    url = base + path
    request = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    transport = opener or private_opener()
    with transport.open(request, timeout=5) as response:
        if response.geturl() != url:
            raise RuntimeError("response origin changed")
        content_type = response.headers.get_content_type().lower()
        if content_type != "application/json":
            raise ValueError("response is not JSON")
        length_header = response.headers.get("Content-Length")
        if length_header is not None:
            try:
                announced = int(length_header)
            except ValueError:
                raise ValueError("response Content-Length is invalid") from None
            if announced < 0 or announced > MAX_RESPONSE_BYTES:
                raise ValueError("response is too large")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("response is too large")
    decoded = json.loads(raw.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("response JSON must be an object")
    return decoded


def discover_compose_key() -> str:
    """Read the generated local-demo key into memory without printing it."""
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(COMPOSE_FILE),
            "exec",
            "-T",
            "control-plane",
            "python",
            "-c",
            "from cloud.config import DEV_API_KEY; print(DEV_API_KEY)",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("the local Compose API key is unavailable")
    return validate_api_key(result.stdout.rstrip("\r\n"))


def load_api_key() -> str:
    configured = os.environ.get("AWP_DEV_API_KEY")
    if configured is not None:
        return validate_api_key(configured)
    return discover_compose_key()


def positive_timeout(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value) or not 0.1 <= value <= 3600:
        raise argparse.ArgumentTypeError("timeout must be between 0.1 and 3600 seconds")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8100")
    parser.add_argument("--timeout", type=positive_timeout, default=30.0)
    parser.add_argument("argv", nargs=argparse.REMAINDER, help="optional argv after --")
    return parser


def main(cli_args: list[str] | None = None) -> int:
    args = build_parser().parse_args(cli_args)
    try:
        base = canonical_local_base(args.url)
        api_key = load_api_key()
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError):
        print("FAILED: no valid local key or running Compose control plane", file=sys.stderr)
        return 2

    argv = list(args.argv)
    if argv[:1] == ["--"]:
        argv.pop(0)
    if not argv:
        executable = "python" if os.name == "nt" else "python3"
        argv = [executable, "-c", "print('hello from Agent Workflow Platform worker')"]

    try:
        created = request_json(
            "POST",
            base,
            "/v1/tasks",
            api_key,
            {"task_type": "command", "payload": {"argv": argv}},
        )
        task_id = str(UUID(str(created["id"])))
        if task_id != created["id"]:
            raise ValueError("task id is not canonical")
        print(f"submitted task {task_id}")
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            task = request_json("GET", base, f"/v1/tasks/{task_id}", api_key)
            status = str(task.get("status", "unknown"))
            if status in TERMINAL:
                print(f"task status: {status}")
                result = task.get("result") or {}
                output = result.get("output") or {}
                stdout = str(output.get("stdout") or "").rstrip()
                if stdout:
                    print("worker output:")
                    print(stdout)
                return 0 if status == "success" else 1
            time.sleep(0.5)
    except (
        KeyError,
        UnicodeDecodeError,
        ValueError,
        RuntimeError,
        urllib.error.URLError,
        json.JSONDecodeError,
    ) as exc:
        print(
            f"FAILED: local round trip could not complete ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 1

    print("FAILED: timed out waiting for the local worker", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())