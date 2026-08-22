# AWP VM Agent

`awp-vm-agent` is the outbound Go worker for Agent Workflow Platform. It keeps
a resilient WebSocket session to a compatible broker, authenticates as an
agent, accepts and cancels task offers, supervises child processes, and streams
progress and logs over the same connection.

This is a curated extraction of deployed worker code, not a blank scaffold.
Product-specific adapters and infrastructure addresses were removed; the
connection state machine, protocol handling, process supervision, durable
queue, replay loop, artifact client, watchdog, reviewed manual installer, and
regression tests remain.

## What the public binary wires

- WebSocket dial, handshake, authentication, heartbeat, reconnect, exponential
  backoff, and full jitter.
- Task acknowledgement, concurrency admission, cancellation, graceful drain,
  and protocol-version enforcement.
- Shell-free process execution through a positive runner allowlist.
- Rotating structured logs, crash reports, Linux host inventory, and a
  self-watchdog.
- YAML configuration with `AWP_AGENT_*` environment overrides and no
  compiled-in credentials.

The built-in runner is deliberately limited to the deterministic `echo`
adapter. It is not an OS sandbox. Add adapters through the explicit allowlist,
run untrusted workloads under a separate operating-system isolation boundary,
and add tests before enabling them.

## Composition points

These packages are implemented and tested, but are not enabled by
`cmd/awp-vm-agent` by default:

- `internal/queue`: SQLite WAL offline queue with locking, idempotent enqueue,
  FIFO claim, retry state, reclaim, and pruning.
- `internal/replay`: bounded replay with transient/fatal classification and
  backoff.
- `internal/artifact`: signed-URL request, streaming upload, checksum
  verification, retry, and completion reporting.

## Build and test

Go 1.25.13 is the tested and minimum toolchain. The `go` directive pins that
exact security-patched release. A redundant `toolchain` directive is omitted:
Go treats its absence as an implicit match to the `go` line, which also keeps
the module `go mod tidy`-clean.

```bash
go test ./...
mkdir -p dist
go build -o dist/awp-vm-agent ./cmd/awp-vm-agent
./dist/awp-vm-agent --version
```

CI also installs the official scanner at the fixed version
`golang.org/x/vuln/cmd/govulncheck@v1.1.4` and runs `govulncheck ./...`.
That security step is intentionally online: it queries the official Go
vulnerability database, while the normal test, replay, vet, and build gate runs
offline after module hydration.

A direct `go build` reports `0.0.0-dev`. Release metadata is injected into the
three variables in `cmd/awp-vm-agent/main.go` with linker flags. The Makefile
does this consistently:

```bash
make test
make VERSION=1.0.0 build-all
./dist/awp-vm-agent-1.0.0-linux-amd64 --version
```

`VERSION`, the current commit, and the UTC build date are passed with
`-ldflags -X main.Version=... -X main.Commit=... -X main.Date=...`.

This source preview has no signed binary or tag. `package-tar`, `package-deb`,
`package-rpm`, `package-apk`, `package-all`, `install-local`, and
`uninstall-local` therefore exit with status 77 before build, staging, or host
mutation. The package files preserve future composition points for review; all
package lifecycle hooks also fail closed. A release owner must supply a signed
artifact pipeline and lifecycle tests before enabling them.

## Configuration

Start from `packaging/config.yaml.example`. The API key must come from a
root-readable local secret file or another operating-system secret mechanism;
do not put it in shell arguments, source control, logs, or task payloads. The
verified installer consumes `--api-key-file` and writes the restricted service
environment atomically. For a manual development run, use an operating-system
secret manager or a protected process-supervisor environment; this README does
not provide a command-line secret injection example.

Plain `ws://` is accepted only for `localhost` or a loopback IP literal. Use
`wss://` for a remote deployment. The public Python control plane and worker
demo use a polling protocol; they do not expose the richer VM-agent WebSocket
endpoint. The VM agent's connection is exercised by its in-process mock-broker
tests until an operator composes a compatible endpoint.

## Verified installation

The repository deliberately has no release URL or production signing key.
After a release owner publishes an immutable artifact and distributes its
digest and public key through trusted channels, install with explicit values:

```bash
sudo sh install/install.sh \
  --release-base "$AWP_RELEASE_BASE_URL" \
  --version "$AWP_VM_AGENT_VERSION" \
  --binary-sha256 "$AWP_VM_AGENT_SHA256" \
  --pubkey /absolute/path/to/reviewed-release-key.asc \
  --api-key-file /absolute/path/to/agent-api-key \
  --server-url "$AWP_VM_SERVER_URL"
```

The installer verifies SHA-256 and a detached GPG signature, installs the
service definition, and writes a restricted service environment file. It uses
the component-specific `awp-vm-agent` system account and a root-owned,
closed-schema ownership marker. A fresh install refuses any pre-existing
managed account, group, directory, binary, or service target. A reinstall
requires the same random install identity and exact account/path ownership,
then also requires `--replace-config`.

The service is not enabled or started by default. Verify that the configured
endpoint implements the VM-agent protocol, then rerun the installer with
`--replace-config --start`. Process liveness alone does not prove handshake or
protocol compatibility. The default uninstaller validates the same marker,
removes only the exact binary/service registration, and keeps the account,
config, credentials, data, logs, and marker in `retained` state. `--purge` and
one-line installation exit 77 without host mutation.

The systemd template is baseline hardening for the checked-in `echo` adapter,
not a sandbox guarantee. Review its writable paths, device access, address
families, and executable needs when adding an adapter.

## License

MIT.
