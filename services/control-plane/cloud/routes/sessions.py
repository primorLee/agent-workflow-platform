from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import require_dev_key
from session_manager import SessionManager

router = APIRouter()
_manager = SessionManager()


class CreateSessionRequest(BaseModel):
    session_type: str = "interactive"
    metadata: dict = Field(default_factory=dict)


@router.post("")
def create_session(body: CreateSessionRequest, user_id: str = Depends(require_dev_key)):
    try:
        return _manager.create_session(user_id, body.session_type, body.metadata).to_dict()
    except (ValueError, PermissionError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("")
def list_sessions(user_id: str = Depends(require_dev_key)):
    return [session.to_dict() for session in _manager.list_user_sessions(user_id)]


@router.post("/{session_id}/heartbeat")
def heartbeat(session_id: str, user_id: str = Depends(require_dev_key)):
    if not _manager.heartbeat(session_id, user_id):
        raise HTTPException(404, "session not found")
    return {"ok": True}


@router.delete("/{session_id}")
def terminate(
    session_id: str,
    reason: str = Query(
        default="user_request",
        min_length=1,
        max_length=128,
        pattern=r"[a-z0-9_-]+",
    ),
    user_id: str = Depends(require_dev_key),
):
    if not _manager.terminate(session_id, user_id, reason):
        raise HTTPException(404, "session not found")
    return {"ok": True}