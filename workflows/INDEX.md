# Workflow index

## Runtime

| Component | Purpose |
|---|---|
| [scheduler.py](runtime/scheduler.py) | atomic run-state writes, dependency resolution, backlog, batch lifecycle, heartbeat, checkpoint, statistics |
| [guardian.py](runtime/guardian.py) | stall detection, repeated-failure threshold, cooldown, structured evidence, recovery instruction |

## Commands

| Command | Purpose |
|---|---|
| [`/dev`](commands/dev.md) | resumable daily engineering loop |
| [`/parallel`](commands/parallel.md) | conflict-free high-throughput batches |
| [`/finish`](commands/finish.md) | evidence-based completion gate |
| [`/status`](commands/status.md) | state, health, backlog, and next action |
| [`/recipe`](commands/recipe.md) | verified procedure lifecycle |
| [`/research`](commands/research.md) | broad exploration, blind critique, decisive tests |
| [`/review`](commands/review.md) | architecture, code, API, pipeline, and security audit |
| [`/artifact-review`](commands/artifact-review.md) | writer → blind critic → final reviewer |
| [`/repro`](commands/repro.md) | six-phase claim-level reproduction |
| [`/stakeholder-brief`](commands/stakeholder-brief.md) | diff-driven reviewed briefing |

## Policy and artifacts

- Modes: [daily](modes/daily.json), [parallel](modes/parallel.json), [research](modes/research.json), [quality gates](modes/gate-mappings.json).
- Roles: [writer](roles/writer.md), [blind critic](roles/critic.md), [final reviewer](roles/final-reviewer.md).
- Templates: [task](templates/agent-task.md), [findings](templates/agent-findings.md), [batch summary](templates/batch-summary.md), [recipe](templates/recipe.md), [checkpoint](templates/checkpoint.md).
- Schemas: [run-state](schemas/run-state.schema.json), [guardian event](schemas/guardian-event.schema.json), [mode](schemas/mode.schema.json), [quality gates](schemas/gate-mappings.schema.json).
- Examples: [synthetic run-state](examples/run-state.synthetic.json), [synthetic guardian history](examples/guardian-history.synthetic.jsonl).
- Recipes: [recipe index](recipes/INDEX.md).
- Extraction: [fidelity and redaction record](PROVENANCE.md).