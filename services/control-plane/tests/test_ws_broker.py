"""Regression tests for cloud.ws_broker — in-memory pub/sub fan-out.

Redis-backed paths are skipped when redis-py isn't installed.

Hermeticity notes (2026-04-17):
  * InMemoryBroker tests don't touch Redis at all.
  * The RedisBroker tests below deliberately inject failure modes that a
    well-behaved fake (fakeredis) cannot reproduce:
        - "pubsub connection not set" race on the first get_message() call
          (redis-py 5+ edge-case we gate against with ``_has_subscription``)
        - mid-stream ConnectionError raised inside ``_reader_loop`` to
          verify resubscribe-on-drop
    fakeredis never raises on either — it's too friendly. So these two
    tests keep their hand-rolled pubsub stubs. Shared ``redis_server`` /
    ``redis_env`` fixtures in conftest.py are available for future
    happy-path Redis tests.
"""

from __future__ import annotations

import asyncio

import pytest


def _run(coro):
    """Run an async coroutine synchronously inside a test."""
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro) \
        if False else asyncio.run(coro)


@pytest.fixture
def broker_mod():
    from cloud import ws_broker
    ws_broker.reset_broker_for_tests()
    yield ws_broker
    ws_broker.reset_broker_for_tests()


# ---------------------------------------------------------------------------
# InMemoryBroker basic flow
# ---------------------------------------------------------------------------

def test_inmemory_publish_subscribe(broker_mod):
    async def scenario():
        b = broker_mod.InMemoryBroker()
        await b.initialize()
        received: list[dict] = []

        async def handler(env):
            received.append(env)

        await b.subscribe("ws:task:abc", handler)
        await b.publish("ws:task:abc", {"progress": 42})
        await b.close()
        return received

    received = asyncio.run(scenario())
    assert len(received) == 1
    env = received[0]
    assert env["type"] == "message"
    assert env["payload"] == {"progress": 42}
    assert isinstance(env["timestamp"], float)


def test_unsubscribe(broker_mod):
    async def scenario():
        b = broker_mod.InMemoryBroker()
        got: list[dict] = []

        async def handler(env):
            got.append(env)

        await b.subscribe("ws:user:u1", handler)
        await b.publish("ws:user:u1", {"x": 1})
        await b.unsubscribe("ws:user:u1", handler)
        await b.publish("ws:user:u1", {"x": 2})
        return got

    received = asyncio.run(scenario())
    assert len(received) == 1
    assert received[0]["payload"] == {"x": 1}


def test_subscribe_multi_handlers(broker_mod):
    async def scenario():
        b = broker_mod.InMemoryBroker()
        a_calls: list[dict] = []
        b_calls: list[dict] = []

        async def h_a(env):
            a_calls.append(env)

        async def h_b(env):
            b_calls.append(env)

        await b.subscribe("ws:broadcast:news", h_a)
        await b.subscribe("ws:broadcast:news", h_b)
        await b.publish("ws:broadcast:news", {"n": "hello"})
        return a_calls, b_calls

    a_calls, b_calls = asyncio.run(scenario())
    assert len(a_calls) == 1 and len(b_calls) == 1
    assert a_calls[0]["payload"] == {"n": "hello"}
    assert b_calls[0]["payload"] == {"n": "hello"}


def test_ref_counting(broker_mod):
    """Registering same handler twice → set dedups. Unsubscribing an
    unknown handler is a silent no-op. Empty handler set purges the channel."""
    async def scenario():
        b = broker_mod.InMemoryBroker()
        calls: list[dict] = []

        async def handler(env):
            calls.append(env)

        # Subscribing the same handler twice adds to a set (dedup).
        await b.subscribe("ws:x", handler)
        await b.subscribe("ws:x", handler)
        await b.publish("ws:x", {"a": 1})

        # Unsubscribe once removes it entirely (set-based).
        await b.unsubscribe("ws:x", handler)
        # Channel removed when empty.
        assert "ws:x" not in b._handlers
        # Unsubscribing again is a no-op, not an error.
        await b.unsubscribe("ws:x", handler)
        await b.publish("ws:x", {"a": 2})

        return calls

    calls = asyncio.run(scenario())
    assert len(calls) == 1
    assert calls[0]["payload"] == {"a": 1}


def test_close_releases(broker_mod):
    """close() clears handlers; re-subscribe after close must still work."""
    async def scenario():
        b = broker_mod.InMemoryBroker()
        calls: list[dict] = []

        async def handler(env):
            calls.append(env)

        await b.subscribe("ws:y", handler)
        await b.close()
        assert b._handlers == {}

        # Re-subscribe after close — should not hang or raise.
        await b.subscribe("ws:y", handler)
        await asyncio.wait_for(b.publish("ws:y", {"after": "close"}), timeout=2.0)
        return calls

    calls = asyncio.run(scenario())
    assert len(calls) == 1
    assert calls[0]["payload"] == {"after": "close"}


def test_get_broker_singleton(broker_mod, monkeypatch):
    """get_broker() returns the same instance across calls within a process."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    broker_mod.reset_broker_for_tests()
    b1 = broker_mod.get_broker()
    b2 = broker_mod.get_broker()
    assert b1 is b2
    assert isinstance(b1, broker_mod.InMemoryBroker)


# ---------------------------------------------------------------------------
# Redis branch — only if redis-py installed
# ---------------------------------------------------------------------------

def test_redis_broker_class_availability():
    """If redis-py is present, RedisBroker should be a class; otherwise None."""
    pytest.importorskip("redis")
    from cloud import ws_broker
    assert ws_broker.RedisBroker is not None
    # Don't actually connect — just verify the class is instantiable.
    b = ws_broker.RedisBroker(url="redis://localhost:6379/0")
    assert b._url.startswith("redis://")


# ---------------------------------------------------------------------------
# Redis reader-loop self-heal (pubsub connection not set → re-subscribe)
# ---------------------------------------------------------------------------

def test_redis_reader_recovers_from_pubsub_not_set(broker_mod):
    """Simulate redis-py 5+ race: first get_message() call raises
    'RuntimeError: pubsub connection not set' because the reader loop ran
    before subscribe() attached a connection. Broker must self-heal:
    subscribe() re-wires, re-subscribe happens, publish delivered."""
    pytest.importorskip("redis")

    class FakePubSub:
        def __init__(self) -> None:
            self.subscribed: list[str] = []
            self.pending: list[dict] = []
            self._connection_ready = False
            self.get_message_calls = 0

        async def subscribe(self, channel: str) -> None:
            self.subscribed.append(channel)
            self._connection_ready = True

        async def unsubscribe(self, channel: str) -> None:
            if channel in self.subscribed:
                self.subscribed.remove(channel)

        async def get_message(self, ignore_subscribe_messages=True, timeout=1.0):
            self.get_message_calls += 1
            if not self._connection_ready:
                raise RuntimeError("pubsub connection not set")
            if self.pending:
                return self.pending.pop(0)
            await asyncio.sleep(0.01)
            return None

        async def close(self) -> None:
            self._connection_ready = False

        def push(self, channel: str, payload: dict) -> None:
            import json as _json
            self.pending.append(
                {"type": "message", "channel": channel, "data": _json.dumps(payload)},
            )

    class FakeRedis:
        def __init__(self, ps: FakePubSub) -> None:
            self._ps = ps
            self.published: list[tuple[str, str]] = []

        async def ping(self) -> bool:
            return True

        def pubsub(self):
            return self._ps

        async def publish(self, channel: str, data: str) -> None:
            self.published.append((channel, data))
            import json as _json
            self._ps.pending.append(
                {"type": "message", "channel": channel, "data": data},
            )
            # Validate payload is legal JSON so the reader does not drop it.
            _json.loads(data)

        async def close(self) -> None:
            return None

    async def scenario():
        ps = FakePubSub()
        fake_redis = FakeRedis(ps)
        b = broker_mod.RedisBroker(url="redis://fake/0")
        # Bypass the real from_url; inject our fake redis client.
        b._redis = fake_redis
        b._pubsub = ps
        # Start the reader loop directly so we can observe its behaviour
        # before any subscribe() — this is the exact prod race condition.
        b._reader_task = asyncio.create_task(b._reader_loop())
        # Give the reader a tick to confirm it does NOT call get_message
        # before we subscribe (gated by _has_subscription).
        await asyncio.sleep(0.05)
        assert ps.get_message_calls == 0, \
            "reader must not call get_message before subscribe()"

        received: list[dict] = []

        async def handler(env):
            received.append(env)

        await b.subscribe("ws:task:42", handler)
        # F12: RedisBroker prefixes wire-level channels with ``awp:ws:``
        # so our pub/sub namespace cannot collide with other apps sharing
        # the Redis instance. Callers still use the bare channel name.
        assert ps.subscribed == ["awp:ws:ws:task:42"]

        # Now publish — envelope should round-trip through the reader loop.
        await b.publish("ws:task:42", {"progress": 99})

        # Wait briefly for the reader to deliver.
        for _ in range(50):
            if received:
                break
            await asyncio.sleep(0.02)

        await b.close()
        return received, ps

    received, ps = asyncio.run(scenario())
    assert len(received) == 1
    assert received[0]["payload"] == {"progress": 99}
    # The gated reader never hit the "pubsub connection not set" path.
    assert ps.get_message_calls >= 1


def test_redis_reader_resubscribes_after_connection_drop(broker_mod):
    """After a mid-run error in the reader loop, the broker must re-apply
    all known subscriptions so delivery resumes without a manual re-subscribe."""
    pytest.importorskip("redis")

    class FlakyPubSub:
        def __init__(self) -> None:
            self.subscribed: list[str] = []
            self.subscribe_calls = 0
            self.pending: list[dict] = []
            self._fail_next_get = False

        async def subscribe(self, channel: str) -> None:
            self.subscribe_calls += 1
            if channel not in self.subscribed:
                self.subscribed.append(channel)

        async def unsubscribe(self, channel: str) -> None:
            if channel in self.subscribed:
                self.subscribed.remove(channel)

        def trip(self) -> None:
            self._fail_next_get = True

        async def get_message(self, ignore_subscribe_messages=True, timeout=1.0):
            if self._fail_next_get:
                self._fail_next_get = False
                raise ConnectionError("simulated redis drop")
            if self.pending:
                return self.pending.pop(0)
            await asyncio.sleep(0.01)
            return None

        async def close(self) -> None:
            return None

    class FakeRedis:
        def __init__(self, ps: FlakyPubSub) -> None:
            self._ps = ps

        async def ping(self) -> bool:
            return True

        def pubsub(self):
            return self._ps

        async def publish(self, channel: str, data: str) -> None:
            self._ps.pending.append(
                {"type": "message", "channel": channel, "data": data},
            )

        async def close(self) -> None:
            return None

    async def scenario():
        ps = FlakyPubSub()
        b = broker_mod.RedisBroker(url="redis://fake/0")
        b._redis = FakeRedis(ps)
        b._pubsub = ps
        # Shorten backoff so the test does not wait the default 1s after failure.
        b._reader_task = asyncio.create_task(b._reader_loop())

        received: list[dict] = []

        async def handler(env):
            received.append(env)

        await b.subscribe("ws:user:1", handler)
        initial_subs = ps.subscribe_calls  # == 1

        # Trigger a connection drop inside the reader loop.
        ps.trip()
        # Wait enough for the reader's backoff (starts at 1.0s) + resubscribe.
        for _ in range(200):
            if ps.subscribe_calls > initial_subs:
                break
            await asyncio.sleep(0.02)
        assert ps.subscribe_calls > initial_subs, \
            "broker did not re-subscribe after connection drop"

        # Publish after recovery — must be delivered.
        await b.publish("ws:user:1", {"after": "drop"})
        for _ in range(100):
            if received:
                break
            await asyncio.sleep(0.02)

        await b.close()
        return received

    received = asyncio.run(scenario())
    assert len(received) == 1
    assert received[0]["payload"] == {"after": "drop"}


def test_typed_envelope_is_not_double_nested(broker_mod):
    typed = broker_mod._wrap_envelope(
        {"type": "task.status", "payload": {"status": "running"}},
    )
    assert typed["type"] == "task.status"
    assert typed["payload"] == {"status": "running"}
    assert "payload" not in typed["payload"]

    naked = broker_mod._wrap_envelope({"type": "ordinary-payload-field", "value": 3})
    assert naked["type"] == "message"
    assert naked["payload"] == {"type": "ordinary-payload-field", "value": 3}

    with pytest.raises(ValueError):
        broker_mod._wrap_envelope(
            {"type": "task.status", "payload": {}, "unexpected": True},
        )


def test_broker_selection_is_exact_and_explicit(broker_mod, monkeypatch):
    monkeypatch.delenv("AWP_REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)

    monkeypatch.setenv("AWP_WS_BROKER", "Redis")
    with pytest.raises(RuntimeError, match="exactly memory or redis"):
        broker_mod.get_broker()

    broker_mod.reset_broker_for_tests()
    monkeypatch.setenv("AWP_WS_BROKER", "redis")
    with pytest.raises(RuntimeError, match="requires AWP_REDIS_URL"):
        broker_mod.get_broker()

    broker_mod.reset_broker_for_tests()
    monkeypatch.setenv("AWP_WS_BROKER", "memory")
    monkeypatch.setenv("AWP_REDIS_URL", " redis://cache.example.invalid/0")
    with pytest.raises(RuntimeError, match="whitespace"):
        broker_mod.get_broker()


def test_explicit_redis_initialization_failure_is_fatal(broker_mod, monkeypatch):
    pytest.importorskip("redis")

    class BrokenRedis:
        async def ping(self):
            raise ConnectionError("credential-like-value-must-not-be-reported")

        async def close(self):
            return None

    monkeypatch.setattr(broker_mod._aioredis, "from_url", lambda *args, **kwargs: BrokenRedis())
    broker = broker_mod.RedisBroker(url="redis://cache.example.invalid/0")
    with pytest.raises(RuntimeError, match="initialization failed"):
        asyncio.run(broker.initialize())
    assert broker._redis is None
    assert broker._reader_task is None


def test_redis_subscribe_failure_rolls_back_all_local_state(broker_mod):
    pytest.importorskip("redis")

    class FlakyPubSub:
        def __init__(self):
            self.fail = True
            self.channels: list[str] = []

        async def subscribe(self, channel):
            if self.fail:
                self.fail = False
                raise ConnectionError("wire subscribe failed")
            self.channels.append(channel)

        async def unsubscribe(self, channel):
            if channel in self.channels:
                self.channels.remove(channel)

        async def close(self):
            return None

    class FakeRedis:
        async def close(self):
            return None

    async def scenario():
        broker = broker_mod.RedisBroker(url="redis://cache.example.invalid/0")
        pubsub = FlakyPubSub()
        broker._redis = FakeRedis()
        broker._pubsub = pubsub

        async def handler(_event):
            return None

        with pytest.raises(ConnectionError):
            await broker.subscribe("task:local:one", handler)
        assert broker._handlers == {}
        assert not broker._has_subscription.is_set()

        await broker.subscribe("task:local:one", handler)
        assert list(broker._handlers) == ["task:local:one"]
        assert broker._has_subscription.is_set()
        assert pubsub.channels == ["awp:ws:task:local:one"]
        await broker.unsubscribe("task:local:one", handler)
        assert broker._handlers == {}
        assert pubsub.channels == []
        await broker.close()

    asyncio.run(scenario())