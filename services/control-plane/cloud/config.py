"""Fail-closed configuration for the Agent Workflow Platform control plane."""
from __future__ import annotations

import ipaddress
import os
import stat
from pathlib import Path

CONTROL_PLANE_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.path.abspath(os.getenv("AWP_DATA_DIR", str(CONTROL_PLANE_ROOT / "var"))))
DATABASE_URL = os.getenv("AWP_DATABASE_URL", str(DATA_DIR / "awp.db"))
REDIS_CONNECT_URL = os.getenv("AWP_REDIS_URL", "").strip()
TASK_SHUTDOWN_GRACE_SECONDS = int(os.getenv("AWP_TASK_SHUTDOWN_GRACE_SECONDS", "30"))
MAX_GLOBAL_SESSIONS = int(os.getenv("AWP_MAX_GLOBAL_SESSIONS", "100"))
SANDBOX_ROOT = os.getenv("AWP_SANDBOX_ROOT", "").strip()
STORAGE_BACKEND = "local"
ENV = os.getenv("AWP_ENV", "dev").strip().lower()
AWP_ENV = ENV
HOST = os.getenv("AWP_HOST", "127.0.0.1").strip()

_WEAK_KEYS = frozenset({
    "awp-local-dev-key",
    "changeme",
    "change-me",
    "password",
    "development",
    "secret",
})


def _read_private_secret_file(raw_path: str) -> str:
    """Read one operator-selected private regular file without following links."""
    try:
        path = Path(raw_path)
        if not path.is_absolute():
            raise ValueError("not absolute")
        resolved = path.resolve(strict=True)
        if os.path.normcase(str(resolved)) != os.path.normcase(str(path)):
            raise ValueError("non-canonical path")

        before = os.lstat(path)
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
            raise ValueError("not a regular file")
        if before.st_size < 16 or before.st_size > 512:
            raise ValueError("invalid size")
        if os.name != "nt":
            if before.st_mode & 0o077:
                raise ValueError("permissions are not private")
            geteuid = getattr(os, "geteuid", None)
            if geteuid is not None and before.st_uid != geteuid():
                raise ValueError("owner mismatch")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            current = os.fstat(fd)
            if not stat.S_ISREG(current.st_mode):
                raise ValueError("not a regular file")
            if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                raise ValueError("file changed")
            payload = os.read(fd, 513)
        finally:
            os.close(fd)
        if len(payload) > 512:
            raise ValueError("invalid size")
        value = payload.decode("utf-8")
        if value.endswith("\n"):
            value = value[:-1]
            if value.endswith("\r"):
                value = value[:-1]
        if not value or any(ch.isspace() for ch in value):
            raise ValueError("invalid token")
        return value
    except (OSError, UnicodeError, ValueError) as exc:
        raise RuntimeError("configured API key file is not a valid private secret file") from exc


def _load_api_key() -> str:
    inline = os.getenv("AWP_DEV_API_KEY", "")
    key_file = os.getenv("AWP_DEV_API_KEY_FILE", "").strip()
    if inline and key_file:
        raise RuntimeError("configure exactly one control-plane API key source")
    if key_file:
        return _read_private_secret_file(key_file)
    if inline != inline.strip() or any(ch.isspace() for ch in inline):
        raise RuntimeError("configured control-plane API key is invalid")
    return inline


DEV_API_KEY = _load_api_key()


def _is_loopback_host(host: str) -> bool:
    candidate = host.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


def validate_startup_security(
    *,
    host: str | None = None,
    environment: str | None = None,
    api_key: str | None = None,
) -> None:
    """The public server supports numeric loopback binding only."""
    bind_host = HOST if host is None else host.strip()
    key = DEV_API_KEY if api_key is None else api_key
    if key.casefold() in _WEAK_KEYS:
        raise RuntimeError("the configured control-plane API key is a known weak value")
    if not key or len(key.encode("utf-8")) < 16:
        raise RuntimeError("an explicit control-plane API key of at least 16 bytes is required")
    if not _is_loopback_host(bind_host):
        raise RuntimeError("the public control plane may bind only to numeric loopback")


def runtime_bind_matches_config(actual_host: str) -> bool:
    """Reject a server CLI whose real socket is not numeric loopback."""
    candidate = str(actual_host).strip()
    if ENV == "test" and candidate == "testserver":
        return True
    return _is_loopback_host(HOST) and _is_loopback_host(candidate)
def get_redis_connect_url() -> str:
    """Resolve the optional Redis endpoint at call time."""
    return os.getenv("AWP_REDIS_URL", os.getenv("REDIS_URL", REDIS_CONNECT_URL)).strip()
