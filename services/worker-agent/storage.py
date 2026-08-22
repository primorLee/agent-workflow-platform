"""Fail-closed filesystem primitives for worker-owned local state.

The worker deliberately keeps all mutable state below one private, marked root.
These helpers reject links/reparse points, wrong owners, permissive POSIX modes,
and inode changes between inspection and use.  They never adopt an unmarked
pre-existing directory.
"""
from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path
from typing import BinaryIO

APP_MARKER_NAME = ".awp-worker-root.json"
APP_MARKER = {"schema": "awp-worker-root/v1"}
DIR_MODE = 0o700
FILE_MODE = 0o600
MARKER_MAX_BYTES = 4096


def lexists(path: Path) -> bool:
    return os.path.lexists(path)


def is_link_or_reparse(path: Path) -> bool:
    try:
        metadata = os.lstat(path)
    except OSError:
        return True
    if stat.S_ISLNK(metadata.st_mode):
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    return bool(getattr(metadata, "st_file_attributes", 0) & reparse_flag)


def _same_identity(first: os.stat_result, second: os.stat_result) -> bool:
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _owned_by_current_user(metadata: os.stat_result) -> bool:
    getuid = getattr(os, "getuid", None)
    return getuid is None or metadata.st_uid == getuid()


def _private_mode(metadata: os.stat_result, expected: int) -> bool:
    return os.name == "nt" or stat.S_IMODE(metadata.st_mode) == expected


def _validate_directory(path: Path, *, expected_mode: int = DIR_MODE) -> tuple[Path, os.stat_result]:
    if not lexists(path) or is_link_or_reparse(path):
        raise PermissionError("worker state directory is missing or linked")
    before = os.lstat(path)
    if (
        not stat.S_ISDIR(before.st_mode)
        or not _owned_by_current_user(before)
        or not _private_mode(before, expected_mode)
    ):
        raise PermissionError("worker state directory ownership or mode is invalid")
    resolved = path.resolve(strict=True)
    after = os.stat(resolved, follow_symlinks=False)
    if not _same_identity(before, after):
        raise PermissionError("worker state directory changed during validation")
    return resolved, after


def _validate_regular_metadata(metadata: os.stat_result, *, max_bytes: int | None = None) -> None:
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise PermissionError("worker state file is not a private regular file")
    if not _owned_by_current_user(metadata) or not _private_mode(metadata, FILE_MODE):
        raise PermissionError("worker state file ownership or mode is invalid")
    if max_bytes is not None and metadata.st_size > max_bytes:
        raise ValueError("worker state file exceeds its size limit")


def _open_nofollow(path: Path, flags: int, mode: int = FILE_MODE) -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    binary = getattr(os, "O_BINARY", 0)
    return os.open(path, flags | nofollow | binary, mode)


def _set_fd_private(descriptor: int, path: Path) -> None:
    if hasattr(os, "fchmod"):
        os.fchmod(descriptor, FILE_MODE)
    else:
        os.chmod(path, FILE_MODE)


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(directory: Path) -> None:
    """Durably persist owned-directory metadata where supported."""
    directory, _ = _validate_directory(directory)
    _fsync_directory(directory)


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("short worker state write")
        view = view[written:]


def _validate_direct_child(directory: Path, path: Path) -> None:
    if path.parent != directory or not path.name or path.name in {".", ".."}:
        raise ValueError("worker state path escapes its owned directory")
    if "/" in path.name or "\\" in path.name or "\x00" in path.name:
        raise ValueError("worker state filename is invalid")


def write_exclusive(directory: Path, name: str, data: bytes, *, max_bytes: int) -> Path:
    directory, directory_identity = _validate_directory(directory)
    if len(data) > max_bytes:
        raise ValueError("worker state payload exceeds its size limit")
    final = directory / name
    _validate_direct_child(directory, final)
    descriptor = _open_nofollow(
        final,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        FILE_MODE,
    )
    try:
        _set_fd_private(descriptor, final)
        opened = os.fstat(descriptor)
        _validate_regular_metadata(opened, max_bytes=max_bytes)
        _write_all(descriptor, data)
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        try:
            current = os.lstat(final)
            if _same_identity(opened, current):
                os.unlink(final)
        except (OSError, UnboundLocalError):
            pass
        raise
    else:
        os.close(descriptor)
    _, current_directory = _validate_directory(directory)
    if not _same_identity(directory_identity, current_directory):
        raise PermissionError("worker state directory changed during write")
    _fsync_directory(directory)
    return final


def atomic_write(directory: Path, name: str, data: bytes, *, max_bytes: int) -> Path:
    directory, directory_identity = _validate_directory(directory)
    if len(data) > max_bytes:
        raise ValueError("worker state payload exceeds its size limit")
    final = directory / name
    _validate_direct_child(directory, final)
    if lexists(final):
        if is_link_or_reparse(final):
            raise PermissionError("worker state destination is linked")
        existing = os.lstat(final)
        _validate_regular_metadata(existing, max_bytes=max_bytes)
    temporary = directory / f".{name}.tmp-{secrets.token_hex(16)}"
    write_exclusive(directory, temporary.name, data, max_bytes=max_bytes)
    temp_identity = os.lstat(temporary)
    try:
        _, current_directory = _validate_directory(directory)
        if not _same_identity(directory_identity, current_directory):
            raise PermissionError("worker state directory changed before replace")
        if lexists(final):
            if is_link_or_reparse(final):
                raise PermissionError("worker state destination changed to a link")
            _validate_regular_metadata(os.lstat(final), max_bytes=max_bytes)
        os.replace(temporary, final)
        current = os.lstat(final)
        if not _same_identity(temp_identity, current):
            raise PermissionError("worker state replacement identity mismatch")
        _fsync_directory(directory)
    finally:
        try:
            current = os.lstat(temporary)
            if _same_identity(temp_identity, current):
                os.unlink(temporary)
        except OSError:
            pass
    return final


def open_existing(path: Path, *, max_bytes: int, flags: int = os.O_RDONLY) -> tuple[int, os.stat_result]:
    if not lexists(path) or is_link_or_reparse(path):
        raise PermissionError("worker state file is missing or linked")
    before = os.lstat(path)
    _validate_regular_metadata(before, max_bytes=max_bytes)
    descriptor = _open_nofollow(path, flags)
    try:
        opened = os.fstat(descriptor)
        _validate_regular_metadata(opened, max_bytes=max_bytes)
        if not _same_identity(before, opened):
            raise PermissionError("worker state file changed during open")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor, opened


def read_bytes(path: Path, *, max_bytes: int) -> bytes:
    descriptor, opened = open_existing(path, max_bytes=max_bytes)
    try:
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            raise ValueError("worker state file exceeds its size limit")
        after = os.fstat(descriptor)
        if not _same_identity(opened, after) or after.st_size != opened.st_size:
            raise PermissionError("worker state file changed during read")
        return data
    finally:
        os.close(descriptor)


def read_json(path: Path, *, max_bytes: int) -> object:
    try:
        return json.loads(read_bytes(path, max_bytes=max_bytes).decode("utf-8"))
    except UnicodeDecodeError:
        raise ValueError("worker state JSON is not UTF-8") from None


def safe_unlink(path: Path, expected: os.stat_result) -> None:
    if not lexists(path) or is_link_or_reparse(path):
        raise PermissionError("worker state file changed before removal")
    current = os.lstat(path)
    _validate_regular_metadata(current)
    if not _same_identity(expected, current):
        raise PermissionError("worker state file identity changed before removal")
    os.unlink(path)
    _fsync_directory(path.parent)


def prepare_app_root(raw_path: str | Path) -> Path:
    path = Path(os.path.abspath(os.fspath(raw_path)))
    if lexists(path):
        root, _ = _validate_directory(path)
        marker = root / APP_MARKER_NAME
        if read_json(marker, max_bytes=MARKER_MAX_BYTES) != APP_MARKER:
            raise PermissionError("worker state root marker is invalid")
        return root

    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    if is_link_or_reparse(parent):
        # A configured parent may itself be a deliberate link, but the private
        # root must be pinned to its real destination before creation.
        parent = parent.resolve(strict=True)
        path = parent / path.name
    path.mkdir(mode=DIR_MODE)
    os.chmod(path, DIR_MODE)
    root, _ = _validate_directory(path)
    try:
        encoded = (json.dumps(APP_MARKER, sort_keys=True, separators=(",", ":")) + "\n").encode()
        write_exclusive(root, APP_MARKER_NAME, encoded, max_bytes=MARKER_MAX_BYTES)
    except BaseException:
        # Do not recursively remove anything here.  An interrupted first start
        # intentionally leaves an unmarked directory that a human must inspect.
        raise
    return root


def existing_app_root(raw_path: str | Path) -> Path | None:
    path = Path(os.path.abspath(os.fspath(raw_path)))
    if not lexists(path):
        return None
    return prepare_app_root(path)


def ensure_owned_subdir(root: Path, name: str, marker_name: str, marker: dict) -> Path:
    root, _ = _validate_directory(root)
    candidate = root / name
    _validate_direct_child(root, candidate)
    if lexists(candidate):
        directory, _ = _validate_directory(candidate)
        if read_json(directory / marker_name, max_bytes=MARKER_MAX_BYTES) != marker:
            raise PermissionError("worker subdirectory marker is invalid")
        return directory
    candidate.mkdir(mode=DIR_MODE)
    os.chmod(candidate, DIR_MODE)
    directory, _ = _validate_directory(candidate)
    encoded = (json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n").encode()
    write_exclusive(directory, marker_name, encoded, max_bytes=MARKER_MAX_BYTES)
    _fsync_directory(root)
    return directory


def open_append_file(root: Path, name: str, *, max_existing_bytes: int) -> BinaryIO:
    root, _ = _validate_directory(root)
    path = root / name
    _validate_direct_child(root, path)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    if lexists(path):
        descriptor, _ = open_existing(path, max_bytes=max_existing_bytes, flags=flags)
    else:
        descriptor = _open_nofollow(path, flags | os.O_EXCL, FILE_MODE)
        _set_fd_private(descriptor, path)
        _validate_regular_metadata(os.fstat(descriptor), max_bytes=max_existing_bytes)
        _fsync_directory(root)
    return os.fdopen(descriptor, "a", encoding="utf-8", buffering=1)
