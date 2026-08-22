# `/status` — project panorama and next action

Collect independent signals in parallel:

1. run-state session, checkpoint, current task, and backlog;
2. active batch and recent guardian events;
3. working-tree status and recent commits;
4. `STATUS.md`, if present;
5. the latest blocking gate result.

Return:

- current mode and heartbeat age;
- resumable checkpoint and exact resume command;
- active and blocked tasks, ordered by priority;
- changed-file count and whether changes are uncommitted;
- health of blocking gates;
- one recommended next action with a reason.

A stale heartbeat is not proof the process died. Confirm process, state, and output evidence before declaring failure. In an interactive session, show the recommendation and continue only when the current task or configured mode authorizes automatic continuation.