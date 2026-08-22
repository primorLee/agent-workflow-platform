"""Security-bounded HTTP middleware for the public control-plane."""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import logging
import os
import time
from collections import OrderedDict, deque
from threading import Lock
from typing import Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

try:
    from observability import _route_template, _safe_method
    from safe_log import error_kind, peer_class
except ImportError:  # pragma: no cover - package import in tooling
    from cloud.observability import _route_template, _safe_method
    from cloud.safe_log import error_kind, peer_class


logger = logging.getLogger("awp.control_plane")
_LOOPBACK_PROXY_PEERS = frozenset(
    {"127.0.0.1", "::1", "::ffff:7f00:1"}
)
_MAX_LIMITER_KEYS = 10_000
_REDIS_COOLDOWN_SECONDS = 5.0


def _normalize_ip(value: object) -> str | None:
    candidate = str(value or "").strip()
    if not candidate or len(candidate) > 64:
        return None
    candidate = candidate.removeprefix("[").removesuffix("]").split("%", 1)[0]
    try:
        return ipaddress.ip_address(candidate).compressed
    except ValueError:
        return None


def _load_trusted_proxies() -> set[str]:
    """Load only valid, explicit proxy peer addresses."""
    raw = os.getenv(
        "AWP_TRUSTED_PROXIES", os.getenv("TRUSTED_PROXIES", "")
    ).strip()
    proxies = {
        normalized
        for part in raw.split(",")
        if (normalized := _normalize_ip(part)) is not None
    }
    proxies.update(_LOOPBACK_PROXY_PEERS)
    return proxies


def _get_real_ip(request: Request) -> str:
    """Resolve a validated peer IP without trusting forwarding headers globally."""
    direct = _normalize_ip(request.client.host if request.client else None)
    direct = direct or "unknown"
    if direct not in _load_trusted_proxies():
        return direct

    real_ip = _normalize_ip(request.headers.get("x-real-ip", ""))
    if real_ip is not None:
        return real_ip

    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        # A trusted ingress appends the address it observed. Attacker-supplied
        # entries, if preserved, precede this final value.
        forwarded_ip = _normalize_ip(forwarded.split(",")[-1])
        if forwarded_ip is not None:
            return forwarded_ip
    return direct


class InMemoryRateLimiter:
    """Bounded, thread-safe process-local sliding-window limiter."""

    def __init__(
        self,
        *,
        max_keys: int = _MAX_LIMITER_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._lock = Lock()
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._max_keys = max(1, min(int(max_keys), _MAX_LIMITER_KEYS))
        self._clock = clock

    @property
    def key_count(self) -> int:
        with self._lock:
            return len(self._hits)

    def acquire(self, key: str, limit: int, window: int) -> tuple[bool, int]:
        limit = max(1, int(limit))
        window = max(1, int(window))
        now = self._clock()
        cutoff = now - window
        with self._lock:
            hits = self._hits.pop(key, deque())
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= limit:
                self._hits[key] = hits
                retry_after = max(1, int(hits[0] + window - now) + 1)
                return False, retry_after
            hits.append(now)
            self._hits[key] = hits
            while len(self._hits) > self._max_keys:
                self._hits.popitem(last=False)
            return True, 0


class RedisRateLimiter:
    """Atomic Redis limiter with a bounded process-local failover window."""

    _ACQUIRE_SCRIPT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
"""

    def __init__(
        self,
        client,
        *,
        fallback: InMemoryRateLimiter | None = None,
        cooldown_seconds: float = _REDIS_COOLDOWN_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._fallback = fallback or InMemoryRateLimiter()
        self._cooldown_seconds = max(1.0, min(float(cooldown_seconds), 30.0))
        self._clock = clock
        self._state_lock = Lock()
        self._unavailable_until = 0.0

    @property
    def unavailable_until(self) -> float:
        with self._state_lock:
            return self._unavailable_until

    def acquire(self, key: str, limit: int, window: int) -> tuple[bool, int]:
        now = self._clock()
        with self._state_lock:
            unavailable = now < self._unavailable_until
        if unavailable:
            return self._fallback.acquire(key, limit, window)

        bucket = int(time.time()) // max(1, int(window))
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
        redis_key = f"awp:rate_limit:{digest}:{bucket}"
        try:
            result = self._client.eval(
                self._ACQUIRE_SCRIPT, 1, redis_key, max(1, int(window))
            )
            count = int(result[0])
            ttl = int(result[1])
            if ttl <= 0:
                raise RuntimeError("rate limiter ttl missing")
            return count <= limit, ttl if count > limit else 0
        except Exception as exc:
            with self._state_lock:
                self._unavailable_until = max(
                    self._unavailable_until,
                    now + self._cooldown_seconds,
                )
            logger.warning(
                "redis_rate_limiter_fallback",
                extra={"error_kind": error_kind(exc)},
            )
            # Backend failure must not become fail-open: apply the bounded
            # process-local policy to this very request.
            return self._fallback.acquire(key, limit, window)


def _build_rate_limiter():
    fallback = InMemoryRateLimiter()
    url = os.getenv("AWP_REDIS_URL", os.getenv("REDIS_URL", "")).strip()
    if not url:
        return fallback
    try:
        import redis

        client = redis.Redis.from_url(
            url,
            socket_timeout=2,
            socket_connect_timeout=2,
            retry_on_timeout=False,
        )
        # Connectivity is checked lazily inside a worker thread on first use;
        # importing the ASGI app must never block an event loop on sync Redis.
        return RedisRateLimiter(client, fallback=fallback)
    except Exception as exc:
        logger.warning(
            "redis_rate_limiter_setup_fallback",
            extra={"error_kind": error_kind(exc)},
        )
        return fallback


_rate_limiter = _build_rate_limiter()
_RATE_LIMITS = {
    "auth": (30, 60),
    "agent": (120, 60),
    "default": (120, 60),
}
_EXEMPT_PATHS = frozenset(
    {
        "/",
        "/health",
        "/v1/health/live",
        "/v1/health/ready",
        "/docs",
        "/openapi.json",
    }
)


def _classify_request(path: str) -> str:
    if path.startswith("/v1/auth"):
        return "auth"
    if path.startswith("/v1/agent"):
        return "agent"
    return "default"


def _peer_identity(request: Request) -> str:
    peer = _get_real_ip(request)
    return "peer:" + hashlib.sha256(peer.encode("utf-8")).hexdigest()[:24]


def _credential_identity(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    token = (
        authorization[7:].strip()
        if authorization.startswith("Bearer ")
        else request.headers.get("x-api-key", "").strip()
    )
    if not token:
        return None
    return "credential:" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]


def enforce_rate_limit(
    identity: str, max_requests: int, window: float
) -> tuple[bool, int]:
    return _rate_limiter.acquire(identity, max_requests, int(window))


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if (
            request.method == "OPTIONS"
            or request.url.path in _EXEMPT_PATHS
        ):
            return await call_next(request)

        bucket = _classify_request(request.url.path)
        limit, window = _RATE_LIMITS[bucket]
        peer_identity = _peer_identity(request)
        identities = [peer_identity]
        credential_identity = _credential_identity(request)
        if credential_identity and credential_identity != peer_identity:
            identities.append(credential_identity)

        denied = False
        retry_after = 0
        for identity in identities:
            # Redis-py is synchronous in this module. Always call through a
            # worker thread, including the local fallback for one uniform path.
            allowed, wait_seconds = await asyncio.to_thread(
                enforce_rate_limit, identity, limit, window
            )
            if not allowed:
                denied = True
                retry_after = max(1, retry_after, wait_seconds)
                break

        if denied:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "code": "rate_limited",
                        "message": "Too many requests",
                    }
                },
                headers={"Retry-After": str(retry_after)},
            )
        return await call_next(request)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        started = time.perf_counter()
        status = 500
        failure = "none"
        try:
            response: Response = await call_next(request)
            status = int(response.status_code)
            return response
        except Exception as exc:
            failure = error_kind(exc)
            raise
        finally:
            logger.info(
                "http_request",
                extra={
                    "method": _safe_method(request.method),
                    "route": _route_template(request),
                    "status": status,
                    "elapsed_ms": round(
                        max(0.0, time.perf_counter() - started) * 1000, 1
                    ),
                    "peer_class": peer_class(_get_real_ip(request)),
                    "request_id": getattr(request.state, "request_id", ""),
                    "error_kind": failure,
                },
            )


def install_middleware(app: FastAPI) -> None:
    """Install generic request logging and abuse protection."""
    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(RateLimitMiddleware)
