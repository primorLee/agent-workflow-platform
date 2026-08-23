# Changelog

All notable public changes are recorded here. The project uses semantic
versioning for source releases; no application or VM binary is implied by a
source tag.

## [0.1.0] - 2026-08-24

### Added

- Runnable local model/CLI/Desktop and FastAPI/Python-worker reference paths.
- Capacity-aware task claims, expiring leases, UUID attempt fencing, bounded
  retry, stale Agent/Session cleanup, and idempotent terminal replay.
- Versioned SQLite lifecycle migration with future-schema rejection.
- Container backlog and hard worker-crash recovery gates.
- Electron workbench, read-only admin, mobile monitor, durable workflow
  coordination toolkit, Go VM-agent composition libraries, and operations
  examples.
- Complete-history secret scanning, public-boundary checks, multi-platform
  validation, issue forms, and contribution templates.

### Security and compatibility notes

- Workers are trusted launchers, not untrusted-code sandboxes.
- Delivery across worker loss is at-least-once; external effects must be
  idempotent.
- Pre-release `awp-offline-result/v1` records do not contain attempt fences and
  are quarantined instead of being replayed unsafely.
- The Go VM broker, hosted account services, remote multi-tenant deployment,
  signed installers, and application/VM binaries are not shipped.

[0.1.0]: https://github.com/primorLee/agent-workflow-platform/releases/tag/v0.1.0
