"""Outbound-only control-plane client with strict crash-safe offline replay."""
from __future__ import annotations

import ipaddress
import json
import logging
import math
import os
import platform
import re
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import requests

from storage import (
    ensure_owned_subdir,
    fsync_directory,
    is_link_or_reparse,
    lexists,
    open_existing,
    prepare_app_root,
    read_bytes,
    safe_unlink,
    write_exclusive,
)

logger = logging.getLogger("awp.worker.cloud")
_MAX_RETRIES = 5
_BASE_DELAY = 1
_MAX_DELAY = 60
_MAX_OFFLINE_BYTES = 16 * 1024 * 1024
_MAX_OFFLINE_LOG_BYTES = 1024 * 1024
_SAFE_TASK_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_DNS_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_CLOUD_URL_INVALID = "cloud_url must be an absolute HTTP(S) URL with a valid host"
_CLOUD_URL_INSECURE = "plain HTTP cloud_url is allowed only for localhost or a loopback IP"
_QUEUE_DIR_NAME = "offline-queue"
_QUEUE_MARKER_NAME = ".awp-worker-offline-queue.json"
_QUEUE_MARKER = {"schema": "awp-worker-offline-queue/v1"}
_REJECTED_DIR_NAME = "rejected"
_REJECTED_MARKER_NAME = ".awp-worker-rejected-queue.json"
_REJECTED_MARKER = {"schema": "awp-worker-rejected-queue/v1"}
_QUEUE_SCHEMA = "awp-offline-result/v1"
_QUEUE_NAME = re.compile(
    r"^(?P<timestamp>[0-9]{20})-(?P<nonce>[0-9a-f]{32})\.json$"
)
# This reversible 57-character claim is no longer than its 58-character source.
_CLAIM_NAME = re.compile(
    r"^\.c(?P<timestamp>[0-9]{20})-(?P<nonce>[0-9a-f]{32})\.s$"
)
_REPLAY_LOCKS_GUARD = threading.Lock()
_REPLAY_LOCKS: dict[str, threading.RLock] = {}


def _shared_replay_lock(directory: Path) -> threading.RLock:
    key = os.path.normcase(str(directory)) if os.name == "nt" else str(directory)
    with _REPLAY_LOCKS_GUARD:
        return _REPLAY_LOCKS.setdefault(key, threading.RLock())


class PermanentRequestError(requests.HTTPError):
    """A sanitized response failure that replay must not retry forever."""

    def __init__(self, status_code: int):
        self.status_code = int(status_code)
        super().__init__(f"control plane rejected request with HTTP {self.status_code}")


def _valid_dns_hostname(host: str) -> bool:
    if not host or len(host) > 253:
        return False
    name = host[:-1] if host.endswith(".") else host
    if not name or all(ch.isdigit() or ch == "." for ch in name):
        return False
    try:
        name.encode("ascii")
    except UnicodeEncodeError:
        return False
    return all(_DNS_LABEL.fullmatch(label) for label in name.split("."))


def _valid_authority(authority: str, host: str) -> bool:
    if not authority or any(ch in authority for ch in "\\\r\n\t%"):
        return False
    if ":" in host:
        if not authority.startswith("["):
            return False
        close = authority.find("]")
        if close < 0 or authority[1:close].lower() != host.lower():
            return False
        suffix = authority[close + 1:]
    else:
        if "[" in authority or "]" in authority or authority.count(":") > 1:
            return False
        if ":" in authority:
            raw_host, raw_port = authority.rsplit(":", 1)
            suffix = ":" + raw_port
        else:
            raw_host, suffix = authority, ""
        if raw_host.lower() != host.lower():
            return False
    if not suffix:
        return True
    if not suffix.startswith(":"):
        return False
    port = suffix[1:]
    return bool(port and port.isascii() and port.isdigit() and 1 <= int(port) <= 65535)


def validate_cloud_url(raw: str) -> str:
    if (
        not isinstance(raw, str)
        or not raw
        or raw.strip() != raw
        or "\\" in raw
        or any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in raw)
    ):
        raise ValueError(_CLOUD_URL_INVALID)
    try:
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        host = parsed.hostname
        parsed.port
        has_userinfo = parsed.username is not None or parsed.password is not None or "@" in parsed.netloc
    except (TypeError, ValueError):
        raise ValueError(_CLOUD_URL_INVALID) from None
    if (
        scheme not in {"http", "https"}
        or host is None
        or not parsed.netloc
        or has_userinfo
        or parsed.query
        or parsed.fragment
        or not _valid_authority(parsed.netloc, host)
    ):
        raise ValueError(_CLOUD_URL_INVALID)
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
        if not _valid_dns_hostname(host):
            raise ValueError(_CLOUD_URL_INVALID) from None
    if scheme == "http":
        is_loopback = bool(ip and ip.is_loopback)
        if ip is None:
            is_loopback = host.lower() == "localhost"
        if not is_loopback:
            raise ValueError(_CLOUD_URL_INSECURE)
    return raw.rstrip("/")


def _validate_result_payload(payload: object) -> dict:
    if not isinstance(payload, dict) or set(payload) != {
        "status", "output", "logs", "duration_s"
    }:
        raise ValueError("offline result payload has an invalid schema")
    status = payload["status"]
    output = payload["output"]
    logs = payload["logs"]
    duration = payload["duration_s"]
    if status not in {"success", "failed"}:
        raise ValueError("offline result status is invalid")
    if not isinstance(output, dict):
        raise ValueError("offline result output must be an object")
    if not isinstance(logs, str) or len(logs.encode("utf-8")) > _MAX_OFFLINE_LOG_BYTES:
        raise ValueError("offline result logs exceed their limit")
    if (
        isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(float(duration))
        or float(duration) < 0
        or float(duration) > 31_536_000
    ):
        raise ValueError("offline result duration is invalid")
    return payload


def _validate_queue_record(item: object) -> dict:
    if not isinstance(item, dict) or set(item) != {"schema", "kind", "payload"}:
        raise ValueError("offline queue record has an invalid schema")
    if item["schema"] != _QUEUE_SCHEMA or item["kind"] != "result":
        raise ValueError("offline queue record type is unsupported")
    body = item["payload"]
    if not isinstance(body, dict) or set(body) != {"task_id", "payload"}:
        raise ValueError("offline queue body has an invalid schema")
    task_id = body["task_id"]
    if not isinstance(task_id, str) or not _SAFE_TASK_ID.fullmatch(task_id):
        raise ValueError("offline queue task_id is invalid")
    _validate_result_payload(body["payload"])
    return item


def _encode_queue_record(kind: str, payload: dict) -> bytes:
    record = {"schema": _QUEUE_SCHEMA, "kind": kind, "payload": payload}
    _validate_queue_record(record)
    try:
        encoded = (
            json.dumps(
                record,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        raise ValueError("offline result is not JSON serializable") from None
    if len(encoded) > _MAX_OFFLINE_BYTES:
        raise ValueError("offline result exceeds its size limit")
    return encoded


class CloudClient:
    def __init__(self, cfg: dict):
        self._base = validate_cloud_url(cfg["cloud_url"])
        self._session = requests.Session()
        self._session.trust_env = False
        self._api_key = cfg.get("api_key", "")
        self._token = cfg.get("agent_token")
        self._timeout = int(cfg.get("request_timeout", 30))
        root = prepare_app_root(cfg["work_dir"])
        self._offline_dir = ensure_owned_subdir(
            root, _QUEUE_DIR_NAME, _QUEUE_MARKER_NAME, _QUEUE_MARKER
        )
        self._rejected_dir = ensure_owned_subdir(
            root, _REJECTED_DIR_NAME, _REJECTED_MARKER_NAME, _REJECTED_MARKER
        )
        self._replay_lock = _shared_replay_lock(self._offline_dir)

    @property
    def token(self):
        return self._token

    def _headers(self) -> dict[str, str]:
        token = self._token or self._api_key
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        return headers

    def _request(self, method: str, path: str, payload=None, retries: int = _MAX_RETRIES):
        delay = _BASE_DELAY
        last_reason = "transport unavailable"
        for attempt in range(1, retries + 1):
            try:
                response = self._session.request(
                    method,
                    self._base + path,
                    headers=self._headers(),
                    json=payload,
                    timeout=self._timeout,
                    allow_redirects=False,
                )
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_reason = type(exc).__name__
                logger.warning(
                    "Control plane unavailable (attempt %d/%d): %s",
                    attempt,
                    retries,
                    last_reason,
                )
            except requests.RequestException as exc:
                last_reason = type(exc).__name__
                logger.warning(
                    "Control plane request failed (attempt %d/%d): %s",
                    attempt,
                    retries,
                    last_reason,
                )
            else:
                status = int(response.status_code)
                if 300 <= status < 400:
                    raise PermanentRequestError(status)
                if 400 <= status < 500 and status != 429:
                    raise PermanentRequestError(status)
                if status >= 400:
                    last_reason = f"HTTP {status}"
                else:
                    if not response.content:
                        return {}
                    try:
                        return response.json()
                    except ValueError:
                        raise ValueError("control plane returned invalid JSON") from None
            if attempt < retries:
                time.sleep(min(delay, _MAX_DELAY))
                delay *= 2
        raise ConnectionError(
            f"control plane request failed after {retries} attempts ({last_reason})"
        )

    def register(self, system_info: dict | None = None):
        info = system_info or _system_info()
        data = self._request("POST", "/v1/agent/register", {
            "hostname": info["hostname"],
            "capabilities": info,
            "version": info.get("worker_version", ""),
        })
        self._token = data.get("agent_token") or self._token
        return self._token

    def heartbeat(self, status="idle", running_tasks=None):
        return self._request("POST", "/v1/agent/heartbeat", {
            "status": status,
            "running_tasks": list(running_tasks or []),
            "capabilities": _system_info(),
        })

    def poll_tasks(self) -> list[dict]:
        raw = self._request("GET", "/v1/agent/tasks/pending")
        items = raw if isinstance(raw, list) else raw.get("tasks", [])
        tasks = []
        for item in items:
            payload = dict(item.get("payload") or {})
            payload.setdefault("task_id", str(item.get("id") or item.get("task_id") or ""))
            payload.setdefault("task_type", item.get("type", "command"))
            tasks.append(payload)
        return tasks

    def report_result(self, task_id: str, result: dict):
        if not isinstance(task_id, str) or not _SAFE_TASK_ID.fullmatch(task_id):
            raise ValueError("task_id is invalid")
        payload = {
            "status": "success" if result.get("status") == "success" else "failed",
            "output": result.get("output", {}),
            "logs": result.get("log_tail", ""),
            "duration_s": result.get("elapsed", 0),
        }
        _validate_result_payload(payload)
        try:
            return self._request("POST", f"/v1/agent/tasks/{task_id}/result", payload)
        except (ConnectionError, requests.ConnectionError, requests.Timeout):
            self._cache_offline("result", {"task_id": task_id, "payload": payload})
            return None

    def _cache_offline(self, kind: str, payload: dict) -> Path:
        encoded = _encode_queue_record(kind, payload)
        with self._replay_lock:
            for _ in range(8):
                name = f"{time.time_ns():020d}-{uuid.uuid4().hex}.json"
                try:
                    final = write_exclusive(
                        self._offline_dir,
                        name,
                        encoded,
                        max_bytes=_MAX_OFFLINE_BYTES,
                    )
                except FileExistsError:
                    continue
                logger.warning("Cached one result for later replay")
                return final
        raise RuntimeError("could not allocate an offline queue filename")

    def _recover_orphan_claims(self) -> None:
        claims: list[Path] = []
        with os.scandir(self._offline_dir) as entries:
            for entry in entries:
                if _CLAIM_NAME.fullmatch(entry.name):
                    claims.append(self._offline_dir / entry.name)
        for claim in sorted(claims, key=lambda path: path.name):
            match = _CLAIM_NAME.fullmatch(claim.name)
            assert match is not None
            original_name = (
                f"{match.group('timestamp')}-{match.group('nonce')}.json"
            )
            try:
                descriptor, identity = open_existing(
                    claim, max_bytes=_MAX_OFFLINE_BYTES
                )
                os.close(descriptor)
                destination = self._offline_dir / original_name
                if lexists(destination):
                    self._reject_claim(claim, identity, original_name)
                    continue
                os.rename(claim, destination)
                moved = os.lstat(destination)
                if (moved.st_dev, moved.st_ino) != (
                    identity.st_dev, identity.st_ino
                ):
                    raise PermissionError("orphan claim identity mismatch")
                fsync_directory(self._offline_dir)
            except (OSError, PermissionError, ValueError):
                logger.warning("Skipped one unsafe orphan replay claim")

    def _queued_paths(self) -> list[Path]:
        paths: list[Path] = []
        with os.scandir(self._offline_dir) as entries:
            for entry in entries:
                if not _QUEUE_NAME.fullmatch(entry.name):
                    continue
                paths.append(self._offline_dir / entry.name)
        return sorted(paths, key=lambda path: path.name)

    def _claim(self, path: Path) -> tuple[Path, os.stat_result, str]:
        descriptor, identity = open_existing(path, max_bytes=_MAX_OFFLINE_BYTES)
        os.close(descriptor)
        original_name = path.name
        match = _QUEUE_NAME.fullmatch(original_name)
        if match is None:
            raise ValueError("offline queue filename is invalid")
        claim = self._offline_dir / (
            f".c{match.group('timestamp')}-{match.group('nonce')}.s"
        )
        if lexists(claim):
            raise FileExistsError("offline queue claim already exists")
        os.rename(path, claim)
        current = os.lstat(claim)
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise PermissionError("offline queue identity changed during claim")
        fsync_directory(self._offline_dir)
        return claim, identity, original_name

    def _return_claim(self, claim: Path, identity: os.stat_result, original_name: str) -> None:
        destination = self._offline_dir / original_name
        if lexists(destination) or is_link_or_reparse(claim):
            raise PermissionError("offline queue path changed before retry")
        current = os.lstat(claim)
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise PermissionError("offline queue claim identity changed")
        os.rename(claim, destination)
        fsync_directory(self._offline_dir)

    def _reject_claim(self, claim: Path, identity: os.stat_result, original_name: str) -> None:
        if is_link_or_reparse(claim):
            raise PermissionError("offline queue claim changed before rejection")
        current = os.lstat(claim)
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise PermissionError("offline queue claim identity changed")
        if _QUEUE_NAME.fullmatch(original_name) is None:
            raise ValueError("offline queue filename is invalid")
        destination = self._rejected_dir / original_name
        if lexists(destination):
            raise FileExistsError("rejected queue item already exists")
        os.rename(claim, destination)
        moved = os.lstat(destination)
        if (moved.st_dev, moved.st_ino) != (identity.st_dev, identity.st_ino):
            raise PermissionError("rejected queue identity mismatch")
        fsync_directory(self._offline_dir)
        fsync_directory(self._rejected_dir)
        logger.warning("Moved one non-retryable result to the rejected queue")

    def flush_offline(self) -> int:
        flushed = 0
        with self._replay_lock:
            self._recover_orphan_claims()
            for path in self._queued_paths():
                try:
                    claim, identity, original_name = self._claim(path)
                except (OSError, PermissionError, ValueError):
                    logger.warning("Skipped one unsafe offline queue entry")
                    continue
                try:
                    raw = read_bytes(claim, max_bytes=_MAX_OFFLINE_BYTES)
                    item = _validate_queue_record(json.loads(raw.decode("utf-8")))
                    body = item["payload"]
                except (OSError, PermissionError, UnicodeDecodeError, ValueError, TypeError):
                    self._reject_claim(claim, identity, original_name)
                    continue
                try:
                    self._request(
                        "POST",
                        f"/v1/agent/tasks/{body['task_id']}/result",
                        body["payload"],
                        retries=2,
                    )
                except (ConnectionError, requests.ConnectionError, requests.Timeout):
                    self._return_claim(claim, identity, original_name)
                    break
                except PermanentRequestError:
                    self._reject_claim(claim, identity, original_name)
                    continue
                except ValueError:
                    self._reject_claim(claim, identity, original_name)
                    continue
                safe_unlink(claim, identity)
                flushed += 1
        return flushed


def _system_info() -> dict:
    return {
        "hostname": platform.node() or "unknown",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpus": os.cpu_count() or 1,
        "worker_version": "1.0.0",
    }
