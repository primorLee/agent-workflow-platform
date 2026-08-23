"""Authenticated session metadata and heartbeat registry.

The registry tracks liveness and scheduling hints. It does not allocate CPU,
memory, disk, containers, or operating-system isolation.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from database import get_db
from maintenance import expire_stale_sessions

_log = logging.getLogger(__name__)

VALID_SESSION_TYPES = ("interactive", "batch", "review")
MAX_SESSIONS_PER_USER = int(
    os.getenv("AWP_MAX_SESSIONS_PER_USER", os.getenv("MAX_SESSIONS_PER_USER", "10")),
)
if MAX_SESSIONS_PER_USER <= 0:
    raise RuntimeError("AWP_MAX_SESSIONS_PER_USER must be positive")

_CAPACITY_WARNING_THRESHOLD = 0.85

# Metadata only: a scheduler may interpret these hints, but this module does not
# enforce operating-system resources.
DEFAULT_RESOURCE_HINTS = {
    "interactive": {"cpu_limit": 2, "mem_limit_mb": 2048, "disk_limit_mb": 1024},
    "batch": {"cpu_limit": 4, "mem_limit_mb": 8192, "disk_limit_mb": 4096},
    "review": {"cpu_limit": 2, "mem_limit_mb": 4096, "disk_limit_mb": 2048},
}


@dataclass
class Session:
    session_id: str
    user_id: str
    session_type: str
    created_at: str
    last_heartbeat: str
    status: str = "active"
    resources: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class SessionManager:
    """Store tenant-scoped session liveness with atomic capacity limits."""

    def __init__(self, max_sessions: int | None = None):
        if max_sessions is None:
            from config import MAX_GLOBAL_SESSIONS

            max_sessions = MAX_GLOBAL_SESSIONS
        self.max_sessions = int(max_sessions)
        if self.max_sessions <= 0:
            raise ValueError("max_sessions must be positive")

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _row_to_session(row) -> Session:
        return Session(
            session_id=row["session_id"],
            user_id=row["user_id"],
            session_type=row["session_type"],
            created_at=row["created_at"],
            last_heartbeat=row["last_heartbeat"],
            status=row["status"],
            resources=json.loads(row["resources_json"]),
            metadata=json.loads(row["metadata_json"]),
        )

    def create_session(
        self,
        user_id: str,
        session_type: str,
        metadata: Optional[dict] = None,
    ) -> Session:
        """Atomically create one liveness record within both capacity limits."""
        if session_type not in VALID_SESSION_TYPES:
            raise ValueError(
                f"invalid session_type; expected one of {VALID_SESSION_TYPES}",
            )
        if not user_id:
            raise ValueError("user_id must be non-empty")

        session_id = str(uuid.uuid4())
        now = self._now()
        resource_hints = DEFAULT_RESOURCE_HINTS[session_type]
        metadata_value = metadata or {}
        expire_stale_sessions()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            user_count = db.execute(
                "SELECT COUNT(*) FROM sessions WHERE user_id=? AND status='active'",
                (user_id,),
            ).fetchone()[0]
            if user_count >= MAX_SESSIONS_PER_USER:
                raise PermissionError("per-user active session limit reached")

            count = db.execute(
                "SELECT COUNT(*) FROM sessions WHERE status='active'",
            ).fetchone()[0]
            if count >= self.max_sessions:
                raise RuntimeError("global active session limit reached")
            if count >= int(self.max_sessions * _CAPACITY_WARNING_THRESHOLD):
                _log.warning(
                    "Global session registry capacity at %d/%d",
                    count,
                    self.max_sessions,
                )

            db.execute(
                """INSERT INTO sessions
                       (session_id, user_id, session_type, status,
                        resources_json, metadata_json, created_at, last_heartbeat)
                   VALUES (?, ?, ?, 'active', ?, ?, ?, ?)""",
                (
                    session_id,
                    user_id,
                    session_type,
                    json.dumps(resource_hints, separators=(",", ":")),
                    json.dumps(metadata_value, separators=(",", ":")),
                    now,
                    now,
                ),
            )

        return Session(
            session_id=session_id,
            user_id=user_id,
            session_type=session_type,
            created_at=now,
            last_heartbeat=now,
            resources=resource_hints,
            metadata=metadata_value,
        )

    def heartbeat(self, session_id: str, user_id: str) -> bool:
        """Refresh one active tenant-owned session."""
        with get_db() as db:
            cursor = db.execute(
                """UPDATE sessions
                      SET last_heartbeat=?
                    WHERE session_id=? AND user_id=? AND status='active'""",
                (self._now(), session_id, user_id),
            )
            return bool(cursor.rowcount)

    def terminate(self, session_id: str, user_id: str, reason: str = "") -> bool:
        """Mark one tenant-owned registry record terminated; no resources are freed."""
        now = self._now()
        with get_db() as db:
            cursor = db.execute(
                """UPDATE sessions
                      SET status='terminated',
                          metadata_json=json_set(
                              metadata_json,
                              '$.terminated_reason', ?,
                              '$.terminated_at', ?
                          )
                    WHERE session_id=? AND user_id=?""",
                (reason or "user_request", now, session_id, user_id),
            )
            return bool(cursor.rowcount)

    def list_user_sessions(self, user_id: str) -> list[Session]:
        """List non-terminated records owned by exactly one authenticated user."""
        with get_db() as db:
            rows = db.execute(
                """SELECT * FROM sessions
                    WHERE user_id=? AND status!='terminated'
                    ORDER BY created_at DESC""",
                (user_id,),
            ).fetchall()
        return [self._row_to_session(row) for row in rows]
