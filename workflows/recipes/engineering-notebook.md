---
title: Engineering notebook as an append-only evidence timeline
tags: [notebook, provenance, timeline, signoff, recovery]
trigger: A multi-step experiment or repair needs human-readable and machine-verifiable history
verified: 2026-08-22
priority: 2
status: active
---

# Goal

Maintain one append-only event stream and derive the readable timeline from it. Do not let prose become the source of truth.

## Event model

Every card records timestamp, task id, event type, input references, observation, decision, output artifacts, verification, and code revision. Suggested types include objective, hypothesis, command, measurement, failure, diagnosis, patch, comparison, decision, artifact, checkpoint, and signoff.

## Workflow

1. initialize an immutable target specification;
2. attach notebook context before each external action;
3. append success and failure events immediately;
4. render natural-language timeline and plots from stored events;
5. run a deterministic signoff gate against the frozen targets;
6. save a checkpoint when the loop stalls or is interrupted.

## Pitfalls

- missing notebook context silently loses provenance;
- applying percentage tolerance to logarithmic values creates nonsense;
- editing rendered prose is overwritten by the next render;
- inconsistent metric names make comparison silently incomplete;
- import or callback failures in auto-recording can hide all later evidence.

## Verification

Lint required fields, verify every artifact exists and has a producer event, rebuild the timeline from events, and re-run signoff without a language model.