# Changelog

## Unreleased

### Public extraction

- Renamed the binary, module, services, packages, headers, and environment variables to the neutral AWP namespace.
- Generalized the wire payload from a domain-specific payload schema to `execution`, `runner`, `runtime`, `action`, and `input` fields.
- Preserved the WebSocket state machine, heartbeat, task admission/cancellation, process streaming, durable SQLite queue, replay loop, signed artifact client, and watchdog.
- Kept packaging layouts as review-only composition points while disabling all package builds and lifecycle hooks until a signed release exists.
- Added a component-specific `awp-vm-agent` account, random root-owned install marker, collision-safe manual reinstall, retained-state uninstall, and fail-closed purge/one-line paths.
- Serialized SQLite write transactions to prevent `SQLITE_BUSY` during concurrent task completion while retaining a WAL reader connection for replay.
- Removed the duplicate historical prototype and product-specific installer; both remain available in the private source snapshot.

### Known integration boundaries

- The public binary ships only the shell-free `echo` runner. Additional executors must be explicitly allowlisted and tested.
- Queue/replay, artifact, and telemetry packages are reusable and tested, but are not all enabled by the default `main` composition.
- The repository's local control-plane demo uses the polling worker API; the Go agent's WebSocket endpoint is covered by mock-broker tests.