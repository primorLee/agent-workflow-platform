#!/usr/bin/env python3
"""Stateful black-box health probe for Agent Workflow Platform."""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path

_STOP = False


@dataclass
class EndpointState:
    failures: int = 0
    alerting: bool = False
    last_status: int | None = None
    last_error: str | None = None
    last_latency_ms: float = 0.0


@dataclass(frozen=True)
class Config:
    base_url: str
    endpoints: tuple[str, ...]
    interval: float
    timeout: float
    threshold: int
    state_path: Path
    log_path: Path | None
    webhook_url: str | None


def load_config() -> Config:
    endpoints = tuple(
        item.strip()
        for item in os.getenv("AWP_PROBE_ENDPOINTS", "/v1/health/live,/v1/health/ready").split(",")
        if item.strip()
    )
    if not endpoints:
        raise ValueError("AWP_PROBE_ENDPOINTS must contain at least one path")
    return Config(
        base_url=os.getenv("AWP_PROBE_BASE_URL", "http://127.0.0.1:8100").rstrip("/"),
        endpoints=endpoints,
        interval=max(1.0, float(os.getenv("AWP_PROBE_INTERVAL_SECONDS", "30"))),
        timeout=max(0.1, float(os.getenv("AWP_PROBE_TIMEOUT_SECONDS", "5"))),
        threshold=max(1, int(os.getenv("AWP_PROBE_FAILURE_THRESHOLD", "3"))),
        state_path=Path(os.getenv("AWP_PROBE_STATE_PATH", "/var/lib/awp/health-probe-state.json")),
        log_path=Path(value) if (value := os.getenv("AWP_PROBE_LOG_PATH", "/var/log/awp/health-probe.log")) else None,
        webhook_url=os.getenv("AWP_PROBE_WEBHOOK_URL") or None,
    )


def setup_logging(path: Path | None) -> logging.Logger:
    log = logging.getLogger("awp.health_probe")
    log.handlers.clear()
    log.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    log.addHandler(stream)
    if path is not None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = RotatingFileHandler(path, maxBytes=5_000_000, backupCount=5)
            file_handler.setFormatter(formatter)
            log.addHandler(file_handler)
        except OSError as exc:
            log.warning("event=log_file_unavailable path=%s error=%s", path, type(exc).__name__)
    return log


def load_state(path: Path, endpoints: tuple[str, ...]) -> dict[str, EndpointState]:
    raw: dict = {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        pass
    states: dict[str, EndpointState] = {}
    for endpoint in endpoints:
        item = raw.get(endpoint, {}) if isinstance(raw, dict) else {}
        allowed = {key: item[key] for key in EndpointState.__dataclass_fields__ if key in item}
        states[endpoint] = EndpointState(**allowed)
    return states


def save_state(path: Path, states: dict[str, EndpointState]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps({key: asdict(value) for key, value in states.items()}, indent=2), encoding="utf-8")
    os.replace(temp, path)


def probe_once(base_url: str, endpoint: str, timeout: float) -> tuple[bool, int | None, str | None, float]:
    started = time.monotonic()
    request = urllib.request.Request(base_url + endpoint, headers={"User-Agent": "awp-health-probe/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            response.read(1024)
        return 200 <= status < 400, status, None if status < 400 else f"HTTP {status}", (time.monotonic() - started) * 1000
    except urllib.error.HTTPError as exc:
        return False, exc.code, f"HTTP {exc.code}", (time.monotonic() - started) * 1000
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, None, type(exc).__name__, (time.monotonic() - started) * 1000


def send_webhook(url: str | None, event: str, endpoint: str, state: EndpointState, log: logging.Logger) -> None:
    if not url:
        log.warning("event=notification_skipped reason=no_webhook transition=%s endpoint=%s", event, endpoint)
        return
    body = json.dumps({"event": event, "endpoint": endpoint, "state": asdict(state)}).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read(1024)
        log.info("event=notification_sent transition=%s endpoint=%s", event, endpoint)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.error("event=notification_failed transition=%s endpoint=%s error=%s", event, endpoint, type(exc).__name__)


def update_state(state: EndpointState, healthy: bool, status: int | None, error: str | None, latency_ms: float, threshold: int) -> str | None:
    state.last_status = status
    state.last_error = error
    state.last_latency_ms = latency_ms
    if healthy:
        transition = "recovered" if state.alerting else None
        state.failures = 0
        state.alerting = False
        return transition
    state.failures += 1
    if state.failures >= threshold and not state.alerting:
        state.alerting = True
        return "failed"
    return None


def run_cycle(config: Config, states: dict[str, EndpointState], log: logging.Logger) -> bool:
    all_healthy = True
    for endpoint in config.endpoints:
        healthy, status, error, latency = probe_once(config.base_url, endpoint, config.timeout)
        transition = update_state(states[endpoint], healthy, status, error, latency, config.threshold)
        all_healthy = all_healthy and healthy
        log.info("event=probe endpoint=%s healthy=%s status=%s latency_ms=%.1f failures=%d", endpoint, healthy, status, latency, states[endpoint].failures)
        if transition:
            send_webhook(config.webhook_url, transition, endpoint, states[endpoint], log)
    save_state(config.state_path, states)
    return all_healthy


def _handle_signal(_signum, _frame) -> None:
    global _STOP
    _STOP = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="run one probe cycle and exit")
    args = parser.parse_args(argv)
    config = load_config()
    log = setup_logging(config.log_path)
    states = load_state(config.state_path, config.endpoints)
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    while not _STOP:
        started = time.monotonic()
        healthy = run_cycle(config, states, log)
        if args.once:
            return 0 if healthy else 1
        remaining = max(0.0, config.interval - (time.monotonic() - started))
        while remaining > 0 and not _STOP:
            step = min(0.5, remaining)
            time.sleep(step)
            remaining -= step
    return 0


if __name__ == "__main__":
    raise SystemExit(main())