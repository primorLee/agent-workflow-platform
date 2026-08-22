"""Local-first FastAPI entrypoint for the Agent Workflow Platform."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from config import HOST, runtime_bind_matches_config, validate_startup_security
from database import init_db
from middleware import RateLimitMiddleware, RequestLoggingMiddleware
from observability import (
    MetricsMiddleware,
    RequestIDMiddleware,
    get_metrics_response,
    new_request_id,
    setup_structured_logging,
)
from routes import agents_router, events_router, health_router, sessions_router, tasks_router, worker_router
from ws_broker import get_broker

_bind_logger = logging.getLogger("awp.control_plane.bind_guard")

validate_startup_security()
setup_structured_logging(os.getenv("AWP_LOG_LEVEL", "INFO"))
init_db()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    broker = get_broker()
    await broker.initialize()
    try:
        yield
    finally:
        await broker.close()


app = FastAPI(
    title="Agent Workflow Platform Control Plane",
    version="0.1.0",
    description="Local-first control plane extracted from a production agent workflow system.",
    lifespan=lifespan,
)
app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(MetricsMiddleware)


@app.middleware("http")
async def enforce_runtime_bind(request: Request, call_next):
    """Reject requests when the actual socket host bypasses validated config."""
    server = request.scope.get("server")
    actual_host = (
        server[0]
        if isinstance(server, (tuple, list))
        and server
        and isinstance(server[0], str)
        else ""
    )
    if not runtime_bind_matches_config(actual_host):
        request_id = new_request_id()
        _bind_logger.warning(
            "runtime_bind_rejected",
            extra={
                "error_kind": "binding_mismatch",
                "request_id": request_id,
            },
        )
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "service_unavailable",
                    "message": "Runtime binding does not match validated configuration",
                }
            },
            headers={"X-Request-ID": request_id},
        )
    return await call_next(request)
app.include_router(health_router, prefix="/v1/health", tags=["health"])
app.include_router(agents_router, prefix="/v1/agent", tags=["agents"])
app.include_router(worker_router, prefix="/v1/agent", tags=["worker"])
app.include_router(tasks_router, prefix="/v1/tasks", tags=["tasks"])
app.include_router(events_router, prefix="/v1/events", tags=["events"])
app.include_router(sessions_router, prefix="/v1/sessions", tags=["sessions"])


@app.get("/health", include_in_schema=False)
def health_alias():
    """Conventional liveness endpoint for local orchestrators."""
    return {"status": "ok"}


@app.get("/")
def root():
    return {"name": "Agent Workflow Platform", "docs": "/docs", "health": "/v1/health/ready"}


@app.get("/metrics")
def metrics(request: Request):
    return get_metrics_response(request)


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=HOST,
        port=int(os.getenv("AWP_PORT", "8100")),
        access_log=False,
        log_config=None,
    )
