# `/research` — evidence-driven exploration

Use this mode when the answer is not known and multiple mechanisms must be compared. The workflow prevents early convergence, context loss, and claims unsupported by evidence.

## Discipline

- Re-read this command at each phase boundary.
- Read prior phase artifacts from disk; do not reconstruct them from chat memory.
- Every worker writes a complete artifact to its assigned path.
- Preserve rejected and failed approaches with reasons.
- A failed trial is evidence about a setup or hypothesis, not automatic proof the entire approach is impossible.

## Phase 0 — scope and falsification

Write a checkpoint containing the question, decision deadline, excluded scope, success metric, cheapest falsification test, and relevant prior work. Search `recipes/INDEX.md` before inventing a new procedure.

## Phase 1 — independent exploration

Dispatch at least five non-overlapping directions. Give each worker `templates/agent-findings.md` and a distinct assumption, mechanism, data source, or adversarial angle. Do not ask every worker the same broad question.

Merge results into an approach registry. Deduplicate by mechanism, not vocabulary.

## Phase 2 — blind critique

Give the registry and evidence—not the writer prompts—to two critics:

- feasibility critic: hidden dependencies, invalid assumptions, implementation blockers;
- novelty or value critic: strongest existing alternative, residual contribution, urgency.

Each critic must identify a concrete falsifier and cite evidence locations. Use the minimum critic score for promotion.

## Phase 3 — decisive tests

Select the smallest set of approaches that span the remaining uncertainty. For each, record baseline, intervention, fixed evaluation protocol, expected observation, and stop condition. Run cheap discriminating tests before expensive optimization.

## Phase 4 — evidence audit

Three roles inspect the resulting artifacts:

1. data auditor checks completeness, provenance, missing worst cases, and leakage;
2. comparison auditor checks matched conditions and hidden tuning asymmetry;
3. red-team reviewer attempts to explain the result without the claimed mechanism.

## Phase 5 — decision and archive

The final reviewer reads every registry entry, critic report, and test artifact. The report must include all approaches, negative results, confidence, residual uncertainty, and the next decision. Update the checkpoint and recipe library before closure.

## Interruptions

On pause, save the current phase, completed artifacts, active approaches, and the exact next action to run-state. On resume, read the checkpoint first.