from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

import rollout
from database import _SCHEMA


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    return conn


def _insert_version(
    conn: sqlite3.Connection,
    version: str,
    stage: str,
    *,
    entered_at: str | None = None,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO agent_versions
           (version, stage, published_at, entered_stage_at,
            download_url, sig_url, sha256, min_protocol, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, '')""",
        (
            version,
            stage,
            now,
            entered_at or now,
            f"https://releases.example.invalid/releases/{version}",
            f"https://releases.example.invalid/releases/{version}.sig",
            "0" * 64,
        ),
    )


def _insert_agent(conn: sqlite3.Connection, name: str) -> int:
    cursor = conn.execute(
        """INSERT INTO agents (tenant_id, hostname, token_hash, status, version)
           VALUES ('local', ?, ?, 'online', '')""",
        (name, f"token-{name}"),
    )
    return int(cursor.lastrowid)


def _link_agent(conn: sqlite3.Connection, agent_id: int, version: str) -> None:
    rollout.record_event(
        conn,
        event_type="check",
        agent_id=agent_id,
        tenant_id="local",
        to_ver=version,
    )
    rollout.record_event(
        conn,
        event_type="post_update_ok",
        agent_id=agent_id,
        tenant_id="local",
        to_ver=version,
    )


def _insert_tasks(
    conn: sqlite3.Connection,
    *,
    agent_id: int,
    prefix: str,
    success: int,
    failed: int,
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    statuses = ["success"] * success + ["failed"] * failed
    for index, status in enumerate(statuses):
        conn.execute(
            """INSERT INTO tasks
               (id, tenant_id, task_type, payload_json, status,
                assigned_agent_id, response_received_at, created_at, updated_at)
               VALUES (?, 'local', 'command', '{}', ?, ?, ?, ?, ?)""",
            (f"{prefix}-{index}", status, agent_id, now, now, now),
        )


def test_assignment_is_sticky_and_opt_out_uses_stable():
    conn = _db()
    _insert_version(conn, "1.0.0", rollout.STAGE_STABLE)
    _insert_version(conn, "2.0.0", rollout.STAGE_CANARY_50)
    versions = rollout.list_versions(conn)

    first = rollout.version_for("tenant-demo", versions)
    second = rollout.version_for("tenant-demo", versions)
    opted_out = rollout.version_for("tenant-demo", versions, canary_flag="optout")

    assert first == second
    assert opted_out.version is not None
    assert opted_out.version.version == "1.0.0"


def test_bucket_distribution_gate_over_100000_deterministic_tenants():
    counts = [0] * 100
    for index in range(100_000):
        bucket = rollout.bucket_for(f"tenant-{index:06d}")
        assert 0 <= bucket < 100
        counts[bucket] += 1

    expected = 1_000
    chi_square = sum((count - expected) ** 2 / expected for count in counts)
    assert chi_square < 160


def test_publish_version_requires_pinned_https_signature_and_sha(monkeypatch):
    monkeypatch.delenv("AWP_AGENT_RELEASE_ALLOWED_PREFIXES", raising=False)
    conn = _db()

    row = rollout.publish_version(
        conn,
        version="1.2.3",
        download_url="https://releases.example.invalid/releases/awp-vm-agent-1.2.3",
        sig_url="https://releases.example.invalid/releases/awp-vm-agent-1.2.3.sig",
        sha256="A" * 64,
    )
    assert row.version == "1.2.3"
    assert row.sha256 == "a" * 64

    invalid = [
        ("http://releases.example.invalid/releases/agent", "https://releases.example.invalid/releases/agent.sig", "b" * 64),
        ("https://user" + ":pass@releases.example.invalid/releases/agent", "https://releases.example.invalid/releases/agent.sig", "b" * 64),
        ("https://releases.example.invalid/other/agent", "https://releases.example.invalid/releases/agent.sig", "b" * 64),
        ("https://releases.example.invalid/releases/agent?token=secret", "https://releases.example.invalid/releases/agent.sig", "short"),
        ("https://releases.example.invalid/releases/agent", "", "b" * 64),
    ]
    for download_url, sig_url, digest in invalid:
        with pytest.raises(ValueError):
            rollout.publish_version(
                conn,
                version="1.2.4",
                download_url=download_url,
                sig_url=sig_url,
                sha256=digest,
            )
    with pytest.raises(ValueError):
        rollout.publish_version(
            conn,
            version="../escape",
            download_url="https://releases.example.invalid/releases/agent",
            sig_url="https://releases.example.invalid/releases/agent.sig",
            sha256="b" * 64,
        )
    with pytest.raises(ValueError):
        rollout.publish_version(
            conn,
            version="1.2.5",
            download_url="https://releases.example.invalid/releases/agent",
            sig_url="https://releases.example.invalid/releases/agent.sig",
            sha256="b" * 64,
            initial_stage=rollout.STAGE_STABLE,
        )
    assert conn.execute("SELECT COUNT(*) FROM agent_versions").fetchone()[0] == 1


def test_published_version_is_immutable_but_exact_retry_is_idempotent(monkeypatch):
    monkeypatch.delenv("AWP_AGENT_RELEASE_ALLOWED_PREFIXES", raising=False)
    conn = _db()
    payload = {
        "version": "3.0.0",
        "download_url": "https://releases.example.invalid/releases/agent-3.0.0",
        "sig_url": "https://releases.example.invalid/releases/agent-3.0.0.sig",
        "sha256": "c" * 64,
        "min_protocol": 2,
        "notes": "verified release",
    }
    first = rollout.publish_version(conn, **payload)
    rollout.set_stage(conn, "3.0.0", rollout.STAGE_CANARY_10)
    retried = rollout.publish_version(conn, **payload)
    assert retried.id == first.id
    assert retried.stage == rollout.STAGE_CANARY_10

    for key, changed in (
        ("download_url", "https://releases.example.invalid/releases/other"),
        ("sig_url", "https://releases.example.invalid/releases/other.sig"),
        ("sha256", "d" * 64),
        ("min_protocol", 3),
        ("notes", "changed"),
    ):
        with pytest.raises(ValueError, match="immutable"):
            rollout.publish_version(conn, **(payload | {key: changed}))
    recorded = rollout.get_version(conn, "3.0.0")
    assert recorded is not None
    assert recorded.sha256 == "c" * 64
    assert recorded.notes == "verified release"


def test_custom_release_prefix_rejects_private_and_legacy_numeric_hosts(monkeypatch):
    monkeypatch.setenv(
        "AWP_AGENT_RELEASE_ALLOWED_PREFIXES",
        "https://cdn.example.com/awp/releases/",
    )
    conn = _db()
    rollout.publish_version(
        conn,
        version="2.0.0",
        download_url="https://cdn.example.com/awp/releases/agent",
        sig_url="https://cdn.example.com/awp/releases/agent.sig",
        sha256="c" * 64,
    )
    with pytest.raises(ValueError):
        rollout.publish_version(
            conn,
            version="2.0.1",
            download_url="https://cdn.example.com/other/agent",
            sig_url="https://cdn.example.com/awp/releases/agent.sig",
            sha256="d" * 64,
        )

    hosts = [
        ".".join(("10", "0", "0", "5")),
        ".".join(("127", "1")),
        ".".join(("0x7f", "0", "0", "1")),
        ".".join(("0177", "0", "0", "1")),
    ]
    for index, host in enumerate(hosts):
        prefix = f"https://{host}/releases/"
        monkeypatch.setenv("AWP_AGENT_RELEASE_ALLOWED_PREFIXES", prefix)
        with pytest.raises(ValueError):
            rollout.publish_version(
                conn,
                version=f"2.1.{index}",
                download_url=prefix + "agent",
                sig_url=prefix + "agent.sig",
                sha256="e" * 64,
            )


def test_real_schema_metrics_roll_back_red_canary_without_monkeypatching():
    conn = _db()
    _insert_version(conn, "1.0.0", rollout.STAGE_STABLE)
    _insert_version(conn, "2.0.0", rollout.STAGE_CANARY_10)
    stable_agent = _insert_agent(conn, "stable")
    canary_agent = _insert_agent(conn, "canary")
    _link_agent(conn, stable_agent, "1.0.0")
    _link_agent(conn, canary_agent, "2.0.0")
    _insert_tasks(conn, agent_id=stable_agent, prefix="stable", success=99, failed=1)
    _insert_tasks(conn, agent_id=canary_agent, prefix="canary", success=16, failed=4)

    metrics = rollout.compute_metrics(conn, "2.0.0")
    assert metrics.samples == 20
    assert metrics.error_rate == pytest.approx(0.20)
    assert rollout.baseline_error_rate(conn) == pytest.approx(0.01)

    actions = rollout.evaluate_rollout(conn)
    assert actions[0]["action"] == "rollback"
    assert rollout.get_version(conn, "2.0.0").stage == rollout.STAGE_ROLLED_BACK
    assert rollout.get_version(conn, "1.0.0").stage == rollout.STAGE_STABLE


def test_real_schema_metrics_promote_green_canary_after_dwell():
    conn = _db()
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    _insert_version(conn, "1.0.0", rollout.STAGE_STABLE)
    _insert_version(conn, "2.0.0", rollout.STAGE_CANARY_1, entered_at=old)
    stable_agent = _insert_agent(conn, "stable-green")
    canary_agent = _insert_agent(conn, "canary-green")
    _link_agent(conn, stable_agent, "1.0.0")
    _link_agent(conn, canary_agent, "2.0.0")
    _insert_tasks(conn, agent_id=stable_agent, prefix="stable-green", success=99, failed=1)
    _insert_tasks(conn, agent_id=canary_agent, prefix="canary-green", success=20, failed=0)

    actions = rollout.evaluate_rollout(conn, now=datetime.now(timezone.utc))
    assert actions == [
        {
            "version": "2.0.0",
            "action": "promote",
            "from_stage": rollout.STAGE_CANARY_1,
            "to_stage": rollout.STAGE_CANARY_10,
            "metrics": actions[0]["metrics"],
        }
    ]
    assert rollout.get_version(conn, "2.0.0").stage == rollout.STAGE_CANARY_10