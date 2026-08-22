# Workflow extraction provenance

This pack is a fidelity-preserving extraction from a retired production agent platform, not a greenfield prompt collection.

## Source families

- production scheduler and guardian runtime;
- command workflows for daily execution, parallel batches, finish, status, research, review, and reproduction;
- mode policy, role prompts, output templates, and recipe index;
- incident-derived procedures for streaming, packaging, runtime launch, IDE fan-out, recovery, and failure harvesting.

The source scheduler snapshot had SHA-256 `18c9b47cd09e55e868ba13449e604848dda890c901c8735c471be8d390dc9b25`. The source guardian snapshot had SHA-256 `46f82e664838cfcb632c98fcfcb3127bde047576c406320ad3ec364883aab820`.

## Preserved behavior

- atomic state replacement;
- monotonic task and batch ids;
- dependency-aware task readiness;
- backlog, batch, heartbeat, checkpoint, and statistics commands;
- stale-heartbeat detection, three consecutive failures, alert cooldown, structured events, and restart context;
- writer → blind critic → final reviewer separation;
- failure → root cause → correct repair layer → regression → recipe flywheel;
- six-phase reproduction with a mandatory pitfall sink before closure.

## Deliberate changes

- all mutable paths are project-relative and configurable with the `AWP_` prefix;
- product and specialized-domain identities were removed;
- notification provider integration was replaced by stdout and JSONL sinks;
- real run-state, guardian history, tasks, incident records, users, and tenant data were replaced with generated examples;
- private infrastructure, authentication/account tooling, billing integration, network relay topology, and specialized procedures were excluded;
- public documentation was normalized to English and linked to offline validation.

Run `python workflows/validation/validate_workflows.py` to recheck this boundary and the runtime smoke path.