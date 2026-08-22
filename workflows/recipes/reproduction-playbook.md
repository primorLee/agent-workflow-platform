---
title: Claim-level reproduction playbook
tags: [reproduction, benchmark, provenance, pitfall-gate]
trigger: Reproducing an external result, incident, benchmark, or system claim
verified: 2026-08-22
priority: 1
status: active
---

# Scope

This recipe is the operational companion to `commands/repro.md`. “The program ran” is a smoke test. Reproduction means all declared outputs are produced within precommitted tolerances using the claimed mechanism or an explicitly labeled approximation.

## Six phases

0. Freeze claim, outputs, tolerances, source revision, and missing conditions.
1. Build a parameterized fixture with pinned inputs and one clean-start command.
2. Run one sanity case and validate the entire input-to-output path.
3. Run the full matrix under a frozen evaluator and retain failed trials.
4. Attribute every gap across implementation, evaluation, and missing-condition axes.
5. Archive evidence, pass the failure-recipe gate, and run adversarial review.

## Mandatory pitfall gate

Before closure, scan working notes for setup mistakes, undocumented conditions, misleading smoke success, evaluator drift, and manual steps. Move reusable items into a recipe with symptom, root cause, minimal fix, verification, and prevention.

## Anti-patterns

- reporting only metrics that matched;
- substituting a convenient component without labeling it;
- tuning the evaluator after seeing results;
- discarding failed trials;
- calling missing information a negative result;
- leaving lessons only in a run transcript.

## Verification

A new operator can reproduce the status from archived commands, locked inputs, raw outputs, parser version, and alignment table without access to private infrastructure.