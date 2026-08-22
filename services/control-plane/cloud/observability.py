"""Wired HTTP observability for the public control-plane.

The module deliberately contains only facilities that :mod:`server` installs:
server-minted request IDs, bounded structured logs, HTTP Prometheus metrics,
and the guarded ``/metrics`` response. Metrics for retired product services
and the unused OpenTelemetry/decorator layer do not belong in this public core.
"""

from __future__ import annotations

import contextvars
import hmac
import json
import logging
import os
import re
import time
import uuid
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.middleware.base import BaseHTTPMiddleware

try:
    from safe_log import error_kind
except ImportError:  # pragma: no cover - package import in tooling
    from cloud.safe_log import error_kind


request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default=""
)

_REQUEST_ID_HEADER = "X-Request-ID"
_REDACTED = "[REDACTED]"
_UNMATCHED_ROUTE = "unmatched"
_MAX_LOG_TEXT = 512
_SAFE_METHODS = frozenset(
    {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}
)
_SENSITIVE_KEYS = frozenset(
    {
        "authorization",
        "password",
        "passwd",
        "api-key",
        "apikey",
        "token",
        "access-token",
        "refresh-token",
        "secret",
        "client-secret",
        "credential",
        "credentials",
        "x-api-key",
        "cookie",
        "set-cookie",
    }
)
_PLACEHOLDER_RE = re.compile(
    r"%(?:\([^)]+\))?[#0 +\-]?(?:\d+|\*)?(?:\.\d+)?[diouxXeEfFgGcrsa%]|\{[^{}]*\}"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|cookie)\s*[:=]\s*[^\s,;]+"
)
_URL_RE = re.compile(r"(?i)\b(https?|redis|rediss)://[^\s]+")
_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b"
)
_KEY_TOKEN_RE = re.compile(
    r"\b(?:sk|pk|api|key|tok)[-_][A-Za-z0-9_-]{8,}\b", re.IGNORECASE
)
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", re.IGNORECASE
)


def new_request_id() -> str:
    """Return an opaque, low-cardinality-safe server request ID."""
    return uuid.uuid4().hex[:16]


# Backward-compatible private name for the existing regression probe.
_new_request_id = new_request_id


def _is_sensitive_key(value: object) -> bool:
    if not isinstance(value, str):
        return False
    normalized = value.strip().lower().replace("_", "-")
    if normalized in _SENSITIVE_KEYS:
        return True
    return normalized.endswith(("-token", "-secret", "-password", "-credential"))


def _safe_text(value: object, *, limit: int = _MAX_LOG_TEXT) -> str:
    """Bound and scrub free text before it reaches a log sink.

    URLs are reduced to their scheme because userinfo, path and query strings
    are not safe observability dimensions. Formatting arguments are never
    interpolated by :class:`JsonLineFormatter`; this is the final defense for
    f-strings and direct messages.
    """
    text = (
        str(value)
        .replace("\r", " ")
        .replace("\n", " ")
        .replace("\x00", " ")
    )
    if _PRIVATE_KEY_RE.search(text):
        return _REDACTED
    text = _BEARER_RE.sub("Bearer [REDACTED]", text)
    text = _ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}=[REDACTED]", text
    )
    text = _JWT_RE.sub(_REDACTED, text)
    text = _KEY_TOKEN_RE.sub(_REDACTED, text)
    text = _URL_RE.sub(
        lambda match: f"{match.group(1).lower()}://[REDACTED]", text
    )
    if len(text) > limit:
        text = text[:limit] + "..."
    return text


def redact(obj: Any) -> Any:
    """Recursively redact secret-bearing fields and scrub string values."""
    if isinstance(obj, dict):
        out: dict[Any, Any] = {}
        for index, (key, value) in enumerate(obj.items()):
            if index >= 50:
                break
            out[key] = _REDACTED if _is_sensitive_key(key) else redact(value)
        return out
    if isinstance(obj, (list, tuple)):
        return [redact(value) for value in obj[:20]]
    if isinstance(obj, str):
        return _safe_text(obj)
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    return _safe_text(type(obj).__name__)


def _message_template(record: logging.LogRecord) -> str:
    """Return a scrubbed static log event, never interpolated user data."""
    if record.exc_info:
        # Even an f-string can inline ``str(exc)`` before logging sees it.
        # Exception records therefore use a fixed event plus ``error_kind``.
        return "exception"
    try:
        if isinstance(record.msg, str):
            template = record.msg
        else:
            template = json.dumps(redact(record.msg), ensure_ascii=False)
    except Exception:  # pragma: no cover - hostile LogRecord object
        return "log_format_error"
    if record.args:
        template = _PLACEHOLDER_RE.sub("?", template)
    return _safe_text(template)


class JsonLineFormatter(logging.Formatter):
    """Emit one bounded JSON object per line without raw exception text."""

    _STANDARD_ATTRIBUTES = frozenset(
        {
            "name", "msg", "args", "levelname", "levelno", "pathname",
            "filename", "module", "exc_info", "exc_text", "stack_info",
            "lineno", "funcName", "created", "msecs", "relativeCreated",
            "thread", "threadName", "processName", "process", "message",
            "taskName",
        }
    )

    def format(self, record: logging.LogRecord) -> str:
        stamp = time.strftime(
            "%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)
        )
        stamp = f"{stamp}.{int(record.msecs):03d}Z"
        known_levels = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"}
        payload: dict[str, Any] = {
            "timestamp": stamp,
            "level": record.levelname if record.levelname in known_levels else "UNKNOWN",
            "logger": _safe_text(record.name, limit=128),
            "message": _message_template(record),
        }
        request_id = request_id_var.get()
        if request_id:
            payload["request_id"] = request_id

        if record.exc_info and record.exc_info[1] is not None:
            # Never serialize formatException()/str(exc): exception messages and
            # tracebacks routinely contain URLs, credentials and customer data.
            payload["error_kind"] = error_kind(record.exc_info[1])

        for key, value in record.__dict__.items():
            if key in self._STANDARD_ATTRIBUTES or key.startswith("_"):
                continue
            try:
                payload[key] = _REDACTED if _is_sensitive_key(key) else redact(value)
            except Exception:
                payload[key] = "[UNAVAILABLE]"

        try:
            return json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            )
        except Exception:
            # Never let logging's own error handler dump the original LogRecord,
            # whose args/extras may contain the very secret we refused to emit.
            return json.dumps(
                {
                    "timestamp": stamp,
                    "level": "ERROR",
                    "logger": "awp.logging",
                    "message": "log_serialization_error",
                },
                separators=(",", ":"),
            )


def setup_structured_logging(level: str | int | None = None) -> None:
    """Install the single safe application log sink and disable access logs."""
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
    access.disabled = True

    if os.getenv("AWP_STRUCTURED_LOGS", "1").strip() == "0":
        return
    if level is None:
        level = os.getenv("AWP_LOG_LEVEL", "INFO").upper()

    root = logging.getLogger()
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLineFormatter())
    for existing in list(root.handlers):
        if isinstance(existing, logging.StreamHandler):
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error"):
        target = logging.getLogger(name)
        target.handlers = []
        target.propagate = True


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Mint a fresh request ID for every request.

    Client ``X-Request-ID`` is intentionally ignored: reflecting it creates a
    log-correlation injection surface and lets an attacker select log keys.
    """

    async def dispatch(self, request: Request, call_next):
        request_id = new_request_id()
        request.state.request_id = request_id
        token = request_id_var.set(request_id)
        try:
            response: Response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers[_REQUEST_ID_HEADER] = request_id
        return response


_PROM_AVAILABLE = True
try:
    from prometheus_client import (  # type: ignore[import-not-found]
        CONTENT_TYPE_LATEST,
        REGISTRY,
        Counter,
        Histogram,
        generate_latest,
    )
except ImportError:
    _PROM_AVAILABLE = False
    Counter = Histogram = None  # type: ignore[assignment]
    generate_latest = None  # type: ignore[assignment]
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"
    REGISTRY = None  # type: ignore[assignment]


def _make_metric(factory, name: str, doc: str, labels: list[str]):
    """Create or reuse a metric across flat and package-style imports."""
    if not _PROM_AVAILABLE:
        return None
    try:
        return factory(name, doc, labels)
    except ValueError:
        names = getattr(REGISTRY, "_names_to_collectors", {})
        existing = names.get(name)
        if existing is None and name.endswith("_total"):
            existing = names.get(name.removesuffix("_total"))
        if existing is not None:
            return existing
        stripped = name.removesuffix("_total")
        for collector in getattr(REGISTRY, "_collector_to_names", {}):
            if getattr(collector, "_name", None) in {name, stripped}:
                return collector
        return None


HTTP_REQUESTS_TOTAL = (
    _make_metric(
        Counter,
        "http_requests_total",
        "Total HTTP requests",
        ["method", "route", "status", "error_kind"],
    )
    if _PROM_AVAILABLE
    else None
)
HTTP_REQUEST_DURATION = (
    _make_metric(
        Histogram,
        "http_request_duration_seconds",
        "HTTP request duration in seconds",
        ["method", "route", "error_kind"],
    )
    if _PROM_AVAILABLE
    else None
)


def _safe_method(method: object) -> str:
    candidate = str(method).upper()
    return candidate if candidate in _SAFE_METHODS else "OTHER"


def _safe_status(value: object) -> str:
    try:
        status = int(value)
    except (TypeError, ValueError):
        return "other"
    return str(status) if 100 <= status <= 599 else "other"


def _route_template(request: Request) -> str:
    """Return the matched application template only, never a request path."""
    route = request.scope.get("route")
    template = getattr(route, "path", None)
    if (
        not isinstance(template, str)
        or not template.startswith("/")
        or len(template) > 200
    ):
        return _UNMATCHED_ROUTE
    # Route definitions are code-owned, but constrain characters as a final
    # cardinality boundary in case a third-party router mutates the scope.
    if not re.fullmatch(r"/[A-Za-z0-9_./{}:-]*", template):
        return _UNMATCHED_ROUTE
    return template


class MetricsMiddleware(BaseHTTPMiddleware):
    """Record bounded HTTP metrics after Starlette resolves the route."""

    async def dispatch(self, request: Request, call_next):
        if not _PROM_AVAILABLE or request.url.path == "/metrics":
            return await call_next(request)

        method = _safe_method(request.method)
        started = time.perf_counter()
        status = "500"
        failure = "none"
        try:
            response: Response = await call_next(request)
            status = _safe_status(response.status_code)
            return response
        except Exception as exc:
            failure = error_kind(exc)
            raise
        finally:
            route = _route_template(request)
            elapsed = max(0.0, time.perf_counter() - started)
            try:
                if HTTP_REQUEST_DURATION is not None:
                    HTTP_REQUEST_DURATION.labels(
                        method=method, route=route, error_kind=failure
                    ).observe(elapsed)
                if HTTP_REQUESTS_TOTAL is not None:
                    HTTP_REQUESTS_TOTAL.labels(
                        method=method,
                        route=route,
                        status=status,
                        error_kind=failure,
                    ).inc()
            except Exception:
                # Observability cannot change application availability.
                pass


def _client_ip(request: Request) -> str:
    try:
        from middleware import _get_real_ip
    except ImportError:  # pragma: no cover - package import in tooling
        from cloud.middleware import _get_real_ip
    return _get_real_ip(request)


def _metrics_bearer_ok(request: Request) -> bool:
    configured = os.getenv(
        "AWP_METRICS_BEARER_TOKEN", os.getenv("METRICS_BEARER_TOKEN", "")
    ).strip()
    if not configured:
        return True
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        return False
    presented = authorization[7:].strip()
    return bool(presented) and hmac.compare_digest(presented, configured)


def _metrics_allowed(request: Request) -> bool:
    raw = os.getenv(
        "AWP_METRICS_ALLOW_IPS",
        os.getenv("METRICS_ALLOW_IPS", "127.0.0.1,::1"),
    ).strip()
    allowed = {entry.strip() for entry in raw.split(",") if entry.strip()}
    return "*" in allowed or _client_ip(request) in allowed


def get_metrics_response(request: Request) -> Response:
    """Return guarded Prometheus exposition without reflecting credentials."""
    if os.getenv("AWP_PROMETHEUS_ENABLED", "1").strip() == "0":
        return JSONResponse(status_code=404, content={"error": "not_found"})
    if not _PROM_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"error": "prometheus_client_unavailable"},
        )
    if not _metrics_bearer_ok(request) or not _metrics_allowed(request):
        return JSONResponse(status_code=403, content={"error": "forbidden"})
    body = generate_latest()  # type: ignore[misc]
    return PlainTextResponse(content=body, media_type=CONTENT_TYPE_LATEST)


__all__ = [
    "HTTP_REQUESTS_TOTAL",
    "HTTP_REQUEST_DURATION",
    "JsonLineFormatter",
    "MetricsMiddleware",
    "RequestIDMiddleware",
    "get_metrics_response",
    "new_request_id",
    "redact",
    "request_id_var",
    "setup_structured_logging",
]
