"""SQLite persistence with WAL, busy timeout, and idempotent bootstrap."""
from __future__ import annotations

import contextlib
import json
import os
import re
import sqlite3
import stat
import threading
from pathlib import Path
from uuid import UUID, uuid4

from config import CONTROL_PLANE_ROOT, DATA_DIR, DATABASE_URL

_SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'local',
    hostname TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'offline',
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    version TEXT NOT NULL DEFAULT '',
    last_heartbeat TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'local',
    task_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    assigned_agent_id INTEGER,
    result_json TEXT,
    error TEXT,
    delivered_at TEXT,
    attempt_id TEXT,
    lease_expires_at TEXT,
    lease_heartbeat_at TEXT,
    correlation_id TEXT,
    idempotency_key TEXT,
    ack_received_at TEXT,
    response_received_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assigned_agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_tenant_idempotency
    ON tasks(tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;


CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    resources_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_status_heartbeat
    ON sessions(status, last_heartbeat);

CREATE TABLE IF NOT EXISTS agent_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    stage TEXT NOT NULL,
    published_at TEXT NOT NULL,
    entered_stage_at TEXT NOT NULL,
    download_url TEXT NOT NULL,
    sig_url TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL,
    min_protocol INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_version_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER,
    tenant_id TEXT,
    event_type TEXT NOT NULL,
    from_ver TEXT,
    to_ver TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""

_MARKER_NAME = ".awp-data-root-v1"
_MARKER_OWNER = "agent-workflow-platform-control-plane"
_DB_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.db")
_STORAGE_LOCK = threading.Lock()
SCHEMA_VERSION = 2

_TASK_LIFECYCLE_COLUMNS = {
    "attempt_id": "TEXT",
    "lease_expires_at": "TEXT",
    "lease_heartbeat_at": "TEXT",
}


def _is_link_or_reparse(info: os.stat_result) -> bool:
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse)


def _canonical_absolute(path: Path, *, label: str) -> Path:
    if not path.is_absolute():
        raise RuntimeError(f"{label} must be absolute")
    canonical = Path(os.path.abspath(str(path)))
    if os.path.normcase(str(canonical)) != os.path.normcase(str(path)):
        raise RuntimeError(f"{label} must be canonical")
    if canonical.parent == canonical:
        raise RuntimeError(f"{label} must not be a filesystem root")
    return canonical


def _check_existing_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if not os.path.lexists(current):
            break
        info = os.lstat(current)
        if _is_link_or_reparse(info):
            raise RuntimeError("control-plane storage path contains a link or reparse point")


def _validate_private(info: os.stat_result, *, directory: bool) -> None:
    if directory and not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("control-plane data root is not a directory")
    if not directory and not stat.S_ISREG(info.st_mode):
        raise RuntimeError("control-plane storage entry is not a regular file")
    if os.name != "nt":
        geteuid = getattr(os, "geteuid", None)
        if geteuid is not None and info.st_uid != geteuid():
            raise RuntimeError("control-plane storage owner mismatch")
        if info.st_mode & 0o077:
            raise RuntimeError("control-plane storage permissions are not private")


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_marker(path: Path) -> None:
    payload = json.dumps(
        {
            "schema": 1,
            "owner": _MARKER_OWNER,
            "install_id": str(uuid4()),
        },
        separators=(",", ":"),
    ).encode("utf-8")
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    fd = os.open(path, flags, 0o600)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short marker write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    if os.name != "nt":
        os.chmod(path, 0o600, follow_symlinks=False)
    _fsync_directory(path.parent)


def _read_owned_file(path: Path, *, maximum: int) -> bytes:
    before = os.lstat(path)
    if _is_link_or_reparse(before):
        raise RuntimeError("control-plane storage entry must not be a link")
    _validate_private(before, directory=False)
    if before.st_size < 1 or before.st_size > maximum:
        raise RuntimeError("control-plane storage entry has an invalid size")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        current = os.fstat(fd)
        _validate_private(current, directory=False)
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError("control-plane storage entry changed during validation")
        payload = os.read(fd, maximum + 1)
    finally:
        os.close(fd)
    if len(payload) > maximum:
        raise RuntimeError("control-plane storage entry is too large")
    return payload


def _validate_marker(marker: Path) -> None:
    try:
        value = json.loads(_read_owned_file(marker, maximum=512).decode("utf-8"))
        if set(value) != {"schema", "owner", "install_id"}:
            raise ValueError("marker fields")
        if value["schema"] != 1 or value["owner"] != _MARKER_OWNER:
            raise ValueError("marker identity")
        UUID(str(value["install_id"]))
    except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("control-plane data root marker is invalid") from exc


def _ensure_private_storage() -> Path:
    root = _canonical_absolute(Path(DATA_DIR), label="AWP_DATA_DIR")
    database = _canonical_absolute(Path(DATABASE_URL), label="AWP_DATABASE_URL")
    if database.parent != root or _DB_NAME.fullmatch(database.name) is None:
        raise RuntimeError("AWP_DATABASE_URL must be a direct .db child of AWP_DATA_DIR")
    _check_existing_components(root)

    created = False
    if not os.path.lexists(root):
        if not root.parent.is_dir():
            raise RuntimeError("AWP_DATA_DIR parent must already exist")
        os.mkdir(root, 0o700)
        created = True
        if os.name != "nt":
            os.chmod(root, 0o700)

    root_info = os.lstat(root)
    if _is_link_or_reparse(root_info):
        raise RuntimeError("control-plane data root must not be a link")
    if os.name != "nt" and root_info.st_mode & 0o077:
        entries = list(os.scandir(root))
        bootstrap = os.getenv("AWP_DATA_ROOT_BOOTSTRAP", "") == "1"
        default_root = root == CONTROL_PLANE_ROOT / "var"
        if entries or not (created or bootstrap or default_root):
            raise RuntimeError("control-plane data root permissions are not private")
        os.chmod(root, 0o700)
        root_info = os.lstat(root)
    _validate_private(root_info, directory=True)

    marker = root / _MARKER_NAME
    if not os.path.lexists(marker):
        entries = list(os.scandir(root))
        bootstrap = os.getenv("AWP_DATA_ROOT_BOOTSTRAP", "") == "1"
        default_root = root == CONTROL_PLANE_ROOT / "var"
        if entries or not (created or bootstrap or default_root):
            raise RuntimeError("refusing to claim an existing unmarked data root")
        _write_marker(marker)
    _validate_marker(marker)

    if os.path.lexists(database):
        info = os.lstat(database)
        if _is_link_or_reparse(info):
            raise RuntimeError("control-plane database must not be a link")
        _validate_private(info, directory=False)
    else:
        flags = (
            os.O_RDWR
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        fd = os.open(database, flags, 0o600)
        try:
            info = os.fstat(fd)
            _validate_private(info, directory=False)
            os.fsync(fd)
        finally:
            os.close(fd)
        if os.name != "nt":
            os.chmod(database, 0o600, follow_symlinks=False)
        _fsync_directory(root)
    return database


def _connect() -> sqlite3.Connection:
    with _STORAGE_LOCK:
        path = _ensure_private_storage()
    conn = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate_task_lifecycle(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "tasks")
    for name, declaration in _TASK_LIFECYCLE_COLUMNS.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} {declaration}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_running_lease "
        "ON tasks(status, lease_expires_at)"
    )


def init_db() -> None:
    """Create the base schema, then apply versioned migrations fail-closed."""
    with _connect() as conn:
        current = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise RuntimeError(
                f"database schema version {current} is newer than supported {SCHEMA_VERSION}"
            )
        conn.executescript(_SCHEMA)
        conn.execute("BEGIN IMMEDIATE")
        if current < 2:
            _migrate_task_lifecycle(conn)
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


@contextlib.contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
