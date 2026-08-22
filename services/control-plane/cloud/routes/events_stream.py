from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from auth import require_dev_key
from database import get_db
from routes.tasks import _task_channel
from ws_broker import get_broker

router = APIRouter()


def _sse(event: str, payload: dict) -> bytes:
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event}\ndata: {encoded}\n\n".encode("utf-8")


@router.get("/tasks/{task_id}")
async def stream_task_events(
    task_id: str,
    request: Request,
    max_events: int = Query(default=0, ge=0, le=100),
    tenant_id: str = Depends(require_dev_key),
):
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, status, updated_at FROM tasks WHERE id=? AND tenant_id=?",
            (task_id, tenant_id),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "task not found")

    channel = _task_channel(tenant_id, task_id)
    broker = get_broker()

    async def generate():
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)

        async def receive(envelope: dict) -> None:
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(envelope)

        subscribed = False
        sent = 0
        try:
            await broker.subscribe(channel, receive)
            subscribed = True
            # Subscribe before the authoritative snapshot read. A transition
            # racing this read is therefore either reflected in the snapshot,
            # queued as an event, or both; it cannot disappear in between.
            with get_db() as conn:
                current = conn.execute(
                    "SELECT id, status, updated_at FROM tasks WHERE id=? AND tenant_id=?",
                    (task_id, tenant_id),
                ).fetchone()
            if current is None:
                return
            yield _sse(
                "snapshot",
                {
                    "task_id": current["id"],
                    "status": current["status"],
                    "updated_at": current["updated_at"],
                },
            )
            sent += 1
            if max_events and sent >= max_events:
                return

            while not await request.is_disconnected():
                try:
                    envelope = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    continue
                event = str(envelope.get("type") or "task.status")
                payload = envelope.get("payload")
                if not isinstance(payload, dict):
                    payload = {"status": "unknown"}
                yield _sse(event, payload)
                sent += 1
                if max_events and sent >= max_events:
                    return
        finally:
            if subscribed:
                await broker.unsubscribe(channel, receive)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
