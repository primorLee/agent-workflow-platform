# Local demo and control-plane boundary

The desktop checkout starts in local demo mode and requires no company network, account, hosted service, or API key.

```bash
npm ci
npm run dev
```

The command starts the production Vue renderer and a deterministic adapter at `http://127.0.0.1:8787`. The adapter emits the same message-start, progress, delta, and completion events consumed by the renderer and saves conversations under `.demo-data/sessions.json`.

## What 8787 covers

- chat model discovery and streamed completions;
- conversation history CRUD and restart recovery;
- one-file multipart upload (8 MiB maximum), opaque-ID artifact list/download, SHA-256 integrity, and state-owned storage metadata;
- activity heartbeat stream and opt-in local authentication compatibility (unused by the default UI);
- deterministic public-preview metadata: readiness, inactive maintenance, and one local changelog entry.

It is a UI/demo adapter, not the repository's orchestration backend. The metadata endpoints exist only so retained desktop surfaces behave honestly offline; they do not add task, VM-execution, agent-status, cloud-preference, feedback, or support-upload APIs.

## What 8100 covers

The full public control plane listens on `http://127.0.0.1:8100` and exposes generic task, session, agent registration/heartbeat, health, metrics, and worker claim/result APIs. Its protocol is intentionally different from the desktop chat contract.

A quick health check is therefore a real integration check:

```bash
curl http://127.0.0.1:8100/v1/health/ready
```

The Electron status panel performs this readiness check itself and, when a development key is available, reads `/v1/tasks` to show the number of pending/running tasks:

```powershell
$key = docker compose -f deploy/local/docker-compose.local-dev.yml exec -T control-plane python -c "from config import DEV_API_KEY; print(DEV_API_KEY)"
$env:AWP_CONTROL_PLANE_URL='http://127.0.0.1:8100'
$env:AWP_CONTROL_PLANE_API_KEY=$key.Trim()
npm --prefix apps/desktop run dev:electron
```

`AWP_CONNECTION_HEALTH_SSE_URL` is a separate compatible status-stream endpoint. It is contacted only when `AWP_ENABLE_CONNECTION_HEALTH_SSE=1` is also exact; it is never inferred from the chat URL.

Connecting the desktop chat UI to `8100` requires a chat adapter; this repository does not label the two services as directly interchangeable.

## Optional adapters

Hosted Login is a separate, fail-closed deployment choice. Only the exact main-process value `AWP_HOSTED_AUTH_OPT_IN=1` enables it; unset, `0`, `true`, and other values remain disabled. The local demo launchers force `0`, the preload reports `false`, and the renderer must not call login/register/validate/logout in that state.

- Set `VITE_AWP_CHAT_ADAPTER_URL` for a chat-compatible HTTP/SSE service.
- Set `AWP_CONTROL_PLANE_URL` and optionally `AWP_CONTROL_PLANE_API_KEY` for the generic health/task monitor.
- Set exact `AWP_ENABLE_CONNECTION_HEALTH_SSE=1` plus `AWP_CONNECTION_HEALTH_SSE_URL` only for a compatible status SSE adapter.
- Set `AWP_UPDATE_URL` for the stable update feed and optionally `AWP_UPDATE_INSIDERS_URL` for the preview feed.


The public command `npm run build:electron:preview` deliberately maps to the retained `insiders` internal channel identifier. That identifier keeps the updater manifest, application ID, and user-data directory isolated from stable installs; “preview” is the public command name, not a silent channel migration. `AWP_UPDATE_INSIDERS_URL` therefore remains the preview feed variable.

The local Agent CLI adapter is retained and disabled by default until a supported runtime is installed and enabled in Settings.
- Set exact `AWP_ENABLE_LOCAL_TRACE=1` for bounded, redacted, local-only JSONL traces; there is no upload path.
