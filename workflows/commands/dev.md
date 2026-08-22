# `/dev` — resumable daily development

Use this mode for one concrete engineering task. It combines task selection, recipe lookup, checkpointed execution, targeted verification, and bounded self-repair.

## Inputs

- `/dev` selects the highest-priority ready backlog item.
- `/dev <task>` uses the supplied task and adds it to run-state if it is not tracked.

## Phase 0 — restore state

1. Run `python workflows/runtime/scheduler.py status`.
2. Read the configured run-state. If `checkpoint.resumable` is true, continue from the recorded instruction before selecting unrelated work.
3. Set `session.mode` to `daily`, `session.status` to `active`, and refresh the heartbeat.
4. Read the latest commits and the working-tree status. Preserve changes that are not part of the task.

## Phase 1 — select and bound the task

Priority order:

1. explicit user task;
2. `scheduler.py next daily`;
3. a failing blocking gate;
4. the first unblocked item in `STATUS.md`.

Write a one-sentence outcome, an explicit file scope, success checks, and excluded side effects. Do not broaden the task merely because adjacent cleanup is attractive.

## Phase 2 — load proven recipes

Read `recipes/INDEX.md`. Load every active recipe whose trigger matches the task. If no recipe matches, proceed and decide at the end whether the new method should become one.

## Phase 3 — execute

Split the task into two to four independently verifiable subtasks. Parallelize only when file ownership does not overlap. After each subtask:

1. inspect the actual diff;
2. run the narrowest relevant check;
3. record completion in run-state;
4. refresh the heartbeat.

## Phase 4 — bounded repair

A failed check gets at most three evidence-changing attempts:

1. reproduce and classify the failure;
2. inspect the expected behavior and change a different causal assumption;
3. minimize the reproduction, restore a safe state, and save a checkpoint.

Repeating the same command without a changed hypothesis is not a retry. If three attempts fail with the same blocker, preserve evidence and report it.

## Phase 5 — finish

Run `/finish`. If interrupted, save a checkpoint containing the exact next action and context files. A task is complete only when its success checks pass; a green command without the required artifact is not completion.