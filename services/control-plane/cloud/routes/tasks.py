from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import require_agent, require_dev_key
from database import get_db
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


class CreateTaskRequest(BaseModel):
    task_type: str = Field(default="command", min_length=1, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=255)


class TaskResultRequest(BaseModel):
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
                json.dumps(body.payload),
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
async def pending_alias(agent: dict = Depends(require_agent)):
    return await claim_pending(agent)


async def claim_pending(agent: dict) -> list[dict]:
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """SELECT * FROM tasks
               WHERE tenant_id=? AND status='pending'
               ORDER BY created_at LIMIT 10""",
            (agent["tenant_id"],),
        ).fetchall()
        now = _now()
        for row in rows:
            conn.execute(
                """UPDATE tasks SET status='running', assigned_agent_id=?, delivered_at=?, updated_at=?
                   WHERE id=? AND status='pending'""",
                (agent["id"], now, now, row["id"]),
            )
        claimed = [dict(row) for row in rows]
    for row in claimed:
        await _publish_task_status(agent["tenant_id"], row["id"], "running")
    return [
        {
            "id": row["id"],
            "type": row["task_type"],
            "payload": json.loads(row["payload_json"] or "{}"),
            "status": "running",
            "created_at": row["created_at"],
        }
        for row in claimed
    ]




@worker_router.post("/tasks/{task_id}/result")
async def submit_result(task_id: str, body: TaskResultRequest, agent: dict = Depends(require_agent)):
    terminal = "success" if body.status == "success" else "failed"
    payload = {"output": body.output, "logs": body.logs, "duration_s": body.duration_s}
    with get_db() as conn:
        cur = conn.execute(
            """UPDATE tasks SET status=?, result_json=?, error=?, response_received_at=?, updated_at=?
               WHERE id=? AND tenant_id=? AND assigned_agent_id=?""",
            (
                terminal,
                json.dumps(payload),
                "" if terminal == "success" else body.logs[-2000:],
                _now(),
                _now(),
                task_id,
                agent["tenant_id"],
                agent["id"],
            ),
        )
    if not cur.rowcount:
        raise HTTPException(404, "assigned task not found")
    await _publish_task_status(agent["tenant_id"], task_id, terminal)
    return {"ok": True, "task_id": task_id, "status": terminal}
