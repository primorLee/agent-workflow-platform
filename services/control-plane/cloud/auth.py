"""Bearer-token authentication for the local-first control plane."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Annotated

from fastapi import Header, HTTPException

from config import DEV_API_KEY
from database import get_db


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_agent_token() -> str:
    return "awp_agent_" + secrets.token_urlsafe(32)


def _bearer_token(authorization: str | None) -> str:
    value = authorization or ""
    if not value.startswith("Bearer "):
        return ""
    return value[7:].strip()


def require_dev_key(authorization: Annotated[str | None, Header()] = None) -> str:
    if not DEV_API_KEY:
        raise HTTPException(503, "control-plane API key is not configured")
    supplied = _bearer_token(authorization)
    if not supplied or not hmac.compare_digest(supplied, DEV_API_KEY):
        raise HTTPException(401, "invalid control-plane API key")
    return "local"


def require_agent(authorization: Annotated[str | None, Header()] = None) -> dict:
    token = _bearer_token(authorization)
    if not token:
        raise HTTPException(401, "missing agent token")
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM agents WHERE token_hash=?", (hash_token(token),)
        ).fetchone()
    if row is None:
        raise HTTPException(401, "invalid agent token")
    return dict(row)
