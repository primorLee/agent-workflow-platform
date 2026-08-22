"""Agent Workflow Platform Control Plane — WebSocket broker for horizontal scaling.

This module provides a pub/sub abstraction that bridges WebSocket connections
across multiple uvicorn workers. Without it, a task progress event produced in
worker A cannot reach a WS client connected to worker B (and vice versa for
agent task pushes).

Two backends are shipped:

* ``InMemoryBroker`` — explicit default for single-process deployments. Handlers
  are dispatched in-process (no cross-worker). Safe when ``WEB_CONCURRENCY=1``.
* ``RedisBroker`` — uses ``redis.asyncio`` Pub/Sub. A background task subscribes
  to channels and dispatches decoded messages to all locally-registered
  handlers. This is the only backend safe for multi-worker deployments.

Channel naming convention
-------------------------
``ws:user:{user_id}``        — messages targeted at a specific user
``ws:agent:{agent_id}``      — tasks pushed to a specific agent
``ws:task:{job_id}``          — task progress events (owner subscribes)
``ws:broadcast:{topic}``     — global broadcast (use sparingly)

Message envelope
----------------
``{"type": str, "payload": dict, "timestamp": float}``

Design notes
------------
* The broker does **not** replace the per-worker connection dict. Each worker
  keeps ``_connected_agents`` / ``SimProgressManager._connections`` because a
  WS is a persistent TCP-bound object that lives in exactly one worker.
* Instead, senders publish via the broker; every worker dispatches to its own
  locally-held connections (or no-ops if the WS is elsewhere).
* ``redis-py`` is optional for memory mode. Selecting Redis without the
  dependency, a URL, or a live startup connection fails closed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from safe_log import endpoint_label, error_kind, opaque_id

log = logging.getLogger(__name__)

# Handler signature: async callable receiving the decoded envelope dict.
Handler = Callable[[dict], Awaitable[None]]


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------


class WsBroker:
    """Abstract pub/sub broker for WebSocket fan-out across workers."""

    async def initialize(self) -> None:
        """Lazy setup (connect to Redis, start background tasks, etc.)."""
        return None

    async def publish(self, channel: str, message: dict) -> None:
        """Publish an envelope dict on ``channel``.

        Implementations MUST wrap ``message`` in the standard envelope if
        the caller did not already do so (so call sites can pass a naked
        payload and get consistent framing).
        """
        raise NotImplementedError

    async def subscribe(self, channel: str, handler: Handler) -> None:
        """Register ``handler`` to receive envelopes published on ``channel``."""
        raise NotImplementedError

    async def unsubscribe(self, channel: str, handler: Handler) -> None:
        """Remove a previously-registered handler. Silent if not found."""
        raise NotImplementedError

    async def close(self) -> None:
        """Release resources. Idempotent."""
        return None


def _wrap_envelope(message: dict) -> dict:
    """Normalize a naked payload or an explicit typed event exactly once."""
    if not isinstance(message, dict):
        raise TypeError("broker message must be a dictionary")

    if "payload" not in message:
        return {"type": "message", "payload": message, "timestamp": time.time()}

    unknown = set(message) - {"type", "payload", "timestamp"}
    if unknown:
        raise ValueError("typed broker messages contain unsupported fields")
    msg_type = message.get("type", "message")
    if not isinstance(msg_type, str) or not msg_type:
        raise ValueError("broker message type must be a non-empty string")
    payload = message["payload"]
    if not isinstance(payload, dict):
        raise ValueError("broker message payload must be a dictionary")
    timestamp = message.get("timestamp", time.time())
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
        raise ValueError("broker message timestamp must be numeric")
    return {"type": msg_type, "payload": payload, "timestamp": float(timestamp)}


# ---------------------------------------------------------------------------
# In-memory broker (single-process)
# ---------------------------------------------------------------------------


class InMemoryBroker(WsBroker):
    """Single-process broker. Handlers are invoked directly on publish."""

    def __init__(self) -> None:
        self._handlers: dict[str, set[Handler]] = {}
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        log.info("WsBroker: InMemoryBroker initialized (single-process mode)")

    async def publish(self, channel: str, message: dict) -> None:
        envelope = _wrap_envelope(message)
        # Snapshot under lock so concurrent (un)subscribe cannot mutate mid-iter.
        async with self._lock:
            handlers = list(self._handlers.get(channel, ()))
        for handler in handlers:
            try:
                await handler(envelope)
            except Exception as exc:  # noqa: BLE001 - handler fault must not kill publish
                log.warning(
                    "InMemoryBroker: handler raised channel=%s error_kind=%s",
                    opaque_id(channel, kind="channel"),
                    error_kind(exc),
                )

    async def subscribe(self, channel: str, handler: Handler) -> None:
        async with self._lock:
            self._handlers.setdefault(channel, set()).add(handler)

    async def unsubscribe(self, channel: str, handler: Handler) -> None:
        async with self._lock:
            handlers = self._handlers.get(channel)
            if handlers is None:
                return
            handlers.discard(handler)
            if not handlers:
                self._handlers.pop(channel, None)

    async def close(self) -> None:
        async with self._lock:
            self._handlers.clear()


# ---------------------------------------------------------------------------
# Redis broker (multi-process)
# ---------------------------------------------------------------------------

try:
    import redis.asyncio as _aioredis  # type: ignore[import-not-found]
    _REDIS_AVAILABLE = True
except ImportError:  # pragma: no cover — optional dep
    _aioredis = None  # type: ignore[assignment]
    _REDIS_AVAILABLE = False


if _REDIS_AVAILABLE:

    class RedisBroker(WsBroker):
        """Redis Pub/Sub backed broker, safe for multi-worker deployments.

        A single ``redis.asyncio.client.PubSub`` is multiplexed across all
        subscribed channels. A background task consumes messages and
        dispatches them to locally registered handlers.
        """

        # Wire-level channel prefix. Keeps our Redis namespace isolated from
        # anything else using the same Redis instance (rate limiter keys, a
        # neighbouring app's pub/sub, etc.). Callers never see this prefix —
        # they still publish/subscribe on ``ws:task:{job_id}`` etc., and the
        # broker internally translates to/from ``awp:ws:ws:task:{job_id}``
        # on the wire. Kept overridable via env for operational escape hatches.
        _WIRE_PREFIX = os.getenv("AWP_WS_CHANNEL_PREFIX", "awp:ws:")

        def __init__(self, url: Optional[str] = None) -> None:
            # Call-time resolution via config (single owner of the localhost
            # default; audit D2). Must stay call-time: tests monkeypatch
            # REDIS_URL and then construct RedisBroker() via get_broker().
            from config import get_redis_connect_url as _get_redis_connect_url
            self._url = url or _get_redis_connect_url()
            self._redis: Optional["_aioredis.Redis"] = None
            self._pubsub: Optional["_aioredis.client.PubSub"] = None
            self._handlers: dict[str, set[Handler]] = {}
            self._lock = asyncio.Lock()
            self._reader_task: Optional[asyncio.Task] = None
            self._closing = False
            self._prefix = self._WIRE_PREFIX
            # Gate the reader until at least one subscribe() has wired the
            # pubsub connection — redis-py 5+ raises
            # "RuntimeError: pubsub connection not set" if get_message() is
            # called before the first subscribe().
            self._has_subscription = asyncio.Event()

        async def initialize(self) -> None:
            if self._redis is not None:
                return
            try:
                self._redis = _aioredis.from_url(
                    self._url,
                    encoding="utf-8",
                    decode_responses=True,
                    socket_connect_timeout=2.0,
                    socket_timeout=2.0,
                )
                await asyncio.wait_for(self._redis.ping(), timeout=3.0)
            except Exception as exc:  # noqa: BLE001 - explicit Redis is fail-closed
                log.error(
                    "WsBroker: Redis initialization failed endpoint=%s error_kind=%s",
                    endpoint_label(self._url),
                    error_kind(exc),
                )
                try:
                    if self._redis is not None:
                        await asyncio.wait_for(self._redis.close(), timeout=1.0)
                except Exception:  # noqa: BLE001
                    pass
                self._redis = None
                raise RuntimeError("Redis broker initialization failed") from None
            self._pubsub = self._redis.pubsub()
            self._reader_task = asyncio.create_task(
                self._reader_loop(), name="ws_broker_reader",
            )
            log.info("WsBroker: RedisBroker initialized endpoint=%s", endpoint_label(self._url))

        def _wire(self, channel: str) -> str:
            """Prepend ``_prefix`` so Redis-level channels are app-scoped."""
            if channel.startswith(self._prefix):
                return channel
            return self._prefix + channel

        def _unwire(self, wire_channel: str) -> str:
            """Reverse of ``_wire`` — strip prefix for handler dispatch."""
            if wire_channel.startswith(self._prefix):
                return wire_channel[len(self._prefix):]
            return wire_channel

        async def _resubscribe_all(self) -> None:
            """Re-apply every live channel subscription without racing removal."""
            assert self._pubsub is not None
            async with self._lock:
                for channel, handlers in self._handlers.items():
                    if not handlers:
                        continue
                    try:
                        await self._pubsub.subscribe(self._wire(channel))
                    except Exception as exc:  # noqa: BLE001 - next loop iter retries
                        log.warning(
                            "RedisBroker: resubscribe failed channel=%s error_kind=%s",
                            opaque_id(channel, kind="channel"),
                            error_kind(exc),
                        )
                        raise

        async def _reader_loop(self) -> None:
            """Consume messages from the multiplexed pubsub and dispatch."""
            assert self._pubsub is not None
            backoff = 1.0
            while not self._closing:
                # Block until subscribe() has attached at least one channel;
                # get_message() on a virgin PubSub raises in redis-py 5+.
                try:
                    await asyncio.wait_for(
                        self._has_subscription.wait(), timeout=1.0,
                    )
                except asyncio.TimeoutError:
                    continue
                try:
                    msg = await self._pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0,
                    )
                    if msg is None:
                        continue
                    if msg.get("type") != "message":
                        continue
                    wire_channel = msg.get("channel")
                    data = msg.get("data")
                    if not isinstance(wire_channel, str) or not isinstance(data, str):
                        continue
                    # Strip the wire prefix before handler dispatch so the
                    # handler's channel key matches what the caller passed
                    # to ``subscribe()``.
                    channel = self._unwire(wire_channel)
                    try:
                        envelope = json.loads(data)
                    except (json.JSONDecodeError, ValueError):
                        log.warning(
                            "RedisBroker: dropping non-JSON message channel=%s",
                            opaque_id(channel, kind="channel"),
                        )
                        continue
                    async with self._lock:
                        handlers = list(self._handlers.get(channel, ()))
                    for handler in handlers:
                        try:
                            await handler(envelope)
                        except Exception as exc:  # noqa: BLE001
                            log.warning(
                                "RedisBroker: handler raised channel=%s error_kind=%s",
                                opaque_id(channel, kind="channel"),
                                error_kind(exc),
                            )
                    backoff = 1.0  # reset after a successful iteration
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - reader must self-heal
                    log.warning(
                        "RedisBroker: reader loop error error_kind=%s retry_s=%.1f",
                        error_kind(exc),
                        backoff,
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                    # Connection may have dropped — re-apply all known
                    # subscriptions so delivery resumes after the outage.
                    try:
                        await self._resubscribe_all()
                    except Exception:  # noqa: BLE001 — next iter retries
                        pass

        async def publish(self, channel: str, message: dict) -> None:
            if self._redis is None:
                await self.initialize()
            assert self._redis is not None
            envelope = _wrap_envelope(message)
            try:
                await self._redis.publish(self._wire(channel), json.dumps(envelope))
            except Exception as exc:  # noqa: BLE001 - log but never crash callers
                log.warning(
                    "RedisBroker: publish failed channel=%s error_kind=%s",
                    opaque_id(channel, kind="channel"),
                    error_kind(exc),
                )

        async def subscribe(self, channel: str, handler: Handler) -> None:
            if self._pubsub is None:
                await self.initialize()
            assert self._pubsub is not None
            async with self._lock:
                handlers = self._handlers.setdefault(channel, set())
                if handler in handlers:
                    return
                first = not handlers
                handlers.add(handler)
                if first:
                    try:
                        await self._pubsub.subscribe(self._wire(channel))
                    except Exception:
                        handlers.discard(handler)
                        if not handlers:
                            self._handlers.pop(channel, None)
                        if not any(self._handlers.values()):
                            self._has_subscription.clear()
                        raise
                # Only signal the reader after the wire subscription succeeded.
                self._has_subscription.set()

        async def unsubscribe(self, channel: str, handler: Handler) -> None:
            if self._pubsub is None:
                return
            async with self._lock:
                handlers = self._handlers.get(channel)
                if handlers is None or handler not in handlers:
                    return
                handlers.discard(handler)
                if not handlers:
                    self._handlers.pop(channel, None)
                    try:
                        await self._pubsub.unsubscribe(self._wire(channel))
                    except Exception as exc:  # noqa: BLE001 - cleanup is best effort
                        log.debug(
                            "RedisBroker: unsubscribe failed channel=%s error_kind=%s",
                            opaque_id(channel, kind="channel"),
                            error_kind(exc),
                        )
                if not any(self._handlers.values()):
                    self._has_subscription.clear()

        async def close(self) -> None:
            self._closing = True
            task = self._reader_task
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            self._reader_task = None
            if self._pubsub is not None:
                try:
                    await self._pubsub.close()
                except Exception as exc:  # noqa: BLE001
                    log.debug("RedisBroker: pubsub close failed error_kind=%s", error_kind(exc))
                self._pubsub = None
            if self._redis is not None:
                try:
                    await self._redis.close()
                except Exception as exc:  # noqa: BLE001
                    log.debug("RedisBroker: redis close failed error_kind=%s", error_kind(exc))
                self._redis = None
            async with self._lock:
                self._handlers.clear()

else:  # redis-py not installed

    RedisBroker = None  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------


_broker: Optional[WsBroker] = None

# Debounce cache for broker_health(): avoid hitting Redis PING on every HTTP
# request. Holds the last computed dict + monotonic timestamp.
_HEALTH_CACHE_TTL_S: float = 5.0
_health_cache: dict[str, Any] = {}
_health_cache_at: float = 0.0
_health_cache_lock = asyncio.Lock()


def get_broker() -> WsBroker:
    """Return the process-wide broker selected by an exact configuration."""
    global _broker
    if _broker is not None:
        return _broker

    configured = os.getenv("AWP_WS_BROKER")
    backend = "memory" if configured is None else configured
    if backend not in {"memory", "redis"}:
        raise RuntimeError("AWP_WS_BROKER must be exactly memory or redis")

    raw_url = os.getenv("AWP_REDIS_URL", os.getenv("REDIS_URL", ""))
    if raw_url != raw_url.strip():
        raise RuntimeError("Redis URL must not contain surrounding whitespace")
    redis_url = raw_url

    if backend == "redis":
        if not redis_url:
            raise RuntimeError("AWP_WS_BROKER=redis requires AWP_REDIS_URL")
        if not _REDIS_AVAILABLE or RedisBroker is None:
            raise RuntimeError("AWP_WS_BROKER=redis requires the redis dependency")
        _broker = RedisBroker(redis_url)
        log.info(
            "WsBroker: selected RedisBroker endpoint=%s; PING deferred",
            endpoint_label(redis_url),
        )
        return _broker

    _broker = InMemoryBroker()
    if redis_url:
        log.info(
            "WsBroker: explicit memory backend selected; Redis URL is used only "
            "by independently configured middleware",
        )
    else:
        log.info("WsBroker: using InMemoryBroker (single-process mode)")
    return _broker


def reset_broker_for_tests() -> None:
    """Reset the module singleton — test-only hook."""
    global _broker, _health_cache, _health_cache_at
    _broker = None
    _health_cache = {}
    _health_cache_at = 0.0


# ---------------------------------------------------------------------------
# Health inspection (prod Redis monitoring, Sprint 2 --workers 4 prereq)
# ---------------------------------------------------------------------------


async def _ping_redis_safely(broker: "WsBroker") -> tuple[bool, Optional[float]]:
    """PING the broker's Redis with a hard 500ms timeout.

    Returns ``(connected, latency_ms)``. ``latency_ms`` is ``None`` when
    we could not measure a round-trip (no client, timeout, or exception).
    Never raises — broker_health() must survive Redis being down.
    """
    if not _REDIS_AVAILABLE or RedisBroker is None:
        return False, None
    if not isinstance(broker, RedisBroker):
        return False, None
    redis_client = getattr(broker, "_redis", None)
    if redis_client is None:
        return False, None
    t0 = time.perf_counter()
    try:
        await asyncio.wait_for(redis_client.ping(), timeout=0.5)
    except (asyncio.TimeoutError, Exception):  # noqa: BLE001 — never crash
        return False, None
    latency_ms = round((time.perf_counter() - t0) * 1000, 2)
    return True, latency_ms


async def broker_health() -> dict:
    """Return a best-effort snapshot of broker + Redis state.

    Shape::

        {
            "backend": "redis" | "memory",
            "redis_connected": bool,
            "last_ping_ms": float | None,   # None when backend=memory or ping timed out
            "last_ping_at": str,            # ISO-8601 UTC timestamp
        }

    Cached for ``_HEALTH_CACHE_TTL_S`` (5s) so hammering /v1/health/broker
    does not stress Redis. The cache is keyed on the module singleton, not
    per-broker instance — fine because there's one singleton per worker.

    Guarantees:
      * Never raises (Redis down / timeout → ``redis_connected=False``).
      * PING has a hard 500ms budget.
      * ``backend`` reports the exact process singleton selected at startup.
    """
    global _health_cache, _health_cache_at

    now_mono = time.monotonic()
    # Fast path — return cached snapshot if still fresh.
    if _health_cache and (now_mono - _health_cache_at) < _HEALTH_CACHE_TTL_S:
        return dict(_health_cache)

    async with _health_cache_lock:
        # Re-check under lock (another coroutine may have refreshed).
        if _health_cache and (time.monotonic() - _health_cache_at) < _HEALTH_CACHE_TTL_S:
            return dict(_health_cache)

        broker = _broker
        is_redis = (
            _REDIS_AVAILABLE
            and RedisBroker is not None
            and isinstance(broker, RedisBroker)
        )
        backend = "redis" if is_redis else "memory"

        if is_redis and broker is not None:
            connected, latency_ms = await _ping_redis_safely(broker)
        else:
            connected, latency_ms = False, None

        snapshot = {
            "backend": backend,
            "redis_connected": bool(connected),
            "last_ping_ms": latency_ms,
            "last_ping_at": datetime.now(timezone.utc).isoformat(),
        }

        _health_cache = snapshot
        _health_cache_at = time.monotonic()
        return dict(snapshot)


__all__ = [
    "WsBroker",
    "InMemoryBroker",
    "RedisBroker",
    "get_broker",
    "reset_broker_for_tests",
    "broker_health",
]
