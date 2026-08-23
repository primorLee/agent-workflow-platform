from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

import database
import maintenance
from database import get_db
from routes import agents as agent_routes
from routes import tasks as task_routes
from session_manager import SessionManager


def _now() -> datetime:
    return datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)


def _seed_agent(tenant: str, *, heartbeat: datetime | None = None) -> dict:
    timestamp = (heartbeat or _now()).isoformat()
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO agents
               (tenant_id, hostname, token_hash, status, capabilities_json, version, last_heartbeat)
               VALUES (?, ?, ?, 'idle', '{}', 'test', ?)""",
            (tenant, f"worker-{uuid4()}", uuid4().hex, timestamp),
        )
        return {"id": cur.lastrowid, "tenant_id": tenant}


def _seed_tasks(tenant: str, count: int) -> list[str]:
    timestamp = _now().isoformat()
    ids = [str(uuid4()) for _ in range(count)]
    with get_db() as conn:
        for task_id in ids:
            conn.execute(
                """INSERT INTO tasks
                   (id, tenant_id, task_type, payload_json, status, created_at, updated_at)
                   VALUES (?, ?, 'command', ?, 'pending', ?, ?)""",
                (task_id, tenant, json.dumps({"argv": ["python", "-V"]}), timestamp, timestamp),
            )
    return ids


@pytest.fixture
def quiet_events(monkeypatch):
    async def no_events(*_args, **_kwargs):
        return None

    monkeypatch.setattr(task_routes, "publish_task_transitions", no_events)
    monkeypatch.setattr(task_routes, "_publish_task_status", no_events)


def test_claim_is_capacity_aware_and_leaves_unclaimed_tasks_pending(quiet_events):
    tenant = f"capacity-{uuid4()}"
    agent = _seed_agent(tenant)
    task_ids = set(_seed_tasks(tenant, 5))

    claimed = asyncio.run(task_routes.claim_pending(agent, slots=2))

    assert len(claimed) == 2
    assert {item["id"] for item in claimed} <= task_ids
    assert all(item["attempt_id"] and item["lease_expires_at"] for item in claimed)
    with get_db() as conn:
        states = conn.execute(
            "SELECT status, COUNT(*) AS count FROM tasks WHERE tenant_id=? GROUP BY status",
            (tenant,),
        ).fetchall()
    assert {row["status"]: row["count"] for row in states} == {"pending": 3, "running": 2}


def test_task_json_rejects_non_finite_values():
    with pytest.raises(HTTPException) as invalid:
        task_routes._encode_json({"score": float("nan")}, label="task payload")
    assert invalid.value.status_code == 422


def test_concurrent_claims_never_assign_one_task_twice(quiet_events):
    tenant = f"concurrent-claim-{uuid4()}"
    agents = [_seed_agent(tenant), _seed_agent(tenant)]
    task_ids = set(_seed_tasks(tenant, 4))

    with ThreadPoolExecutor(max_workers=2) as pool:
        claimed_batches = list(
            pool.map(
                lambda agent: asyncio.run(task_routes.claim_pending(agent, slots=3)),
                agents,
            )
        )

    claimed_ids = [item["id"] for batch in claimed_batches for item in batch]
    assert set(claimed_ids) == task_ids
    assert len(claimed_ids) == len(set(claimed_ids)) == 4


def test_expired_attempt_is_requeued_and_fenced_from_late_completion(
    quiet_events, monkeypatch
):
    tenant = f"fencing-{uuid4()}"
    agent = _seed_agent(tenant)
    task_id = _seed_tasks(tenant, 1)[0]
    first = asyncio.run(task_routes.claim_pending(agent, slots=1))[0]
    with get_db() as conn:
        conn.execute(
            "UPDATE tasks SET lease_expires_at=? WHERE id=?",
            ((_now() - timedelta(seconds=1)).isoformat(), task_id),
        )

    transitions = maintenance.reap_expired_tasks(current=_now())
    own_transitions = [item for item in transitions if item["task_id"] == task_id]
    assert own_transitions == [
        {
            "task_id": task_id,
            "tenant_id": tenant,
            "status": "pending",
            "retry_count": 1,
        }
    ]
    second = asyncio.run(task_routes.claim_pending(agent, slots=1))[0]
    assert second["attempt_id"] != first["attempt_id"]

    old_result = task_routes.TaskResultRequest(
        attempt_id=first["attempt_id"], status="success", output={"value": "old"}
    )
    with pytest.raises(HTTPException) as stale:
        asyncio.run(task_routes.submit_result(task_id, old_result, agent))
    assert stale.value.status_code == 409

    published: list[str] = []

    async def capture(_tenant, _task, status):
        published.append(status)

    monkeypatch.setattr(task_routes, "_publish_task_status", capture)
    current_result = task_routes.TaskResultRequest(
        attempt_id=second["attempt_id"], status="success", output={"value": "new"}
    )
    completed = asyncio.run(task_routes.submit_result(task_id, current_result, agent))
    duplicate = asyncio.run(task_routes.submit_result(task_id, current_result, agent))
    assert completed["duplicate"] is False
    assert duplicate["duplicate"] is True
    assert published == ["success"]

    conflicting = task_routes.TaskResultRequest(
        attempt_id=second["attempt_id"], status="success", output={"value": "different"}
    )
    with pytest.raises(HTTPException) as conflict:
        asyncio.run(task_routes.submit_result(task_id, conflicting, agent))
    assert conflict.value.status_code == 409


def test_heartbeat_renews_only_the_matching_fenced_attempt(quiet_events):
    tenant = f"heartbeat-{uuid4()}"
    agent = _seed_agent(tenant)
    task_id = _seed_tasks(tenant, 1)[0]
    claimed = asyncio.run(task_routes.claim_pending(agent, slots=1))[0]
    before = claimed["lease_expires_at"]

    body = agent_routes.HeartbeatRequest(
        status="busy",
        running_tasks=[
            agent_routes.RunningTaskRef(
                task_id=task_id,
                attempt_id=claimed["attempt_id"],
            )
        ],
    )
    renewed = agent_routes.heartbeat(body, agent)
    assert renewed["renewed_tasks"] == [task_id]
    assert renewed["rejected_tasks"] == []
    assert renewed["lease_expires_at"] >= before

    stale = agent_routes.HeartbeatRequest(
        status="busy",
        running_tasks=[
            agent_routes.RunningTaskRef(
                task_id=task_id,
                attempt_id=str(uuid4()),
            )
        ],
    )
    rejected = agent_routes.heartbeat(stale, agent)
    assert rejected["renewed_tasks"] == []
    assert rejected["rejected_tasks"] == [task_id]

    inconsistent = agent_routes.HeartbeatRequest(
        status="idle",
        running_tasks=[
            agent_routes.RunningTaskRef(
                task_id=task_id,
                attempt_id=claimed["attempt_id"],
            )
        ],
    )
    with pytest.raises(HTTPException) as invalid:
        agent_routes.heartbeat(inconsistent, agent)
    assert invalid.value.status_code == 422


def test_retry_limit_converges_to_a_durable_failure(quiet_events):
    tenant = f"retry-limit-{uuid4()}"
    agent = _seed_agent(tenant)
    task_id = _seed_tasks(tenant, 1)[0]
    claimed = asyncio.run(task_routes.claim_pending(agent, slots=1))[0]
    assert claimed["id"] == task_id
    with get_db() as conn:
        conn.execute(
            """UPDATE tasks SET retry_count=?, lease_expires_at=? WHERE id=?""",
            (
                maintenance.TASK_MAX_RETRIES,
                (_now() - timedelta(seconds=1)).isoformat(),
                task_id,
            ),
        )

    transitions = maintenance.reap_expired_tasks(current=_now())
    own = next(item for item in transitions if item["task_id"] == task_id)
    assert own["status"] == "failed"
    with get_db() as conn:
        row = conn.execute(
            "SELECT status, error, result_json FROM tasks WHERE id=?", (task_id,)
        ).fetchone()
    assert row["status"] == "failed"
    assert "retry limit" in row["error"]
    assert "retry limit" in json.loads(row["result_json"])["logs"]


def test_stale_agent_expires_its_claim_and_stale_session_releases_capacity(
    quiet_events,
):
    now = _now()
    tenant = f"stale-{uuid4()}"
    old_heartbeat = now - timedelta(seconds=maintenance.AGENT_STALE_SECONDS + 1)
    agent = _seed_agent(tenant, heartbeat=old_heartbeat)
    task_id = _seed_tasks(tenant, 1)[0]
    claimed = asyncio.run(task_routes.claim_pending(agent, slots=1))[0]
    assert claimed["id"] == task_id

    stale_agents = maintenance.expire_stale_agents(current=now)
    assert agent["id"] in stale_agents
    transitions = maintenance.reap_expired_tasks(current=now)
    own_transition = next(item for item in transitions if item["task_id"] == task_id)
    assert own_transition["status"] == "pending"

    user_id = f"user-{uuid4()}"
    session_id = str(uuid4())
    old_session = (now - timedelta(seconds=maintenance.SESSION_STALE_SECONDS + 1)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    with get_db() as conn:
        conn.execute(
            """INSERT INTO sessions
               (session_id, user_id, session_type, status, resources_json,
                metadata_json, created_at, last_heartbeat)
               VALUES (?, ?, 'interactive', 'active', '{}', '{}', ?, ?)""",
            (session_id, user_id, old_session, old_session),
        )
    assert maintenance.expire_stale_sessions(current=now) == [session_id]
    manager = SessionManager(max_sessions=1)
    assert manager.heartbeat(session_id, user_id) is False
    assert manager.create_session(
        user_id, "interactive", {"replacement": True}
    ).status == "active"


def test_schema_migrates_legacy_tasks_and_rejects_future_versions(tmp_path, monkeypatch):
    import sqlite3

    legacy = sqlite3.connect(tmp_path / "legacy.db")
    legacy.row_factory = sqlite3.Row
    legacy.execute(
        """CREATE TABLE tasks (
               id TEXT PRIMARY KEY,
               tenant_id TEXT NOT NULL DEFAULT 'local',
               task_type TEXT NOT NULL,
               payload_json TEXT NOT NULL DEFAULT '{}',
               status TEXT NOT NULL DEFAULT 'pending',
               assigned_agent_id INTEGER,
               result_json TEXT,
               error TEXT,
               delivered_at TEXT,
               correlation_id TEXT,
               idempotency_key TEXT,
               ack_received_at TEXT,
               response_received_at TEXT,
               retry_count INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
           )"""
    )
    monkeypatch.setattr(database, "_connect", lambda: legacy)
    database.init_db()
    columns = {row["name"] for row in legacy.execute("PRAGMA table_info(tasks)")}
    assert {"attempt_id", "lease_expires_at", "lease_heartbeat_at"} <= columns
    assert legacy.execute("PRAGMA user_version").fetchone()[0] == database.SCHEMA_VERSION
    indexes = {row["name"] for row in legacy.execute("PRAGMA index_list(tasks)")}
    assert "idx_tasks_running_lease" in indexes

    legacy.execute(f"PRAGMA user_version={database.SCHEMA_VERSION + 1}")
    with pytest.raises(RuntimeError, match="newer than supported"):
        database.init_db()
    legacy.close()
