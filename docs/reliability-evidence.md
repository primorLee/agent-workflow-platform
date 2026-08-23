# Reliability evidence

This document records what AWP's public task path proves, how to reproduce it,
and what it does **not** prove. It is an engineering regression record, not a
production-scale benchmark or an external-adoption claim.

## Delivery contract

The wired FastAPI → Python worker path provides bounded at-least-once delivery:

- a poll claims no more than the worker's advertised free slots;
- each claim has a UUID attempt fence and an expiring lease;
- heartbeats renew only the matching task, attempt, and agent;
- an expired lease requeues the task under a new attempt, up to a configured
  retry limit;
- a late stale-attempt result and a conflicting terminal replay receive `409`;
- an identical terminal replay is acknowledged without publishing a second
  terminal event;
- stale agent and session liveness rows stop consuming active capacity;
- SQLite lifecycle changes are versioned and startup rejects future schemas.

This is not exactly-once execution. Fencing protects the durable result, but a
process may have changed an external system before it died. Integrations must
use an application-level idempotency key or transaction for those effects.

## Reproducible gates

From an environment with the component dependencies already installed:

```text
python -m pytest services/control-plane/tests -q
python -m pytest services/worker-agent/tests -q
```

The control-plane suite covers concurrent claims, lease expiry, retry limits,
attempt fencing, heartbeat renewal, idempotent/conflicting terminal replay,
stale agent/session cleanup, and legacy/future schema handling. The worker
suite covers exact free-slot requests, authoritative task identity, heartbeat
attempts, overflow preservation, offline FIFO replay, and execution cleanup.

The real local container path is exercised with:

```text
docker compose -f deploy/local/docker-compose.local-dev.yml up -d --build
python scripts/wait_for_http.py http://127.0.0.1:8100/v1/health/ready --timeout 120 --json-field database
python scripts/submit_local_task.py --timeout 60
python scripts/verify_task_lifecycle.py --count 10 --timeout 120
python scripts/verify_worker_crash_recovery.py --timeout 120
```

The final command intentionally stops a busy demo worker, waits for its lease
to expire and its task to return to `pending`, restarts the worker, and requires
the task to succeed under a different attempt fence. CI runs these commands on
an ephemeral GitHub-hosted runner and removes the volumes afterward.

## Release-candidate record

Candidate date: 2026-08-24. Candidate commit: `2fd06b7`. The complete
[GitHub Actions run](https://github.com/primorLee/agent-workflow-platform/actions/runs/32662921171)
passed. Local component results below came from Windows with Python 3.12; the
container and Go records came from GitHub's Ubuntu runner.

| Gate | Result |
| --- | --- |
| Control-plane component suite | 159 passed, 5 skipped |
| Python-worker component suite | 89 passed, 9 skipped |
| Ten-task Compose backlog | 10/10 completed in 10.070 s; 0.993 tasks/s; median 5.802 s; p95/max 9.898 s |
| Hard worker-crash recovery | Worker killed; lease requeued; retry count 1; new attempt fence; success in 28.865 s |
| Go VM-agent gate | Tests, replay stress, vet, disposable build, race detector, and official vulnerability scan passed |
| Complete-history security gates | Public-boundary validation, Gitleaks, and TruffleHog passed |

The skipped cases are platform/dependency-qualified tests already reported by
pytest; they are not counted as passes. The exact container JSON is retained in
the successful
[Compose job](https://github.com/primorLee/agent-workflow-platform/actions/runs/32662921171/job/97251695185),
and the process-supervision checks are retained in the successful
[Go job](https://github.com/primorLee/agent-workflow-platform/actions/runs/32662921171/job/97251695172).

## Benchmark interpretation

`verify_task_lifecycle.py` emits elapsed time, completed task count, throughput,
and min/median/p95/max end-to-end latency for ten trivial allow-listed commands.
That number detects severe regressions and dropped work in the reference stack.
It must not be extrapolated to model inference, remote networks, multi-node
SQLite, or production concurrency. A claim about those environments requires a
separate workload, hardware description, repetitions, and confidence interval.
