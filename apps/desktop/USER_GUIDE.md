# Desktop user guide

## Start without an account

After `npm ci`, choose one of the local demos:

```bash
npm run dev
npm run demo:electron
```

The first command opens the client in a browser. The second rebuilds the production desktop artifacts and launches Electron. Both use the loopback-only chat adapter on `127.0.0.1:8787`; neither requires a hosted login or API key.

## Optional hosted account mode

Hosted authentication is off by default. It turns on only when the process that launches Electron receives the exact value `AWP_HOSTED_AUTH_OPT_IN=1`; unset, `0`, `true`, and all other values remain off. The local demo commands intentionally keep it off, show no Login page, and make no hosted-auth requests. Do not enable it for the loopback demo.

## Try the durable conversation path

1. Send a message and watch the reply arrive in multiple SSE events.
2. Create a second conversation and switch between them.
3. Close the demo and start it again.
4. Reopen the original conversation. Its messages and session identity come from `.demo-data/sessions.json`.

The local answer is deterministic: it proves transport, streaming, storage, and recovery, not model quality.

You can also attach one file up to 8 MiB. The demo stores its bytes under `.demo-data/attachments` using a random opaque ID, keeps only validated metadata in the durable state, and serves downloads only through that ID. Filenames never become filesystem paths.

## What the desktop retains

- streamed Agent CLI progress and partial responses;
- durable conversation and session recovery;
- guarded workspace reads, writes, and command execution;
- SSH remote workspace transport with explicit host-key verification;
- artifact download/open flows and desktop notifications;
- startup, connection, and privacy-filtered diagnostics;
- isolated stable and preview updater state machines.

Optional remote-workspace adapters and agent-produced artifacts may require their own service or credentials. The bounded upload/list/download artifact path described above is fully local and needs neither.

## Connect the repository control plane

The desktop chat adapter on `8787` and the repository control plane on `8100` have different contracts. The control-plane status monitor is disabled and shows unknown until its URL is explicitly configured. Use `8100` for task/session/agent health in the status panel:

```powershell
$key = docker compose -f deploy/local/docker-compose.local-dev.yml exec -T control-plane python -c "from config import DEV_API_KEY; print(DEV_API_KEY)"
$env:AWP_CONTROL_PLANE_URL='http://127.0.0.1:8100'
$env:AWP_CONTROL_PLANE_API_KEY=$key.Trim()
npm --prefix apps/desktop run demo:electron
```

Chat remains on `8787`. Point `VITE_AWP_CHAT_ADAPTER_URL` elsewhere only when that service implements the documented chat/history/SSE contract.

## Connect a remote workspace

Open Settings and enter the host, port, and user. Passwords use the platform credential store and fail closed when OS encryption is unavailable. For key authentication, explicitly provision the private key, its comment-free `.pub` file, and the SHA-256 manifest under the app-owned `private/keys` directory; the client validates the marked directory, file identity, permissions, and hashes before use. It never scans, adopts, generates, migrates, or deletes keys under the shared `~/.ssh` directory. Host keys use trust-on-first-use; a changed key is refused and can only be cleared one opaque host entry at a time.

## Troubleshooting

- “Port 8787 is already in use”: stop the existing demo process, then run the command again. The launcher will not attach to an unknown service.
- Browser UI loads but chat fails: use `npm run dev`, not `npm run dev:web`, unless you started a compatible adapter separately.
- Control-plane status is unavailable: verify `http://127.0.0.1:8100/v1/health/ready`; this does not affect the `8787` chat demo.
- A production artifact looks stale: run `npm run build:desktop-artifacts`; every known output is removed before compilation.
- For a reproducible check, run `npm run test:demo-contract` and `npm run test:clean-output`.

## Optional local diagnostics

Set `AWP_ENABLE_LOCAL_TRACE=1` only when you want bounded JSONL workflow traces on this device. Traces rotate locally and common credential fields, token-like values, private-key material, and URL query values are redacted. They are never uploaded, but non-sensitive tool summaries may still contain private project context.

A compatible health stream is disabled by default. It requires exact `AWP_ENABLE_CONNECTION_HEALTH_SSE=1` plus a validated `AWP_CONNECTION_HEALTH_SSE_URL`; invalid or missing values perform no request.