from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth import hash_token, new_agent_token, require_agent, require_dev_key
from database import get_db

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RegisterRequest(BaseModel):
    hostname: str = Field(min_length=1, max_length=255)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    version: str = ""


class HeartbeatRequest(BaseModel):
    status: str = "idle"
    running_tasks: list[str] = Field(default_factory=list)
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
    with get_db() as conn:
        conn.execute(
            """UPDATE agents SET status=?, capabilities_json=?, last_heartbeat=? WHERE id=?""",
            (body.status, json.dumps(body.capabilities), _now(), agent["id"]),
        )
    return {"ok": True, "agent_id": agent["id"]}