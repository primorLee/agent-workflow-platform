# Agent Workflow Platform control plane

This service is the local-first public control plane extracted from a retired
production Agent platform. It preserves the state transitions, authentication,
event fan-out, failure handling, and operational checks while removing private
product identity and deployment endpoints.

## What is wired

`cloud/server.py` owns the supported FastAPI lifecycle:

- numeric-loopback-only bind validation at configuration and request time;
- SQLite WAL liveness/readiness and private data-root validation;
- operator-key-authenticated worker registration;
- agent-token-authenticated heartbeat, polling, and result reporting;
- idempotent task submission, listing, and inspection;
- authenticated session metadata create/list/heartbeat/termination;
- authenticated task status SSE at `/v1/events/tasks/{task_id}`;
- in-memory fan-out or strict Redis fan-out;
- server-minted request IDs, bounded rate limiting, redacted structured logs,
  and Prometheus metrics.

Task creation, claim, and terminal result transitions publish through the same
broker consumed by SSE. `AWP_WS_BROKER=redis` therefore changes the live event
path. Redis configuration is fail-closed: the URL, dependency, initialization,
and readiness must succeed; the service never silently falls back to memory.

The session API is a liveness and scheduling-metadata registry. Values under
`resources` are hints only; this service does not allocate or enforce CPU,
memory, disk, containers, or OS isolation.

The default Python worker is a trusted task launcher, not an OS sandbox.

## Security and storage invariants

The public server accepts only a numeric loopback host such as `127.0.0.1` or
`::1`. There is no environment switch that enables a non-loopback socket. A
remote deployment must add a separately reviewed gateway while leaving this
process on loopback.

Exactly one API-key source is allowed: `AWP_DEV_API_KEY` or an absolute private
file named by `AWP_DEV_API_KEY_FILE`. The key must contain at least 16 bytes. Missing or whitespace-bearing values and
linked files fail startup. POSIX also enforces private mode and current-owner
checks. Windows rejects links/reparse points but does not prove the file DACL;
the operator must place it below an ACL-restricted directory. The Compose
bootstrap generates a strong random value.

SQLite state also fails closed. `AWP_DATA_DIR` must be a canonical absolute,
dedicated application directory and `AWP_DATABASE_URL` must be a direct `.db`
child. On first use the final data directory must be absent or an explicitly
bootstrapped empty directory. The service creates an ownership marker and later
runs accept only that marker. POSIX additionally enforces current ownership and
private modes. Windows rejects links/reparse points but relies on the operator
to choose an ACL-restricted parent. The service will not adopt or migrate an old
non-empty unmarked directory.

## Recommended local round trip

From the repository root, the Compose path needs no checked-in or operator-set
API key:

```bash
docker compose -f deploy/local/docker-compose.local-dev.yml config --quiet
docker compose -f deploy/local/docker-compose.local-dev.yml up -d --build
python scripts/wait_for_http.py http://127.0.0.1:8100/v1/health/ready --timeout 120 --json-field database
python scripts/submit_local_task.py --timeout 60
```

A bootstrap container creates a random key in a private named volume. The
submission helper reads that key into memory from the running container without
printing it. The FastAPI process still listens only on `127.0.0.1:8100` inside
its shared network namespace. The Python worker connects directly to that
loopback socket; an HAProxy sidecar in the same namespace exposes an internal
bridge port which Docker publishes only as host `127.0.0.1:8100`.

Stop the stack without deleting its named volumes:

```bash
docker compose -f deploy/local/docker-compose.local-dev.yml down --remove-orphans
```

Add `-v` only when you intentionally want to discard the demo database, worker
state, Redis data, and generated local key.

## Manual loopback startup

Install the service requirements, generate a strong random key, and keep it in
the current process environment or a private absolute key file. The supported
entrypoint is the script itself, not an arbitrary external Uvicorn command:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r services/control-plane/requirements.txt
export AWP_HOST=127.0.0.1
export AWP_DEV_API_KEY="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export AWP_WS_BROKER=memory
.venv/bin/python services/control-plane/cloud/server.py
```

For a custom data location, set both `AWP_DATA_DIR` and `AWP_DATABASE_URL` to
canonical absolute paths before startup. The database must be a direct child of
the data root. See [`docs/getting-started.md`](../../docs/getting-started.md)
for private key-file examples on Windows and POSIX and for the manual Python
worker round trip.

## Mounted API flow

1. Register a worker through `POST /v1/agent/register` with the operator key.
2. Submit work through `POST /v1/tasks` with the operator key.
3. Optionally stream the authenticated snapshot and transitions from
   `GET /v1/events/tasks/{task_id}`.
4. The worker polls `GET /v1/agent/tasks/pending` with its generated agent
   token.
5. It reports to `POST /v1/agent/tasks/{task_id}/result`.
6. Inspect the durable result through `GET /v1/tasks/{task_id}`.

All task and session lookups are tenant-scoped by the authenticated identity.
The public local key currently maps to the single local tenant; the schema and
queries preserve that boundary for downstream identity adapters.

## Tested composition libraries

Two production-derived mechanisms are deliberately outside the default HTTP
surface:

- `cloud/rollout.py` tests immutable release metadata, deterministic cohorts,
  canary evaluation, strict HTTPS release-prefix policy, and rollback to the
  prior stable version. There is no publish/promote route and no automatic
  updater.
- `cloud/sandbox_manager.py` tests fail-closed creation of a fresh, marked
  OS-user workspace. Merely setting `AWP_SANDBOX_ROOT` does not call it. There
  is no automatic cleanup, and partial failures require operator review.

These are reusable libraries for a downstream composition, not features activated
by historical flags and not hidden routes.

## Observability

`/metrics` is the only mounted telemetry export. The optional
[`deploy/observability-stack.yml`](../../deploy/observability-stack.yml) example
runs Prometheus and Grafana on loopback on a Linux Docker host. It requires
operator-provided secret files and does not claim traces, log shipping,
Alertmanager delivery, TLS, backup, or hosted monitoring.
