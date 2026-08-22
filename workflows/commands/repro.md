# `/repro` — six-phase reproducibility gate

Use this command to reproduce a published result, external benchmark, incident, or claimed system behavior. A command that exits successfully is only a smoke check; reproduction requires the declared outputs under the declared conditions.

## Definition of success

Before running anything, list every headline output, tolerance, environment constraint, and behavior that constitutes the original claim. Do not selectively report the easiest metric. A substitute component or post-processing shortcut must be labeled as an upper bound or approximation, not a reproduction.

## Phase 0 — scope and boundary

Create `repro-notes.md` with source reference, exact claim, target outputs, tolerances, environment, missing information, expected artifacts, and stop conditions. Record the immutable baseline and read `recipes/reproduction-playbook.md`.

## Phase 1 — deterministic fixture

Build the smallest parameterized fixture that exercises the claimed mechanism. Pin dependencies and seeds, capture input checksums, and define one command that starts from a clean working directory. Do not hide manual steps.

## Phase 2 — single-case sanity

Run one representative case. Verify input selection, process exit, output existence, parser behavior, and basic invariants. A failure here is usually a fixture or environment problem; diagnose before rejecting the claim.

## Phase 3 — full reproduction

Run the complete declared matrix, including failure conditions and worst cases. Independent workers may own different dimensions, but all results use the same frozen evaluation rule. Fill an alignment table:

| Claimed output | Reference | Reproduced | Difference | Within tolerance | Native or approximation |
|---|---:|---:|---:|---|---|

Any missing headline output keeps the result incomplete.

## Phase 4 — gap attribution

For every result outside tolerance, test at least three axes: implementation mismatch, evaluation mismatch, and missing source condition. Each retry must change a causal hypothesis. Finish only when the claim is matched or the residual gap has convergent evidence and is labeled accurately.

## Phase 5a — report and archive

Archive the command, environment lock, checksums, raw outputs, parser version, alignment table, and negative trials. Make the report rebuildable without private infrastructure.

## Phase 5b — mandatory failure-recipe gate

Ask four questions:

1. Which setup, tool, data, or interpretation traps occurred?
2. Which undocumented conditions were inferred?
3. Why did any smoke-level success fail to become claim-level success?
4. Are all unresolved gaps labeled by cause and confidence?

If any answer is non-empty, update a general or domain-specific recipe before finishing. Each pitfall records context, symptom, root cause, minimal fix, verification, and prevention. Raw logs do not count as a recipe.

## Phase 5c — close

Run `/finish`, then `/artifact-review` for public results. Status must be one of `reproduced`, `partial`, `not-reproduced`, or `blocked-by-missing-information`; never upgrade a partial result for presentation value.