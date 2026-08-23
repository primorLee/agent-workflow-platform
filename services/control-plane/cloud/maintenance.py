"""Durable task, worker, and session lease maintenance.

The public stack is single-node, but its failure semantics are not best-effort:
workers hold fenced task attempts, leases expire after missed heartbeats, and
stale registry rows stop consuming active capacity.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone

from config import (
    AGENT_STALE_SECONDS,
    MAINTENANCE_INTERVAL_SECONDS,
    SESSION_STALE_SECONDS,
    TASK_MAX_RETRIES,
)
from database import get_db

_log = logging.getLogger("awp.control_plane.maintenance")


def _utc_now(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc)


def _task_timestamp(value: datetime) -> str:
    return _utc_now(value).isoformat()


def _session_timestamp(value: datetime) -> str:
    return _utc_now(value).strftime("%Y-%m-%d %H:%M:%S")


def expire_stale_agents(*, current: datetime | None = None) -> list[int]:
    now = _utc_now(current)
    cutoff = _task_timestamp(now - timedelta(seconds=AGENT_STALE_SECONDS))
    timestamp = _task_timestamp(now)
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """SELECT id FROM agents
               WHERE status!='offline'
                 AND last_heartbeat IS NOT NULL
                 AND last_heartbeat<=?""",
            (cutoff,),
        ).fetchall()
        agent_ids = [int(row["id"]) for row in rows]
        if agent_ids:
            placeholders = ",".join("?" for _ in agent_ids)
            conn.execute(
                f"UPDATE agents SET status='offline' WHERE id IN ({placeholders})",
                agent_ids,
            )
            # A stale worker cannot renew its claims. Expire them now so the
            # fenced task reaper can make forward progress in the same pass.
            conn.execute(
                f"""UPDATE tasks SET lease_expires_at=?, updated_at=?
                    WHERE status='running' AND assigned_agent_id IN ({placeholders})""",
                (timestamp, timestamp, *agent_ids),
            )
    return agent_ids


def expire_stale_sessions(*, current: datetime | None = None) -> list[str]:
    now = _utc_now(current)
    cutoff = _session_timestamp(now - timedelta(seconds=SESSION_STALE_SECONDS))
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """SELECT session_id FROM sessions
               WHERE status='active' AND last_heartbeat<=?""",
            (cutoff,),
        ).fetchall()
        session_ids = [str(row["session_id"]) for row in rows]
        if session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            conn.execute(
                f"UPDATE sessions SET status='expired' WHERE session_id IN ({placeholders})",
                session_ids,
            )
    return session_ids


def reap_expired_tasks(*, current: datetime | None = None) -> list[dict]:
    now = _utc_now(current)
    timestamp = _task_timestamp(now)
    transitions: list[dict] = []
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """SELECT id, tenant_id, retry_count FROM tasks
               WHERE status='running'
                 AND (lease_expires_at IS NULL OR lease_expires_at<=?)
               ORDER BY created_at, id""",
            (timestamp,),
        ).fetchall()
        for row in rows:
            retry_count = int(row["retry_count"] or 0)
            if retry_count < TASK_MAX_RETRIES:
                next_retry = retry_count + 1
                conn.execute(
                    """UPDATE tasks
                       SET status='pending', assigned_agent_id=NULL,
                           delivered_at=NULL, attempt_id=NULL,
                           lease_expires_at=NULL, lease_heartbeat_at=NULL,
                           ack_received_at=NULL, retry_count=?, error=NULL,
                           updated_at=?
                       WHERE id=? AND status='running'
                         AND (lease_expires_at IS NULL OR lease_expires_at<=?)""",
                    (next_retry, timestamp, row["id"], timestamp),
                )
                transitions.append(
                    {
                        "task_id": str(row["id"]),
                        "tenant_id": str(row["tenant_id"]),
                        "status": "pending",
                        "retry_count": next_retry,
                    }
                )
            else:
                message = "task lease expired after the configured retry limit"
                result = json.dumps(
                    {"output": {}, "logs": message, "duration_s": 0},
                    sort_keys=True,
                    separators=(",", ":"),
                )
                conn.execute(
                    """UPDATE tasks
                       SET status='failed', result_json=?, error=?,
                           lease_expires_at=NULL, lease_heartbeat_at=NULL,
                           response_received_at=?, updated_at=?
                       WHERE id=? AND status='running'
                         AND (lease_expires_at IS NULL OR lease_expires_at<=?)""",
                    (result, message, timestamp, timestamp, row["id"], timestamp),
                )
                transitions.append(
                    {
                        "task_id": str(row["id"]),
                        "tenant_id": str(row["tenant_id"]),
                        "status": "failed",
                        "retry_count": retry_count,
                    }
                )
    return transitions


async def publish_task_transitions(transitions: list[dict]) -> None:
    if not transitions:
        return
    from ws_broker import get_broker

    broker = get_broker()
    for item in transitions:
        await broker.publish(
            f"task:{item['tenant_id']}:{item['task_id']}",
            {
                "type": "task.status",
                "payload": {
                    "task_id": item["task_id"],
                    "status": item["status"],
                    "retry_count": item["retry_count"],
                },
            },
        )


async def run_maintenance_once(*, current: datetime | None = None) -> dict:
    stale_agents = expire_stale_agents(current=current)
    stale_sessions = expire_stale_sessions(current=current)
    task_transitions = reap_expired_tasks(current=current)
    await publish_task_transitions(task_transitions)
    return {
        "stale_agents": len(stale_agents),
        "stale_sessions": len(stale_sessions),
        "task_transitions": len(task_transitions),
    }


async def maintenance_loop() -> None:
    while True:
        try:
            await run_maintenance_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Readiness continues to expose database/broker failures. The loop
            # must survive a transient lock or broker outage and retry later.
            _log.warning(
                "maintenance_pass_failed",
                extra={"error_kind": type(exc).__name__},
            )
        await asyncio.sleep(MAINTENANCE_INTERVAL_SECONDS)


async def stop_maintenance(task: asyncio.Task | None) -> None:
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
