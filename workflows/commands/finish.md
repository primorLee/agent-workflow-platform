# `/finish` — evidence-based task closure

This command closes a task without confusing activity with completion.

## 1. Determine the change scope

Inspect staged, unstaged, and untracked files. Classify the change as code, tests, configuration, documentation, generated artifacts, or mixed. Never stage unrelated user changes.

## 2. Run mapped gates

Read `modes/gate-mappings.json`. Run only gates relevant to the changed files, plus `workflow-validation` whenever `workflows/` changed. A blocking failure must be repaired or left as an explicit blocker; it cannot be waved through.

## 3. Check success artifacts

For each acceptance criterion, point to the command output or artifact that proves it. Also check for false-green cases:

- command returned zero but expected output is missing;
- test passed against a mock while the changed integration path was never exercised;
- generated file exists but is stale;
- recovery path was documented but never interrupted and resumed.

## 4. Check regression coverage

Every bug fix needs a test or deterministic reproduction that failed before the fix. If a test is intentionally omitted, record the reason and residual risk.

## 5. Update durable context

Update the nearest README or index for new public interfaces. Add a recipe when the work required more than three non-obvious steps, recovered from a real failure, or established a reusable external-system procedure. Do not write secrets, host identities, or raw operational logs into recipes.

## 6. Record state

Refresh the heartbeat. Mark the matching task complete only after all blocking checks pass. Clear a checkpoint only when its promised continuation is no longer needed.

## 7. Prepare version-control handoff

Show the exact files to be committed and a concise message. Commit or push only when the surrounding task authorizes it. Never use broad staging to hide scope mistakes.

## Completion report

Report change scope, blocking gates, regression proof, durable documentation, task id, and whether any external action remains.