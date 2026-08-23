from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import require_agent, require_dev_key
from config import TASK_LEASE_SECONDS
from database import get_db
from maintenance import publish_task_transitions, reap_expired_tasks
from ws_broker import get_broker

router = APIRouter()
worker_router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _task_channel(tenant_id: str, task_id: str) -> str:
    return f"task:{tenant_id}:{task_id}"


async def _publish_task_status(tenant_id: str, task_id: str, status: str) -> None:
    await get_broker().publish(
        _task_channel(tenant_id, task_id),
        {
            "type": "task.status",
            "payload": {"task_id": task_id, "status": status},
        },
    )


def _encode_json(value: dict[str, Any], *, label: str, canonical: bool = False) -> str:
    try:
        return json.dumps(
            value,
            allow_nan=False,
            sort_keys=canonical,
            separators=(",", ":") if canonical else None,
        )
    except (TypeError, ValueError, RecursionError):
        raise HTTPException(422, f"{label} must be finite JSON") from None


class CreateTaskRequest(BaseModel):
    task_type: str = Field(default="command", min_length=1, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=255)


class TaskResultRequest(BaseModel):
    attempt_id: str = Field(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    status: Literal["success", "failed", "error", "cancelled"]
    output: dict[str, Any] = Field(default_factory=dict)
    logs: str = Field(default="", max_length=1_000_000)
    duration_s: float = Field(default=0, ge=0)


@router.post("")
async def create_task(body: CreateTaskRequest, tenant_id: str = Depends(require_dev_key)):
    task_id = str(uuid.uuid4())
    created = False
    with get_db() as conn:
        # SQLite's write lock makes the read-then-insert one atomic operation
        # across processes; the partial unique index is the final invariant.
        conn.execute("BEGIN IMMEDIATE")
        if body.idempotency_key is not None:
            existing = conn.execute(
                "SELECT * FROM tasks WHERE tenant_id=? AND idempotency_key=?",
                (tenant_id, body.idempotency_key),
            ).fetchone()
            if existing is not None:
                return _task_out(existing)
        now = _now()
        conn.execute(
            """INSERT INTO tasks
               (id, tenant_id, task_type, payload_json, idempotency_key, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
            (
                task_id,
                tenant_id,
                body.task_type,
                _encode_json(body.payload, label="task payload"),
                body.idempotency_key,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        created = True
    if created:
        await _publish_task_status(tenant_id, task_id, "pending")
    return _task_out(row)


def _task_out(row) -> dict:
    out = dict(row)
    out["payload"] = json.loads(out.pop("payload_json") or "{}")
    if out.get("result_json"):
        out["result"] = json.loads(out["result_json"])
    out.pop("token_hash", None)
    return out


@router.get("")
def list_tasks(status: str | None = Query(default=None), tenant_id: str = Depends(require_dev_key)):
    with get_db() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE tenant_id=? AND status=? ORDER BY created_at DESC",
                (tenant_id, status),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE tenant_id=? ORDER BY created_at DESC", (tenant_id,)
            ).fetchall()
    return [_task_out(row) for row in rows]


@router.get("/{task_id}")
def get_task(task_id: str, tenant_id: str = Depends(require_dev_key)):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE id=? AND tenant_id=?", (task_id, tenant_id)
        ).fetchone()
    if row is None:
        raise HTTPException(404, "task not found")
    return _task_out(row)


@worker_router.get("/tasks/pending")
async def pending_alias(
    slots: int = Query(default=1, ge=1, le=64),
    agent: dict = Depends(require_agent),
):
    if agent.get("status") == "offline":
        raise HTTPException(409, "offline agent must heartbeat before claiming tasks")
    return await claim_pending(agent, slots=slots)


async def claim_pending(agent: dict, *, slots: int = 1) -> list[dict]:
    transitions = reap_expired_tasks()
    await publish_task_transitions(transitions)
    limit = max(1, min(int(slots), 64))
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """SELECT * FROM tasks
               WHERE tenant_id=? AND status='pending'
               ORDER BY created_at, id LIMIT ?""",
            (agent["tenant_id"], limit),
        ).fetchall()
        now_value = datetime.now(timezone.utc)
        now = now_value.isoformat()
        lease_expires_at = (now_value + timedelta(seconds=TASK_LEASE_SECONDS)).isoformat()
        claimed: list[dict] = []
        for row in rows:
            attempt_id = str(uuid.uuid4())
            cur = conn.execute(
                """UPDATE tasks
                   SET status='running', assigned_agent_id=?, delivered_at=?,
                       updated_at=?, attempt_id=?, lease_expires_at=?,
                       lease_heartbeat_at=?, ack_received_at=NULL
                   WHERE id=? AND tenant_id=? AND status='pending'""",
                (
                    agent["id"],
                    now,
                    now,
                    attempt_id,
                    lease_expires_at,
                    now,
                    row["id"],
                    agent["tenant_id"],
                ),
            )
            if cur.rowcount:
                item = dict(row)
                item.update(
                    {
                        "attempt_id": attempt_id,
                        "lease_expires_at": lease_expires_at,
                    }
                )
                claimed.append(item)
    for row in claimed:
        await _publish_task_status(agent["tenant_id"], row["id"], "running")
    return [
        {
            "id": row["id"],
            "type": row["task_type"],
            "payload": json.loads(row["payload_json"] or "{}"),
            "status": "running",
            "created_at": row["created_at"],
            "attempt_id": row["attempt_id"],
            "lease_expires_at": row["lease_expires_at"],
            "retry_count": int(row.get("retry_count") or 0),
        }
        for row in claimed
    ]


@worker_router.post("/tasks/{task_id}/result")
async def submit_result(
    task_id: str,
    body: TaskResultRequest,
    agent: dict = Depends(require_agent),
):
    terminal = "success" if body.status == "success" else "failed"
    payload = {"output": body.output, "logs": body.logs, "duration_s": body.duration_s}
    encoded = _encode_json(payload, label="task result", canonical=True)
    completed_at = _now()
    duplicate = False
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """SELECT status, result_json, attempt_id, assigned_agent_id
               FROM tasks WHERE id=? AND tenant_id=?""",
            (task_id, agent["tenant_id"]),
        ).fetchone()
        if row is None or int(row["assigned_agent_id"] or -1) != int(agent["id"]):
            raise HTTPException(404, "assigned task not found")
        if row["attempt_id"] != body.attempt_id:
            raise HTTPException(409, "stale task attempt")
        if row["status"] in {"success", "failed"}:
            previous = json.loads(row["result_json"] or "{}")
            if row["status"] == terminal and previous == payload:
                duplicate = True
            else:
                raise HTTPException(409, "task already completed with a different result")
        elif row["status"] != "running":
            raise HTTPException(409, "task attempt is not running")
        if not duplicate:
            cur = conn.execute(
                """UPDATE tasks
                   SET status=?, result_json=?, error=?, response_received_at=?,
                       updated_at=?, lease_expires_at=NULL,
                       lease_heartbeat_at=NULL,
                       ack_received_at=COALESCE(ack_received_at, ?)
                   WHERE id=? AND tenant_id=? AND assigned_agent_id=?
                     AND attempt_id=? AND status='running'""",
                (
                    terminal,
                    encoded,
                    "" if terminal == "success" else body.logs[-2000:],
                    completed_at,
                    completed_at,
                    completed_at,
                    task_id,
                    agent["tenant_id"],
                    agent["id"],
                    body.attempt_id,
                ),
            )
            if not cur.rowcount:
                raise HTTPException(409, "task attempt changed during completion")
    if not duplicate:
        await _publish_task_status(agent["tenant_id"], task_id, terminal)
    return {
        "ok": True,
        "task_id": task_id,
        "status": terminal,
        "duplicate": duplicate,
        "attempt_id": body.attempt_id,
    }
