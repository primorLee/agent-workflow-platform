from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import database
import session_manager
from auth import require_dev_key
from server import app


def _isolated_database(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "session-data"
    monkeypatch.setattr(database, "DATA_DIR", root)
    monkeypatch.setattr(database, "DATABASE_URL", str(root / "sessions.db"))
    monkeypatch.delenv("AWP_DATA_ROOT_BOOTSTRAP", raising=False)
    database.init_db()


def test_session_routes_never_cross_authenticated_user(monkeypatch, tmp_path):
    _isolated_database(monkeypatch, tmp_path)
    identity = {"user": "tenant-a"}
    app.dependency_overrides[require_dev_key] = lambda: identity["user"]
    try:
        with TestClient(app) as client:
            created = client.post(
                "/v1/sessions",
                json={"session_type": "interactive", "metadata": {"purpose": "demo"}},
            )
            assert created.status_code == 200
            session_id = created.json()["session_id"]

            identity["user"] = "tenant-b"
            assert client.post(f"/v1/sessions/{session_id}/heartbeat").status_code == 404
            assert client.delete(f"/v1/sessions/{session_id}").status_code == 404
            assert client.get("/v1/sessions").json() == []

            identity["user"] = "tenant-a"
            assert client.post(f"/v1/sessions/{session_id}/heartbeat").status_code == 200
            assert len(client.get("/v1/sessions").json()) == 1
            assert client.delete(f"/v1/sessions/{session_id}?reason=user_request").status_code == 200
    finally:
        app.dependency_overrides.pop(require_dev_key, None)


def test_global_capacity_is_atomic_under_concurrent_creates(monkeypatch, tmp_path):
    _isolated_database(monkeypatch, tmp_path)
    manager = session_manager.SessionManager(max_sessions=3)

    def create(index: int):
        try:
            return manager.create_session(f"tenant-{index}", "batch").session_id
        except RuntimeError:
            return None

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(create, range(20)))
    assert sum(result is not None for result in results) == 3
    with database.get_db() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM sessions WHERE status='active'",
        ).fetchone()[0] == 3


def test_per_user_capacity_is_atomic_under_concurrent_creates(monkeypatch, tmp_path):
    _isolated_database(monkeypatch, tmp_path)
    monkeypatch.setattr(session_manager, "MAX_SESSIONS_PER_USER", 2)
    manager = session_manager.SessionManager(max_sessions=20)

    def create(_index: int):
        try:
            return manager.create_session("same-tenant", "review").session_id
        except PermissionError:
            return None

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(create, range(12)))
    assert sum(result is not None for result in results) == 2


def test_session_limits_must_be_positive():
    with pytest.raises(ValueError, match="positive"):
        session_manager.SessionManager(max_sessions=0)
    with pytest.raises(ValueError, match="positive"):
        session_manager.SessionManager(max_sessions=-1)


def test_resource_values_are_documented_as_hints_only():
    source = Path(session_manager.__file__).read_text(encoding="utf-8")
    assert "scheduling hints" in source
    assert "does not allocate CPU" in source
    assert "release resources" not in source
    assert "resource isolation" not in source