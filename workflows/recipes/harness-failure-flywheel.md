---
title: Harness failure flywheel
tags: [harness, failure-harvest, root-cause, regression, memory]
trigger: A periodic failure digest is ready or the same agent failure appears twice
verified: 2026-08-22
priority: 1
status: active
---

# Goal

Turn real agent failures into a correction at the right layer and prove that the same failure no longer recurs.

## 1. Freeze the digest

Export a bounded time window with stable case ids, timestamps, tool outcomes, final status, and redacted inputs. Preserve the raw digest privately; the public artifact contains only normalized failure classes and synthetic cases.

## 2. Root-cause each case

Ask four separate questions:

| Class | Question |
|---|---|
| strategy | Was the chosen approach incapable of meeting the goal? |
| method | Was the search, stopping rule, or recovery procedure wrong? |
| implementation | Did code crash, corrupt state, or fail silently? |
| knowledge | Was a reusable constraint or diagnostic rule missing? |

Do not accept the agent's own explanation without a reproduction. A confident “hard limit” can still be a bad fixture or missing branch.

## 3. Route the correction

| Failure class | Correct layer |
|---|---|
| knowledge gap | recipe or retrieval knowledge |
| method flaw | harness policy or orchestration code |
| operating mistake | command or recipe |
| implementation bug | code plus a regression test |
| evaluation flaw | independent gate and historical re-score |

Avoid patching the prompt when the defect belongs in deterministic code.

## 4. Verify the closed loop

Re-run the minimized case with the same frozen evaluation. Then run an adjacent negative control so the fix is not merely overfit to one transcript.

After shipping a correction, audit **memory poisoning**: did the prior failure write a false conclusion into durable memory, summaries, or cached tool results? If so, invalidate or qualify those records and require re-verification before reuse.

## 5. Sink durable knowledge

- recurring mechanism → update this recipe;
- implementation defect → regression test;
- new operational procedure → dedicated recipe;
- unreliable evaluator → evaluation incident and re-score.

A closed case contains failure id, root cause, correction layer, regression artifact, adjacent control, and residual risk.