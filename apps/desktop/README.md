# Agent Workflow Platform Desktop

A production-derived Electron/Vue client for durable Agent CLI work: streamed events, resumable conversations, guarded workspace tools, diagnostics, and isolated stable/preview update channels.

![Agent Workflow Platform local Electron demo](docs/desktop-demo.png)

_Local Electron demo in explicit no-account mode._

## One-command local demos

Install the pinned dependencies once:

```bash
npm ci
```

Browser demo:

```bash
npm run dev
```

This starts Vite and the real local chat adapter. Open the URL printed by Vite.

The adapter has no standalone package command: an owned launcher must create and transfer its ephemeral capability in memory. The capability is never printed, persisted, or placed in a URL.

Electron demo:

```bash
npm run demo:electron
```

`demo:electron` performs the complete local path:

1. binds the chat adapter to `127.0.0.1:8787` and waits for `/health`;
2. forces fail-closed hosted auth (`AWP_HOSTED_AUTH_OPT_IN=0`), so no account is required;
3. clears and rebuilds the renderer, Electron main/preload, and both MCP bundles;
4. launches Electron; and
5. stops its child process and the adapter when Electron or the launcher exits.

Conversation state is stored in `.demo-data/sessions.json`; Electron-only local state is kept under `.demo-data/electron-user-data`. Both are ignored by Git.

## Real model and external Agent CLI paths

For a local OpenAI-compatible endpoint such as Ollama, run:

```powershell
$env:AWP_AGENT_MODEL='llama3.2'
npm run openai-compatible:electron
```

The checked-in reference adapter is a real HTTP streaming client and persists
its native session under `.agent-data/reference-agent-sessions`. It is a
protocol example, not a general agent framework. It is chat-only by default;
the exact `AWP_AGENT_MANAGED_TASKS_OPT_IN=1` value exposes one bounded
`awp_run_managed_task` tool backed by the separately configured control plane.
It does not invent broader planning or business logic. Remote endpoints require `AWP_AGENT_API_BASE_URL`,
`AWP_AGENT_API_TOKEN`, and exact `AWP_AGENT_REMOTE_API_OPT_IN=1`.

To use an existing Agent CLI instead:

```powershell
$env:AWP_AGENT_CLI_EXECUTABLE='C:\absolute\path\to\agent-cli.exe'
$env:AWP_AGENT_DEFAULT_MODEL='provider-model-id'
$env:AWP_AGENT_CLI_PROTOCOL='awp-jsonl'
npm run agent:electron
```

`agent:electron` refuses a relative or symbolic-link executable and enables
fail-visible mode: it never substitutes the deterministic adapter after a CLI
failure. See the [Agent CLI protocol](../../docs/agent-cli-protocol.md) for the
JSONL input, streaming output, resume, lifecycle, and error contract.

## The two local services are intentionally different

| Address | Responsibility | Used for |
| --- | --- | --- |
| `127.0.0.1:8787` | Desktop chat adapter | models, optional auth compatibility, chat/history/SSE, bounded uploads, durable artifacts, local UI metadata, restart recovery |
| `127.0.0.1:8100` | Repository control plane | tasks, sessions, agent registration, health, metrics |

The `8787` adapter does not imitate the full control plane. The `8100` service
does not claim to implement the desktop chat contract. The optional reference
tool is an API client between them, not a protocol merger.

### Hosted authentication is explicit opt-in

The public default is local/no-account. Only the exact main-process value `AWP_HOSTED_AUTH_OPT_IN=1` enables hosted Login and session validation; unset, `0`, `true`, and every other value stay disabled. The preload exposes only the normalized boolean, never the environment string. Local demo commands deliberately force `0`, render no Login surface, and make no login/register/validate/logout requests. The commented example in `.env.desktop.example` is for an explicitly hosted deployment, not the local demo.

The status monitor is `unknown` and performs no network request by default. To show control-plane health and tasks while keeping chat on `8787`, start the repository control plane and explicitly set:

```powershell
$key = docker compose -f deploy/local/docker-compose.local-dev.yml exec -T control-plane python -c "from config import DEV_API_KEY; print(DEV_API_KEY)"
$env:AWP_CONTROL_PLANE_URL='http://127.0.0.1:8100'
$env:AWP_CONTROL_PLANE_API_KEY=$key.Trim()
npm --prefix apps/desktop run demo:electron
```

To run only Vite against an already-running chat-compatible adapter:

```powershell
$env:VITE_AWP_CHAT_ADAPTER_URL='http://127.0.0.1:9000'
npm run dev:web
```

## Executable contracts and clean builds

```bash
npm run test:demo-contract
npm run test:clean-output
npm run verify
```

For a non-interactive real Electron launch check, run `npm run demo:electron:smoke`. It performs the same local-mode clean build, opens Chat, Settings, and About through Playwright, exercises visible connection/thread-selection actions, and checks every renderer HTTP request. Only routes declared by the real demo adapter are accepted; undeclared routes, `4xx`/`5xx`, connection failures, unexpected loopback ports, and non-loopback renderer traffic fail the check. It then closes the owned Electron process tree and releases port `8787`.

The demo contract uses a random loopback port and temporary data. It exercises health/maintenance/changelog metadata, opt-in auth compatibility endpoints, chat SSE event order, history schemas, message append, session-id update, restart persistence, and strict `404` responses for unknown or retired routes. It also uploads a real multipart artifact, verifies its opaque-ID metadata and bytes across restart, rejects unsafe names/traversal and files over 8 MiB, checks download integrity. It imports and starts the same adapter used by the demos; there is no catch-all test server.

Every production build first removes only these direct children of this app:

- `dist`
- `dist-electron`
- `dist-awp-cloud-mcp`

The cleaner rejects unknown paths, traversal, and symbolic-link output roots. Electron and MCP production builds emit no `.map` files, and `verify:no-sourcemaps` checks the result.

## Local Windows installers

Build artifacts first and then create a local installer:

```bash
npm run build:electron
npm run build:electron:preview
```

`build:electron` creates the stable package under `build`. `build:electron:preview` uses the retained isolated Insiders runtime channel and writes under `build-insiders`; “preview” is the public command name. These workflows run the local `electron-builder` dependency and explicitly reject publish flags. They do not upload releases or require the removed private release pipeline.

For an unpacked stable directory, use `npm run build:electron:dir`.

The desktop package now uses `0.1.0` for its first public preview. `PROVENANCE.md` records the retired production snapshot, keeping source lineage separate from the new public release line. No tag or hosted release is created by these local scripts.

Node.js: `>=22.12.0`.

See [docs/local-demo-and-control-plane.md](docs/local-demo-and-control-plane.md) for the protocol boundary and [PROVENANCE.md](PROVENANCE.md) for the extraction boundary.

### Local trace flywheel

Local traces are off by default. Set `AWP_ENABLE_LOCAL_TRACE=1` to record bounded, rotating JSONL diagnostics on the current device. The collector recursively redacts common credential keys, token-like strings, private-key material, and URL query values; it never uploads. Treat the remaining tool summaries as private diagnostic data.

Compatible status streaming is an independent optional adapter. It requires exact `AWP_ENABLE_CONNECTION_HEALTH_SSE=1` plus a strict `AWP_CONNECTION_HEALTH_SSE_URL` and never falls back to the chat URL.
