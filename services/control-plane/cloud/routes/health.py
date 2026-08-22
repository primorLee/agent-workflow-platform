from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from database import get_db
from ws_broker import broker_health

router = APIRouter()


@router.get("/live")
def live():
    return {"status": "ok"}


@router.get("/ready")
async def ready():
    with get_db() as conn:
        conn.execute("SELECT 1").fetchone()
    broker = await broker_health()
    payload = {"status": "ok", "database": "ok", "broker": broker}
    if broker.get("backend") == "redis" and not broker.get("redis_connected"):
        payload["status"] = "unavailable"
        return JSONResponse(status_code=503, content=payload)
    return payload