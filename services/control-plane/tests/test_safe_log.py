from __future__ import annotations

import asyncio
import logging

import pytest

import safe_log
import ws_broker


def test_endpoint_label_never_contains_userinfo_host_path_or_query():
    raw = "redis://private-user:private-password@10.20.30.40:6381/customer-db?token=private-query"
    label = safe_log.endpoint_label(raw)
    assert label == "redis://private:6381"
    for fragment in (
        "private-user",
        "private-password",
        "10.20.30.40",
        "customer-db",
        "private-query",
        "token",
    ):
        assert fragment not in label


def test_endpoint_label_does_not_emit_hostnames_and_errors_are_finite():
    assert safe_log.endpoint_label("rediss://user:pass@customer.internal/0") == "rediss://hostname:6380"
    exc = RuntimeError("redis://user:pass@customer.internal/private?token=secret")
    assert safe_log.error_kind(exc) == "backend_error"
    value = safe_log.opaque_id("tenant-secret", kind="tenant")
    assert value.startswith("tenant:")
    assert "tenant-secret" not in value


def test_redis_broker_failure_log_never_reflects_url_or_exception(monkeypatch, caplog):
    if ws_broker.RedisBroker is None:
        pytest.skip("redis dependency is unavailable")

    secret_url = (
        "redis://private-user:private-password@10.20.30.40:6381/"
        "customer-db?token=private-query"
    )

    class FailingRedis:
        async def ping(self):
            raise RuntimeError(secret_url)

        async def close(self):
            return None

    monkeypatch.setattr(ws_broker._aioredis, "from_url", lambda *args, **kwargs: FailingRedis())
    broker = ws_broker.RedisBroker(secret_url)

    with caplog.at_level(logging.INFO), pytest.raises(RuntimeError, match="Redis broker initialization failed"):
        asyncio.run(broker.initialize())

    rendered = caplog.text
    assert "redis://private:6381" in rendered
    for fragment in (
        "private-user",
        "private-password",
        "10.20.30.40",
        "customer-db",
        "private-query",
        "token=private-query",
    ):
        assert fragment not in rendered
