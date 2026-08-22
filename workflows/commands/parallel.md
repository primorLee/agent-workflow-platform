# `/parallel` — high-throughput execution with failure recovery

Use this mode for a set of independent tasks. The production default was eight concurrent workers; tune the limit to the host rather than creating a long invisible queue.

## Phase 0 — restore and configure

1. Read run-state and `modes/parallel.json`.
2. Resume an active batch before creating a new one.
3. Set `session.mode` to `parallel` and refresh the heartbeat.

## Phase 1 — build a conflict-free batch

For every task record:

- task id and one-sentence outcome;
- owned input and output paths;
- blocking dependencies;
- success command or observable artifact;
- estimated duration class.

Tasks in one batch must not write the same files. Put dependency chains into later batches. Run `scheduler.py next parallel` to preview the ready set, then `scheduler.py batch start parallel` to claim it. The start command performs the `pending` → `in_progress` transition and batch creation under one cross-process lock; do not edit status by hand.

## Phase 2 — dispatch

Each worker receives only the context needed for its owned scope plus the relevant recipe. Every worker must write its findings or changes to disk; chat-only results are incomplete.

Keep at least half the workers on implementation or verification work. Do not increase fan-out to compensate for an unclear task definition.

## Phase 3 — reconcile results

Classify each result:

| Result | Action |
|---|---|
| passed | inspect diff, run the declared check, mark done |
| code failure | attach evidence and retry with a changed hypothesis |
| unclear task | split it before the next batch |
| partial | preserve verified work and requeue the remainder |
| conflict | stop the conflicting branch and reconcile ownership |

Complete the active batch only after merged changes pass the batch gates. Update the heartbeat after reconciliation, not merely after workers return.

## Phase 4 — load balance

Use observed duration and failure data:

- split task classes that repeatedly exceed the expected duration;
- combine only truly small, non-overlapping tasks;
- quarantine a failure class that repeats without new evidence;
- refill idle capacity only with ready tasks.

## Phase 5 — close or checkpoint

Print a batch summary with succeeded, failed, partial, and requeued ids. Run `/finish` for completed work. Save a checkpoint naming the next ready batch when work remains.