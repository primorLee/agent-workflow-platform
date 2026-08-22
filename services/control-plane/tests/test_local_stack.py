import asyncio
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from fastapi.testclient import TestClient

from server import app

client = TestClient(app)
DEV = {"Authorization": "Bearer test-only-control-plane-key-00000001"}


def test_local_agent_task_round_trip():
    registered = client.post(
        "/v1/agent/register",
        headers=DEV,
        json={"hostname": "local-worker", "capabilities": {"commands": ["python"]}, "version": "0.1.0"},
    )
    assert registered.status_code == 200
    agent_token = registered.json()["agent_token"]
    agent_headers = {"Authorization": f"Bearer {agent_token}"}

    created = client.post(
        "/v1/tasks",
        headers=DEV,
        json={"task_type": "command", "payload": {"argv": ["python", "-c", "print('ok')"]}},
    )
    assert created.status_code == 200
    task_id = created.json()["id"]

    pending = client.get("/v1/agent/tasks/pending", headers=agent_headers)
    assert pending.status_code == 200
    assert pending.json()[0]["id"] == task_id

    heartbeat = client.post(
        "/v1/agent/heartbeat",
        headers=agent_headers,
        json={"status": "busy", "running_tasks": [task_id]},
    )
    assert heartbeat.status_code == 200

    completed = client.post(
        f"/v1/agent/tasks/{task_id}/result",
        headers=agent_headers,
        json={"status": "success", "output": {"stdout": "ok\n", "exit_code": 0}, "duration_s": 0.01},
    )
    assert completed.status_code == 200

    fetched = client.get(f"/v1/tasks/{task_id}", headers=DEV)
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "success"
    assert fetched.json()["result"]["output"]["exit_code"] == 0

    stream = client.get(
        f"/v1/events/tasks/{task_id}?max_events=1",
        headers=DEV,
    )
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert "event: snapshot" in stream.text
    assert task_id in stream.text


def test_session_lifecycle():
    created = client.post(
        "/v1/sessions", headers=DEV,
        json={"session_type": "interactive", "metadata": {"purpose": "demo"}},
    )
    assert created.status_code == 200
    session_id = created.json()["session_id"]
    assert client.post(f"/v1/sessions/{session_id}/heartbeat", headers=DEV).status_code == 200
    assert client.delete(f"/v1/sessions/{session_id}", headers=DEV).status_code == 200


def test_readiness_is_local_only():
    response = client.get("/v1/health/ready")
    assert response.status_code == 200
    assert response.json()["database"] == "ok"

def test_task_transitions_publish_live_broker_events(monkeypatch):
    from routes import tasks as task_routes

    class CapturingBroker:
        def __init__(self):
            self.events = []

        async def publish(self, channel, message):
            self.events.append((channel, message))

    broker = CapturingBroker()
    monkeypatch.setattr(task_routes, "get_broker", lambda: broker)

    registered = client.post(
        "/v1/agent/register",
        headers=DEV,
        json={"hostname": "event-worker", "capabilities": {}, "version": "0.1.0"},
    )
    token = registered.json()["agent_token"]
    agent_headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/v1/tasks",
        headers=DEV,
        json={"task_type": "command", "payload": {"argv": ["python", "-V"]}},
    )
    task_id = created.json()["id"]
    pending = client.get("/v1/agent/tasks/pending", headers=agent_headers)
    assert task_id in {item["id"] for item in pending.json()}
    completed = client.post(
        f"/v1/agent/tasks/{task_id}/result",
        headers=agent_headers,
        json={"status": "success", "output": {}, "duration_s": 0.01},
    )
    assert completed.status_code == 200

    matching = [
        message["payload"]["status"]
        for channel, message in broker.events
        if channel.endswith(task_id)
    ]
    assert matching == ["pending", "running", "success"]


def test_sse_subscribes_before_snapshot_and_always_unsubscribes(monkeypatch):
    from database import get_db
    from routes import events_stream

    created = client.post(
        "/v1/tasks",
        headers=DEV,
        json={"task_type": "command", "payload": {"argv": ["python", "-V"]}},
    )
    task_id = created.json()["id"]

    class RacingBroker:
        subscribed = 0
        unsubscribed = 0

        async def subscribe(self, channel, handler):
            self.subscribed += 1
            with get_db() as conn:
                conn.execute(
                    "UPDATE tasks SET status='running' WHERE id=? AND tenant_id='local'",
                    (task_id,),
                )

        async def unsubscribe(self, channel, handler):
            self.unsubscribed += 1

    broker = RacingBroker()
    monkeypatch.setattr(events_stream, "get_broker", lambda: broker)

    assert client.get(f"/v1/events/tasks/{task_id}?max_events=1").status_code == 401
    response = client.get(
        f"/v1/events/tasks/{task_id}?max_events=1",
        headers=DEV,
    )
    assert response.status_code == 200
    assert '"status":"running"' in response.text
    assert '"status":"pending"' not in response.text
    assert broker.subscribed == 1
    assert broker.unsubscribed == 1


def test_server_lifespan_initializes_and_closes_broker_once(monkeypatch):
    import server

    class LifecycleBroker:
        def __init__(self):
            self.initialized = 0
            self.closed = 0

        async def initialize(self):
            self.initialized += 1

        async def close(self):
            self.closed += 1

    broker = LifecycleBroker()
    monkeypatch.setattr(server, "get_broker", lambda: broker)
    with TestClient(server.app) as lifecycle_client:
        assert lifecycle_client.get("/v1/health/live").status_code == 200
    assert broker.initialized == 1
    assert broker.closed == 1


def test_readiness_fails_closed_when_selected_redis_is_unavailable(monkeypatch):
    from routes import health as health_routes

    async def unavailable():
        return {
            "backend": "redis",
            "redis_connected": False,
            "last_ping_ms": None,
            "last_ping_at": "2026-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr(health_routes, "broker_health", unavailable)
    response = client.get("/v1/health/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"


def test_task_transitions_flow_through_real_inmemory_envelopes():
    from routes.tasks import _task_channel
    from ws_broker import get_broker, reset_broker_for_tests

    reset_broker_for_tests()
    broker = get_broker()
    registered = client.post(
        "/v1/agent/register",
        headers=DEV,
        json={"hostname": f"event-real-{uuid4()}", "capabilities": {}, "version": "0.1.0"},
    )
    agent_headers = {"Authorization": f"Bearer {registered.json()['agent_token']}"}
    created = client.post(
        "/v1/tasks",
        headers=DEV,
        json={"task_type": "command", "payload": {"argv": ["python", "-V"]}},
    )
    task_id = created.json()["id"]
    received: list[dict] = []

    async def capture(envelope):
        received.append(envelope)

    channel = _task_channel("local", task_id)
    asyncio.run(broker.subscribe(channel, capture))
    pending = client.get("/v1/agent/tasks/pending", headers=agent_headers)
    assert task_id in {item["id"] for item in pending.json()}
    completed = client.post(
        f"/v1/agent/tasks/{task_id}/result",
        headers=agent_headers,
        json={"status": "success", "output": {}, "duration_s": 0.01},
    )
    assert completed.status_code == 200
    asyncio.run(broker.unsubscribe(channel, capture))

    assert [event["payload"]["status"] for event in received] == ["running", "success"]
    assert all(set(event) == {"type", "payload", "timestamp"} for event in received)
    assert all(event["type"] == "task.status" for event in received)


def test_idempotent_submission_is_atomic_across_connections(monkeypatch):
    from database import get_db
    from routes import tasks as task_routes

    async def no_event(_tenant_id, _task_id, _status):
        return None

    monkeypatch.setattr(task_routes, "_publish_task_status", no_event)
    key = f"concurrent-{uuid4()}"

    def submit():
        body = task_routes.CreateTaskRequest(
            task_type="command",
            payload={"argv": ["python", "-V"]},
            idempotency_key=key,
        )
        return asyncio.run(task_routes.create_task(body, "tenant-race"))

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda _index: submit(), range(24)))

    ids = {result["id"] for result in results}
    assert len(ids) == 1
    with get_db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM tasks WHERE tenant_id=? AND idempotency_key=?",
            ("tenant-race", key),
        ).fetchone()[0]
    assert count == 1


def test_retired_pending_legacy_route_is_strict_404():
    registered = client.post(
        "/v1/agent/register",
        headers=DEV,
        json={"hostname": f"legacy-check-{uuid4()}", "capabilities": {}, "version": "0.1.0"},
    )
    headers = {"Authorization": f"Bearer {registered.json()['agent_token']}"}
    assert client.get("/v1/agent/tasks/pending-legacy", headers=headers).status_code == 404