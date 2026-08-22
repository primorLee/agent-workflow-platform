# Recipe index

Every entry below is production-derived but environment-neutral. Load a recipe by observable trigger, not by filename familiarity.

| Recipe | Trigger | Tags | Status |
|---|---|---|---|
| [Harness failure flywheel](harness-failure-flywheel.md) | periodic digest or repeated agent failure | harness, root-cause, memory | active |
| [Public service incident triage](incident-triage.md) | external health failure or timeout | incident, rollback, recovery | active |
| [SSE event pairing](sse-event-pairing.md) | stream breaks after filtering/redaction | SSE, parser, state machine | active |
| [Runtime version pin](runtime-version-pin.md) | deliberate runtime upgrade or rollback | runtime, release | active |
| [Runtime spawn diagnosis](runtime-spawn-diagnosis.md) | child fails before stdout/stderr | packaging, platform | active |
| [Extension-host reload](extension-host-reload-under-fanout.md) | IDE reloads during subagent fan-out | IDE, process tree | active |
| [Electron symlink cache](electron-builder-symlink-cache.md) | Windows package extraction fails on symlink | Electron, packaging | active |
| [Inline artifact rendering](inline-artifact-rendering.md) | local artifact must render safely in chat | IPC, sandbox, desktop | active |
| [Engineering notebook](engineering-notebook.md) | multi-step work needs durable provenance | timeline, signoff | active |
| [Reproduction playbook](reproduction-playbook.md) | external claim must be reproduced | provenance, pitfall gate | active |
| [Document ingestion](document-ingestion.md) | batch documents enter a searchable index | ingestion, metadata | active |
| [Multi-agent batch recovery](multi-agent-batch-recovery.md) | parallel batch has mixed outcomes | batching, retry | active |

## Selection order

Filter by active status, match trigger and tags, then sort by priority, successful-use count, and verification date. When a materially different mechanism supersedes a recipe, keep the previous one linked as evidence rather than deleting it.