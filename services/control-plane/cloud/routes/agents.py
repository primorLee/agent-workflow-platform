from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import hash_token, new_agent_token, require_agent, require_dev_key
from config import TASK_LEASE_SECONDS
from database import get_db

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RegisterRequest(BaseModel):
    hostname: str = Field(min_length=1, max_length=255)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    version: str = ""


class RunningTaskRef(BaseModel):
    task_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    attempt_id: str = Field(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )


class HeartbeatRequest(BaseModel):
    status: Literal["idle", "busy", "offline"] = "idle"
    running_tasks: list[RunningTaskRef] = Field(default_factory=list, max_length=64)
    capabilities: dict[str, Any] = Field(default_factory=dict)


@router.post("/register")
def register(body: RegisterRequest, tenant_id: str = Depends(require_dev_key)):
    token = new_agent_token()
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO agents
               (tenant_id, hostname, token_hash, status, capabilities_json, version, last_heartbeat)
               VALUES (?, ?, ?, 'idle', ?, ?, ?)""",
            (tenant_id, body.hostname, hash_token(token), json.dumps(body.capabilities), body.version, _now()),
        )
        agent_id = cur.lastrowid
    return {"agent_id": agent_id, "agent_token": token}


@router.post("/heartbeat")
def heartbeat(body: HeartbeatRequest, agent: dict = Depends(require_agent)):
    if body.status != "busy" and body.running_tasks:
        raise HTTPException(422, "running_tasks require busy agent status")
    now_value = datetime.now(timezone.utc)
    now = now_value.isoformat()
    lease_expires_at = (now_value + timedelta(seconds=TASK_LEASE_SECONDS)).isoformat()
    renewed: list[str] = []
    rejected: list[str] = []
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """UPDATE agents SET status=?, capabilities_json=?, last_heartbeat=? WHERE id=?""",
            (body.status, json.dumps(body.capabilities), now, agent["id"]),
        )
        for running in body.running_tasks:
            cur = conn.execute(
                """UPDATE tasks
                   SET lease_expires_at=?, lease_heartbeat_at=?,
                       ack_received_at=COALESCE(ack_received_at, ?), updated_at=?
                   WHERE id=? AND tenant_id=? AND assigned_agent_id=?
                     AND attempt_id=? AND status='running'""",
                (
                    lease_expires_at,
                    now,
                    now,
                    now,
                    running.task_id,
                    agent["tenant_id"],
                    agent["id"],
                    running.attempt_id,
                ),
            )
            (renewed if cur.rowcount else rejected).append(running.task_id)
    return {
        "ok": True,
        "agent_id": agent["id"],
        "renewed_tasks": renewed,
        "rejected_tasks": rejected,
        "lease_expires_at": lease_expires_at if renewed else None,
    }
