"""Negative security gates for request logging and rate limiting."""
from __future__ import annotations

import io
import json
import logging
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request


def _request(
    *,
    client_ip: str,
    headers: list[tuple[bytes, bytes]] | None = None,
    path: str = "/protected",
) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode(),
            "headers": headers or [],
            "query_string": b"",
            "client": (client_ip, 12345),
            "scheme": "http",
            "server": ("localhost", 8000),
            "http_version": "1.1",
        }
    )


def test_untrusted_peer_cannot_spoof_forwarded_ip(monkeypatch):
    import middleware

    monkeypatch.setenv("AWP_TRUSTED_PROXIES", "")
    request = _request(
        client_ip="198.51.100.9",
        headers=[
            (b"x-real-ip", b"203.0.113.77"),
            (b"x-forwarded-for", b"203.0.113.88"),
        ],
    )
    assert middleware._get_real_ip(request) == "198.51.100.9"


def test_trusted_proxy_accepts_only_valid_forwarded_ip(monkeypatch):
    import middleware

    monkeypatch.setenv("AWP_TRUSTED_PROXIES", "192.0.2.10")
    valid = _request(
        client_ip="192.0.2.10",
        headers=[(b"x-real-ip", b"203.0.113.77")],
    )
    invalid = _request(
        client_ip="192.0.2.10",
        headers=[(b"x-real-ip", b"not-an-ip customer-secret")],
    )
    assert middleware._get_real_ip(valid) == "203.0.113.77"
    assert middleware._get_real_ip(invalid) == "192.0.2.10"


def test_in_memory_limiter_has_bounded_key_space():
    import middleware

    limiter = middleware.InMemoryRateLimiter(max_keys=3)
    for index in range(20):
        assert limiter.acquire(f"identity-{index}", 10, 60)[0]
    assert limiter.key_count == 3


def test_redis_limiter_sets_count_and_ttl_atomically():
    import middleware

    class Client:
        def __init__(self):
            self.calls = []

        def eval(self, *args):
            self.calls.append(args)
            return [1, 60]

    client = Client()
    limiter = middleware.RedisRateLimiter(client)
    assert limiter.acquire("peer-value", 2, 60) == (True, 0)
    assert len(client.calls) == 1
    script, key_count, redis_key, window = client.calls[0]
    assert "INCR" in script
    assert "EXPIRE" in script
    assert key_count == 1
    assert redis_key.startswith("awp:rate_limit:")
    assert "peer-value" not in redis_key
    assert window == 60


def test_redis_failure_falls_back_for_same_request_and_cools_down():
    import middleware

    class BrokenClient:
        def __init__(self):
            self.calls = 0

        def eval(self, *_args):
            self.calls += 1
            raise TimeoutError("redis://user:secret@host.invalid/tenant")

    clock_value = [100.0]
    fallback = middleware.InMemoryRateLimiter(
        clock=lambda: clock_value[0]
    )
    # Pre-consume the only local slot: the failing Redis request must be
    # rejected by fallback, not allowed through.
    assert fallback.acquire("same-peer", 1, 60) == (True, 0)
    client = BrokenClient()
    limiter = middleware.RedisRateLimiter(
        client,
        fallback=fallback,
        cooldown_seconds=5,
        clock=lambda: clock_value[0],
    )

    allowed, retry_after = limiter.acquire("same-peer", 1, 60)
    assert allowed is False
    assert retry_after >= 1
    assert client.calls == 1

    # During cooldown Redis is not retried, but local limiting remains active.
    assert limiter.acquire("different-peer", 1, 60) == (True, 0)
    assert client.calls == 1
    assert 100.0 < limiter.unavailable_until <= 130.0


def test_rotating_bearer_tokens_cannot_bypass_peer_bucket(monkeypatch):
    import middleware

    limiter = middleware.InMemoryRateLimiter()
    monkeypatch.setattr(middleware, "_rate_limiter", limiter)
    monkeypatch.setitem(middleware._RATE_LIMITS, "default", (2, 60))

    app = FastAPI()
    app.add_middleware(middleware.RateLimitMiddleware)

    @app.get("/protected")
    def protected():
        return {"ok": True}

    with TestClient(app) as client:
        first = client.get(
            "/protected", headers={"Authorization": "Bearer token-one-value"}
        )
        second = client.get(
            "/protected", headers={"Authorization": "Bearer token-two-value"}
        )
        third = client.get(
            "/protected", headers={"Authorization": "Bearer token-three-value"}
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429
    assert int(third.headers["Retry-After"]) >= 1


def test_rate_limiter_applies_peer_and_credential_buckets(monkeypatch):
    import middleware

    calls = []

    class CapturingLimiter:
        def acquire(self, key, limit, window):
            calls.append((key, limit, window))
            return True, 0

    monkeypatch.setattr(middleware, "_rate_limiter", CapturingLimiter())

    app = FastAPI()
    app.add_middleware(middleware.RateLimitMiddleware)

    @app.get("/protected")
    def protected():
        return {"ok": True}

    token = "never-store-this-credential"
    with TestClient(app) as client:
        response = client.get(
            "/protected", headers={"Authorization": f"Bearer {token}"}
        )
    assert response.status_code == 200
    assert len(calls) == 2
    assert calls[0][0].startswith("peer:")
    assert calls[1][0].startswith("credential:")
    assert token not in repr(calls)


def test_sync_limiter_runs_off_event_loop_thread(monkeypatch):
    import middleware

    limiter_threads = []

    class TrackingLimiter:
        def acquire(self, _key, _limit, _window):
            limiter_threads.append(threading.get_ident())
            time.sleep(0.01)
            return True, 0

    monkeypatch.setattr(middleware, "_rate_limiter", TrackingLimiter())

    app = FastAPI()
    app.add_middleware(middleware.RateLimitMiddleware)

    @app.get("/protected")
    async def protected():
        return {"loop_thread": threading.get_ident()}

    with TestClient(app) as client:
        response = client.get("/protected")
    assert response.status_code == 200
    assert limiter_threads
    assert all(
        thread_id != response.json()["loop_thread"]
        for thread_id in limiter_threads
    )


def test_broken_limiter_wait_zero_still_fails_closed(monkeypatch):
    import middleware

    class BrokenContractLimiter:
        def acquire(self, _key, _limit, _window):
            return False, 0

    monkeypatch.setattr(middleware, "_rate_limiter", BrokenContractLimiter())
    app = FastAPI()
    app.add_middleware(middleware.RateLimitMiddleware)

    @app.get("/protected")
    def protected():
        return {"ok": True}

    with TestClient(app) as client:
        response = client.get("/protected")
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "1"

def test_request_log_contains_only_template_and_peer_class():
    import middleware
    import observability

    app = FastAPI()
    app.add_middleware(middleware.RequestLoggingMiddleware)
    app.add_middleware(observability.RequestIDMiddleware)

    @app.get("/widgets/{widget_id}")
    def widget(widget_id: str):
        return {"id": widget_id}

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(observability.JsonLineFormatter())
    previous_handlers = middleware.logger.handlers[:]
    previous_propagate = middleware.logger.propagate
    previous_level = middleware.logger.level
    middleware.logger.handlers = [handler]
    middleware.logger.propagate = False
    middleware.logger.setLevel(logging.INFO)

    path_secret = "customer-path-secret"
    query_secret = "query-token-secret"
    bearer_secret = "bearer-secret-value"
    supplied_request_id = "client-request-id-secret"
    try:
        with TestClient(app) as client:
            response = client.get(
                f"/widgets/{path_secret}?api_key={query_secret}",
                headers={
                    "Authorization": f"Bearer {bearer_secret}",
                    "X-Request-ID": supplied_request_id,
                },
            )
    finally:
        middleware.logger.handlers = previous_handlers
        middleware.logger.propagate = previous_propagate
        middleware.logger.setLevel(previous_level)

    assert response.status_code == 200
    payload = json.loads(stream.getvalue().strip().splitlines()[-1])
    encoded = json.dumps(payload)
    for forbidden in (
        path_secret,
        query_secret,
        bearer_secret,
        supplied_request_id,
        "testclient",
    ):
        assert forbidden not in encoded
    assert payload["message"] == "http_request"
    assert payload["route"] == "/widgets/{widget_id}"
    assert payload["peer_class"] in {
        "missing",
        "hostname",
        "loopback",
        "private",
        "public",
        "link-local",
        "multicast",
        "unspecified",
    }
    assert payload["error_kind"] == "none"


def test_request_log_exception_is_finite_and_secret_free():
    import middleware
    import observability

    app = FastAPI()
    app.add_middleware(middleware.RequestLoggingMiddleware)
    app.add_middleware(observability.RequestIDMiddleware)

    @app.get("/explode/{item_id}")
    def explode(item_id: str):
        raise RuntimeError("secret exception for " + item_id)

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(observability.JsonLineFormatter())
    previous_handlers = middleware.logger.handlers[:]
    previous_propagate = middleware.logger.propagate
    previous_level = middleware.logger.level
    middleware.logger.handlers = [handler]
    middleware.logger.propagate = False
    middleware.logger.setLevel(logging.INFO)

    secret = "customer-exception-secret"
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get(f"/explode/{secret}")
    finally:
        middleware.logger.handlers = previous_handlers
        middleware.logger.propagate = previous_propagate
        middleware.logger.setLevel(previous_level)

    assert response.status_code == 500
    payload = json.loads(stream.getvalue().strip().splitlines()[-1])
    assert secret not in json.dumps(payload)
    assert payload["route"] == "/explode/{item_id}"
    assert payload["status"] == 500
    assert payload["error_kind"] == "backend_error"
