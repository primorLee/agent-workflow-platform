"""Create the local Compose API key once in an app-owned named volume."""
from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path

_AUTH_DIR = Path("/run/awp-auth")
_MARKER = _AUTH_DIR / ".awp-local-auth-v1"
_KEY = _AUTH_DIR / "control-plane.key"
_MARKER_BYTES = (
    json.dumps(
        {"owner": "agent-workflow-platform", "schema": "awp-local-auth", "version": 1},
        separators=(",", ":"),
        sort_keys=True,
    )
    + "\n"
).encode("ascii")


def _open_exclusive(path: Path, mode: int) -> int:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    return os.open(path, flags, mode)


def _validate_regular(path: Path, *, expected: bytes | None = None) -> bytes:
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise RuntimeError("local demo auth state is not a regular file")
    if before.st_uid != os.geteuid() or before.st_mode & 0o077:
        raise RuntimeError("local demo auth state is not private")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        current = os.fstat(fd)
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise RuntimeError("local demo auth state changed during validation")
        data = os.read(fd, 513)
    finally:
        os.close(fd)
    if expected is not None and data != expected:
        raise RuntimeError("local demo auth ownership marker is invalid")
    return data


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _validate_key_payload(payload: bytes) -> None:
    if len(payload) > 512:
        raise RuntimeError("local demo API key is invalid")
    if payload.endswith(b"\r\n"):
        value = payload[:-2]
    elif payload.endswith(b"\n"):
        value = payload[:-1]
    else:
        value = payload
    try:
        decoded = value.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError("local demo API key is invalid") from exc
    if len(value) < 32 or any(ch.isspace() for ch in decoded):
        raise RuntimeError("local demo API key is invalid")


def bootstrap() -> None:
    if os.getenv("AWP_LOCAL_DEMO_AUTH_BOOTSTRAP", "") != "1":
        raise RuntimeError("local demo auth bootstrap requires explicit opt-in")

    before = os.lstat(_AUTH_DIR)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise RuntimeError("local demo auth root is not a real directory")
    if before.st_uid != os.geteuid() or before.st_mode & 0o022:
        raise RuntimeError("local demo auth root has unsafe ownership or permissions")

    if _MARKER.exists():
        _validate_regular(_MARKER, expected=_MARKER_BYTES)
    else:
        if any(_AUTH_DIR.iterdir()):
            raise RuntimeError("unowned local demo auth root is not empty")
        fd = _open_exclusive(_MARKER, 0o600)
        try:
            os.write(fd, _MARKER_BYTES)
            os.fsync(fd)
        finally:
            os.close(fd)
        _fsync_directory(_AUTH_DIR)

    if _KEY.exists():
        _validate_key_payload(_validate_regular(_KEY))
        return

    value = secrets.token_urlsafe(32).encode("ascii")
    fd = _open_exclusive(_KEY, 0o600)
    try:
        os.write(fd, value)
        os.fsync(fd)
    finally:
        os.close(fd)
    _fsync_directory(_AUTH_DIR)


if __name__ == "__main__":
    bootstrap()
