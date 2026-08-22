"""Canary rollout state machine + cohort assignment.

Implements the logic described in
``this module and its regression tests``:

- Deterministic sticky cohort assignment via SHA256(tenant_id) % 100.
- Stage ordering: draft < canary-1 < canary-10 < canary-50 < stable.
- Target-version selection respects explicit opt-in / opt-out flags.
- Metric evaluator polled every 5 minutes by ``watcher_loop`` —
  promotes a canary when its dwell window is met and all green criteria
  hold, or rolls back when any red criterion trips.

All functions are pure Python + sqlite3, safe to unit-test with an
in-memory DB (see ``tests/test_rollout.py``).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from rollout_url_policy import validate_release_urls

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stage model
# ---------------------------------------------------------------------------

STAGE_DRAFT = "draft"
STAGE_CANARY_1 = "canary-1"
STAGE_CANARY_10 = "canary-10"
STAGE_CANARY_50 = "canary-50"
STAGE_STABLE = "stable"
STAGE_ROLLED_BACK = "rolled-back"
STAGE_SUPERSEDED = "superseded"

_STAGE_ORDER: dict[str, int] = {
    STAGE_DRAFT: 0,
    STAGE_CANARY_1: 1,
    STAGE_CANARY_10: 2,
    STAGE_CANARY_50: 3,
    STAGE_STABLE: 4,
    STAGE_ROLLED_BACK: -1,
    STAGE_SUPERSEDED: -2,
}

_STAGE_COHORT_PCT: dict[str, int] = {
    STAGE_CANARY_1: 1,
    STAGE_CANARY_10: 10,
    STAGE_CANARY_50: 50,
    STAGE_STABLE: 100,
}

_NEXT_STAGE: dict[str, str] = {
    STAGE_CANARY_1: STAGE_CANARY_10,
    STAGE_CANARY_10: STAGE_CANARY_50,
    STAGE_CANARY_50: STAGE_STABLE,
}

# Dwell defaults (24h). Unit tests may monkey-patch via module attribute.
DEFAULT_DWELL_SECONDS: int = 24 * 3600
MIN_SAMPLES_FOR_PROMOTE: int = 20

# Red criteria thresholds
MAX_ERROR_RATE_MULT = 5.0        # current err/baseline err
MIN_CONNECT_SUCCESS = 0.95
MIN_TASK_SUCCESS = 0.90
MAX_UPGRADE_FAIL_RATE = 0.01


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class VersionRow:
    """Immutable view of a row in ``agent_versions``."""
    id: int
    version: str
    stage: str
    published_at: str
    entered_stage_at: str
    download_url: str
    sig_url: str
    sha256: str
    min_protocol: int
    notes: str = ""

    @classmethod
    def from_row(cls, row: sqlite3.Row | dict) -> "VersionRow":
        return cls(
            id=int(row["id"]),
            version=str(row["version"]),
            stage=str(row["stage"]),
            published_at=str(row["published_at"]),
            entered_stage_at=str(row["entered_stage_at"]),
            download_url=str(row["download_url"]),
            sig_url=str(row["sig_url"]),
            sha256=str(row["sha256"]),
            min_protocol=int(row["min_protocol"]),
            notes=str(row["notes"]) if row["notes"] is not None else "",
        )


@dataclass(frozen=True)
class Assignment:
    """Result of version_for() — which version a tenant should run."""
    version: Optional[VersionRow]
    bucket: int
    reason: str   # 'stable-fallback' | 'canary-match' | 'opt-in' | 'opt-out' | 'none'


# ---------------------------------------------------------------------------
# Cohort assignment
# ---------------------------------------------------------------------------

def bucket_for(tenant_id: str) -> int:
    """Deterministic bucket 0..99 for a ``tenant_id``.

    Uses the first 8 bytes of SHA256(tenant_id) big-endian mod 100. A
    deterministic 100,000-tenant distribution gate guards gross skew.
    """
    if not isinstance(tenant_id, str):
        raise TypeError("tenant_id must be str")
    if tenant_id == "":
        raise ValueError("tenant_id must be non-empty")
    h = hashlib.sha256(tenant_id.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") % 100


def stage_order(stage: str) -> int:
    return _STAGE_ORDER.get(stage, -99)


def stage_cohort_pct(stage: str) -> int:
    return _STAGE_COHORT_PCT.get(stage, 0)


def version_for(
    tenant_id: str,
    versions: Iterable[VersionRow],
    *,
    canary_flag: Optional[str] = None,
) -> Assignment:
    """Choose the target version for ``tenant_id``.

    Rules:
      - ``canary_flag='optout'`` → always highest ``stable``, never canary.
      - ``canary_flag='optin'``  → always the highest-stage non-stable
        canary if any, else stable.
      - Otherwise, iterate versions from highest stage to lowest; first
        version whose cohort_pct > bucket is the winner.
      - Fall back to stable if no canary matches.
    """
    b = bucket_for(tenant_id)
    live = [v for v in versions
            if v.stage in (STAGE_CANARY_1, STAGE_CANARY_10,
                           STAGE_CANARY_50, STAGE_STABLE)]
    if not live:
        return Assignment(version=None, bucket=b, reason="none")

    stables = sorted(
        [v for v in live if v.stage == STAGE_STABLE],
        key=lambda v: v.entered_stage_at,
        reverse=True,
    )
    canaries = sorted(
        [v for v in live if v.stage != STAGE_STABLE],
        key=lambda v: stage_order(v.stage),
        reverse=True,
    )
    stable = stables[0] if stables else None

    if canary_flag == "optout":
        return Assignment(version=stable, bucket=b, reason="opt-out")

    if canary_flag == "optin":
        return Assignment(
            version=canaries[0] if canaries else stable,
            bucket=b,
            reason="opt-in",
        )

    # Default: smallest cohort first — bucket 0 gets canary-1 even when
    # larger canaries exist.
    canaries_small_first = sorted(canaries, key=lambda v: stage_order(v.stage))
    for v in canaries_small_first:
        if b < stage_cohort_pct(v.stage):
            return Assignment(version=v, bucket=b, reason="canary-match")

    return Assignment(version=stable, bucket=b, reason="stable-fallback")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def list_versions(conn: sqlite3.Connection) -> list[VersionRow]:
    rows = conn.execute(
        "SELECT * FROM agent_versions ORDER BY entered_stage_at DESC"
    ).fetchall()
    return [VersionRow.from_row(r) for r in rows]


def get_version(conn: sqlite3.Connection, version: str) -> Optional[VersionRow]:
    row = conn.execute(
        "SELECT * FROM agent_versions WHERE version = ?", (version,),
    ).fetchone()
    return VersionRow.from_row(row) if row else None


def publish_version(
    conn: sqlite3.Connection,
    *,
    version: str,
    download_url: str,
    sig_url: str,
    sha256: str,
    min_protocol: int = 1,
    initial_stage: str = STAGE_CANARY_1,
    notes: str = "",
) -> VersionRow:
    """Insert an immutable release, or return an exact idempotent match.

    Once a version exists, its artifact URLs, digest, protocol floor, and
    notes cannot change. Publish changed bytes under a new version.
    """
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]{0,63}", version):
        raise ValueError("version must be a canonical 1-64 character identifier")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise ValueError("sha256 must be exactly 64 hexadecimal characters")
    if initial_stage not in {STAGE_DRAFT, STAGE_CANARY_1}:
        raise ValueError("initial_stage is not recognized")
    if min_protocol < 1:
        raise ValueError("min_protocol must be positive")
    validate_release_urls((download_url, sig_url))
    sha256 = sha256.lower()

    existing = get_version(conn, version)
    now = datetime.now(timezone.utc).isoformat()

    if existing:
        supplied = (download_url, sig_url, sha256, min_protocol, notes)
        recorded = (
            existing.download_url,
            existing.sig_url,
            existing.sha256,
            existing.min_protocol,
            existing.notes,
        )
        if supplied != recorded:
            raise ValueError("published version metadata is immutable")
        return existing

    conn.execute(
        """INSERT INTO agent_versions
               (version, stage, published_at, entered_stage_at,
                download_url, sig_url, sha256, min_protocol, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (version, initial_stage, now, now,
         download_url, sig_url, sha256, min_protocol, notes),
    )
    row = get_version(conn, version)
    assert row is not None
    return row


def record_event(
    conn: sqlite3.Connection,
    *,
    event_type: str,
    agent_id: Optional[int] = None,
    tenant_id: Optional[str] = None,
    from_ver: Optional[str] = None,
    to_ver: Optional[str] = None,
    details: Optional[dict] = None,
) -> None:
    conn.execute(
        """INSERT INTO agent_version_events
               (agent_id, tenant_id, event_type,
                from_ver, to_ver, details_json)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (agent_id, tenant_id, event_type, from_ver, to_ver,
         json.dumps(details or {}, ensure_ascii=False)),
    )


def set_stage(
    conn: sqlite3.Connection,
    version: str,
    new_stage: str,
    *,
    reason: str = "",
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """UPDATE agent_versions
              SET stage = ?, entered_stage_at = ?,
                  notes = CASE WHEN ? = '' THEN notes
                               ELSE COALESCE(notes,'') || char(10) || ? END
            WHERE version = ?""",
        (new_stage, now, reason, f"[{now}] {reason}", version),
    )
    record_event(
        conn,
        event_type="stage_change",
        to_ver=version,
        details={"new_stage": new_stage, "reason": reason},
    )


# ---------------------------------------------------------------------------
# Metrics evaluator
# ---------------------------------------------------------------------------

@dataclass
class VersionMetrics:
    version: str
    samples: int
    error_rate: float
    connect_success: float
    task_success: float
    upgrade_fail_rate: float
    baseline_error_rate: float = 0.0


def compute_metrics(
    conn: sqlite3.Connection,
    version: str,
    *,
    window_minutes: int = 10,
) -> VersionMetrics:
    """Aggregate metrics from ``agent_version_events`` + ``tasks``.

    Reads the same ``agent_version_events`` and ``tasks`` schema used by
    the control plane; regression tests initialize that production schema.
    """
    # Use SQLite-native datetime() for cutoff so it lexicographically
    # compares with both ``datetime('now')`` (space-separated, no TZ)
    # and Python ``isoformat()`` (T-separated, +00:00 suffix). SQLite's
    # datetime() renders as "YYYY-MM-DD HH:MM:SS"; ISO8601 with 'T' and
    # +00:00 always sorts greater under TEXT compare, so we convert all
    # stored values and the cutoff into a canonical form via datetime().
    cutoff_py = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    cutoff_sql = cutoff_py.strftime("%Y-%m-%d %H:%M:%S")

    # Upgrade success / fail from version events
    row = conn.execute(
        """SELECT
               SUM(CASE WHEN event_type = 'post_update_ok' THEN 1 ELSE 0 END) AS ok,
               SUM(CASE WHEN event_type IN ('verify_fail','swap_fail',
                                            'post_update_fail','download_fail')
                        THEN 1 ELSE 0 END) AS fail,
               COUNT(*) AS total
             FROM agent_version_events
            WHERE to_ver = ? AND datetime(created_at) >= datetime(?)""",
        (version, cutoff_sql),
    ).fetchone()
    ok = (row["ok"] or 0) if row else 0
    fail = (row["fail"] or 0) if row else 0
    upgrade_total = ok + fail
    upgrade_fail_rate = (fail / upgrade_total) if upgrade_total else 0.0

    # Task-level success / error from tasks if the table exists.
    has_sim = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).fetchone() is not None

    samples = 0
    error_rate = 0.0
    task_success = 1.0
    if has_sim:
        # tie tasks to version via agent_version_events.check entries
        sim_row = conn.execute(
            """SELECT
                  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succ,
                  SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS err,
                  COUNT(*)                                            AS n
                FROM tasks
               WHERE response_received_at IS NOT NULL
                 AND datetime(response_received_at) >= datetime(?)
                 AND assigned_agent_id IN (
                     SELECT DISTINCT agent_id FROM agent_version_events
                      WHERE to_ver = ? AND agent_id IS NOT NULL
                        AND datetime(created_at) >= datetime(?))""",
            (cutoff_sql, version, cutoff_sql),
        ).fetchone()
        samples = (sim_row["n"] or 0) if sim_row else 0
        if samples:
            task_success = (sim_row["succ"] or 0) / samples
            error_rate = (sim_row["err"] or 0) / samples

    # A check event is a successful connection probe; connect_fail is a
    # failed attempt. Use both in the denominator so the rate stays in [0, 1].
    connect_row = conn.execute(
        """SELECT
              SUM(CASE WHEN event_type = 'check' THEN 1 ELSE 0 END) AS checks,
              SUM(CASE WHEN event_type = 'connect_fail' THEN 1 ELSE 0 END) AS fails
            FROM agent_version_events
           WHERE to_ver = ? AND datetime(created_at) >= datetime(?)""",
        (version, cutoff_sql),
    ).fetchone()
    checks = (connect_row["checks"] or 0) if connect_row else 0
    cfails = (connect_row["fails"] or 0) if connect_row else 0
    connect_total = checks + cfails
    connect_success = (checks / connect_total) if connect_total else 1.0

    return VersionMetrics(
        version=version,
        samples=samples,
        error_rate=error_rate,
        connect_success=connect_success,
        task_success=task_success,
        upgrade_fail_rate=upgrade_fail_rate,
    )


def baseline_error_rate(conn: sqlite3.Connection, *, days: int = 7) -> float:
    """Return completed-task error rate for stable-version agents only.

    An agent is included only when its latest recorded version event points
    to a stable or superseded release. With no linked stable samples the
    conservative baseline is zero.
    """
    cutoff_sql = (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).strftime("%Y-%m-%d %H:%M:%S")
    row = conn.execute(
        """SELECT
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS err,
              COUNT(*)                                           AS n
            FROM tasks
           WHERE response_received_at IS NOT NULL
             AND datetime(response_received_at) >= datetime(?)
             AND assigned_agent_id IN (
                 SELECT latest.agent_id
                   FROM agent_version_events AS latest
                   JOIN agent_versions AS version
                     ON version.version = latest.to_ver
                  WHERE latest.agent_id IS NOT NULL
                    AND version.stage IN ('stable', 'superseded')
                    AND latest.id = (
                        SELECT MAX(candidate.id)
                          FROM agent_version_events AS candidate
                         WHERE candidate.agent_id = latest.agent_id
                           AND candidate.to_ver IS NOT NULL
                    )
             )""",
        (cutoff_sql,),
    ).fetchone()
    n = (row["n"] or 0) if row else 0
    if not n:
        return 0.0
    return (row["err"] or 0) / n

def is_green(m: VersionMetrics) -> tuple[bool, str]:
    """Apply green criteria; return (ok, reason_if_not_ok)."""
    if m.samples < MIN_SAMPLES_FOR_PROMOTE:
        return False, f"insufficient samples ({m.samples} < {MIN_SAMPLES_FOR_PROMOTE})"
    base = max(m.baseline_error_rate, 1e-6)
    if m.error_rate / base > MAX_ERROR_RATE_MULT:
        return False, (f"error_rate {m.error_rate:.3f} > "
                       f"{MAX_ERROR_RATE_MULT}x baseline ({base:.3f})")
    if m.connect_success < MIN_CONNECT_SUCCESS:
        return False, f"connect_success {m.connect_success:.3f} < {MIN_CONNECT_SUCCESS}"
    if m.task_success < MIN_TASK_SUCCESS:
        return False, f"task_success {m.task_success:.3f} < {MIN_TASK_SUCCESS}"
    if m.upgrade_fail_rate > MAX_UPGRADE_FAIL_RATE:
        return False, f"upgrade_fail_rate {m.upgrade_fail_rate:.3f} > {MAX_UPGRADE_FAIL_RATE}"
    return True, ""


# ---------------------------------------------------------------------------
# Promote / rollback
# ---------------------------------------------------------------------------

def _parse_iso(s: str) -> datetime:
    # Python 3.11+ handles 'Z' and offsets; our rows use isoformat()
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def evaluate_rollout(
    conn: sqlite3.Connection,
    *,
    now: Optional[datetime] = None,
    dwell_seconds: int = DEFAULT_DWELL_SECONDS,
    notifier=None,
) -> list[dict]:
    """Run one evaluation pass: promote or rollback each canary.

    Returns a list of action records for logging. Pure function given a
    fixed ``now`` + ``dwell_seconds`` + a DB state — easy to unit-test.
    """
    actions: list[dict] = []
    now = now or datetime.now(timezone.utc)
    baseline = baseline_error_rate(conn)

    for v in list_versions(conn):
        if v.stage not in (STAGE_CANARY_1, STAGE_CANARY_10, STAGE_CANARY_50):
            continue

        m = compute_metrics(conn, v.version)
        m.baseline_error_rate = baseline
        green, reason = is_green(m)

        # Red → rollback
        if not green and m.samples >= MIN_SAMPLES_FOR_PROMOTE:
            set_stage(conn, v.version, STAGE_ROLLED_BACK,
                      reason=f"auto rollback: {reason}")
            _restore_prev_stable(conn, failed_version=v.version)
            actions.append({
                "version": v.version,
                "action": "rollback",
                "reason": reason,
                "metrics": m.__dict__,
            })
            if notifier is not None:
                try:
                    notifier(
                        kind="rollback", version=v.version,
                        reason=reason, metrics=m.__dict__,
                    )
                except Exception:
                    _log.exception("notifier failed")
            continue

        # Green + dwell met → promote
        entered = _parse_iso(v.entered_stage_at)
        dwell_s = (now - entered).total_seconds()
        if green and dwell_s >= dwell_seconds:
            nxt = _NEXT_STAGE.get(v.stage)
            if nxt is None:
                continue
            set_stage(conn, v.version, nxt,
                      reason=f"auto promote from {v.stage} (dwell {dwell_s:.0f}s)")
            if nxt == STAGE_STABLE:
                _supersede_previous_stable(conn, new_stable=v.version)
            actions.append({
                "version": v.version,
                "action": "promote",
                "from_stage": v.stage,
                "to_stage": nxt,
                "metrics": m.__dict__,
            })

    return actions


def _restore_prev_stable(
    conn: sqlite3.Connection, *, failed_version: str,
) -> Optional[VersionRow]:
    """Pick the most recent non-failed stable and ensure it's the target."""
    row = conn.execute(
        """SELECT * FROM agent_versions
            WHERE stage IN ('stable','superseded') AND version != ?
            ORDER BY entered_stage_at DESC LIMIT 1""",
        (failed_version,),
    ).fetchone()
    if not row:
        return None
    v = VersionRow.from_row(row)
    if v.stage != STAGE_STABLE:
        set_stage(conn, v.version, STAGE_STABLE,
                  reason=f"restore after rollback of {failed_version}")
    return v


def _supersede_previous_stable(
    conn: sqlite3.Connection, *, new_stable: str,
) -> None:
    conn.execute(
        """UPDATE agent_versions
              SET stage = 'superseded'
            WHERE stage = 'stable' AND version != ?""",
        (new_stable,),
    )


def operator_pin(
    conn: sqlite3.Connection, *, version: str, reason: str,
) -> VersionRow:
    """Operator hard-pin: mark given version as stable, all canaries → rolled-back."""
    existing = get_version(conn, version)
    if not existing:
        raise ValueError(f"unknown version: {version}")

    # All live canaries go to rolled-back
    for v in list_versions(conn):
        if v.stage in (STAGE_CANARY_1, STAGE_CANARY_10, STAGE_CANARY_50):
            set_stage(conn, v.version, STAGE_ROLLED_BACK,
                      reason=f"Operator pin override: {reason}")

    # Target version → stable
    if existing.stage != STAGE_STABLE:
        set_stage(conn, version, STAGE_STABLE, reason=f"Operator pin: {reason}")
    _supersede_previous_stable(conn, new_stable=version)

    record_event(
        conn, event_type="operator_pin", to_ver=version,
        details={"reason": reason},
    )
    return get_version(conn, version)  # type: ignore[return-value]


def check_downgrade_safe(
    conn: sqlite3.Connection,
    *,
    agent_current_version: str,
    target_version: str,
) -> tuple[bool, str]:
    """Reject downgrade that would cross a ``min_protocol`` bump."""
    cur = get_version(conn, agent_current_version)
    tgt = get_version(conn, target_version)
    if not cur or not tgt:
        return True, ""   # unknown versions — let the caller decide
    if tgt.min_protocol < cur.min_protocol:
        return False, (f"downgrade blocked: target {target_version} "
                       f"min_protocol={tgt.min_protocol} < current "
                       f"{agent_current_version} min_protocol={cur.min_protocol}")
    return True, ""


# ---------------------------------------------------------------------------
# Async watcher loop for an explicitly composed host
# ---------------------------------------------------------------------------

async def watcher_loop(
    get_conn,
    *,
    interval_s: int = 300,
    notifier=None,
    stop_event: Optional[asyncio.Event] = None,
) -> None:
    """Poll using a host-supplied connection factory. Cancellation-safe."""
    while True:
        if stop_event and stop_event.is_set():
            return
        try:
            with get_conn() as conn:
                actions = evaluate_rollout(conn, notifier=notifier)
                if actions:
                    _log.info("rollout actions: %s", actions)
                conn.commit() if hasattr(conn, "commit") else None
        except Exception:
            _log.exception("rollout watcher iteration failed")
        try:
            await asyncio.wait_for(
                (stop_event.wait() if stop_event else asyncio.sleep(interval_s)),
                timeout=interval_s,
            )
        except asyncio.TimeoutError:
            pass
