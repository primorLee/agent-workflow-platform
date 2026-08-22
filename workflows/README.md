# Agent Workflow Platform — production-derived workflows

This directory contains the portable workflow layer extracted from a retired, full-stack agent product. It keeps the mechanisms that survived real operation—durable run state, dependency-aware batching, heartbeat and checkpoint recovery, stall detection, adversarial review, failure-to-recipe learning, and claim-level reproduction gates—while removing product identity, private infrastructure, domain-specific logic, credentials, and real run history.

## What is here

- `runtime/` — standard-library scheduler and guardian.
- `commands/` — reusable task workflows.
- `modes/` — machine-readable scheduling and gate policy.
- `roles/` — writer, blind critic, and final reviewer protocol.
- `templates/` — durable task, finding, batch, recipe, and checkpoint artifacts.
- `recipes/` — incident-tested, general operating procedures.
- `schemas/` — run-state, guardian-event, mode, and gate schemas.
- `examples/` — generated state/history only; no production transcript.
- `validation/` — offline safety and behavior checks.

See [INDEX.md](INDEX.md) for the full map.

## Quick start

Requirements: Python 3.10 or newer. The scheduler and guardian runtime use only
the standard library. The validator performs real Draft 2020-12 checks and
therefore uses the root validation requirements.

```bash
python -m pip install -r requirements-validation.txt
python workflows/validation/validate_workflows.py
python workflows/runtime/scheduler.py add "Create a deterministic smoke test" 2 --group reliability
python workflows/runtime/scheduler.py heartbeat
python workflows/runtime/scheduler.py status
python workflows/runtime/scheduler.py next parallel
python workflows/runtime/scheduler.py batch start parallel
python workflows/runtime/guardian.py check
```

The default mutable state lives in `.agent-workflow/run-state.json` at the project root. It is created only when a mutating scheduler command runs.

`next <mode>` is a read-only preview. `batch start <mode>` then holds a cross-process OS lock while it re-reads state, claims dependency-ready `pending` tasks, marks them `in_progress`, and creates the batch in one atomic replacement. A lock timeout or an empty/overlapping claim exits nonzero instead of recording an empty successful batch.

### Configuration

| Variable | Purpose | Default |
|---|---|---|
| `AWP_PROJECT_DIR` | project observed by scheduler and guardian | repository root |
| `AWP_WORKFLOW_HOME` | directory containing modes and runtime | this `workflows/` directory |
| `AWP_RUN_STATE` | mutable run-state file | project `.agent-workflow/run-state.json` |
| `AWP_MODES_DIR` | mode configuration directory | `workflows/modes` |
| `AWP_STATUS_FILE` | optional project status document | project `STATUS.md` |
| `AWP_STATE_LOCK_TIMEOUT` | seconds to wait for the cross-process state lock | `10` |
| `AWP_STATE_REPLACE_TIMEOUT` | seconds to retry transient atomic-replace sharing failures | `5` |
| `AWP_GUARDIAN_CHECK_INTERVAL` | polling interval in seconds | `300` |
| `AWP_GUARDIAN_STALL_TIMEOUT` | stale-heartbeat threshold in seconds | `2700` |
| `AWP_GUARDIAN_ALERT_COOLDOWN` | repeated-alert cooldown in seconds | `1800` |
| `AWP_GUARDIAN_LOG` | human-readable guardian log | project `.agent-workflow/guardian.log` |
| `AWP_GUARDIAN_HISTORY` | structured guardian JSONL | project `.agent-workflow/guardian-history.jsonl` |

No notification endpoint is built in. Consume guardian stdout or JSONL from your existing notification service.

## A real interruption demo

1. Add a task and save a checkpoint with `scheduler.py checkpoint "<next action>"`.
2. Stop the agent process.
3. Run `guardian.py resume` from a new terminal or session.
4. The recovery instruction is rebuilt from checkpoint, backlog, recent commits, working-tree state, and optional `STATUS.md`.

This tests recovery from durable artifacts rather than conversation memory.

## Safety boundary

The extraction deliberately excludes credentials, endpoints, private hostnames, personal or tenant data, authentication pools, relay/proxy topology, product billing/authentication code, specialized domain procedures, and operational transcripts. Runtime examples are synthetic and fixed under `examples/`.