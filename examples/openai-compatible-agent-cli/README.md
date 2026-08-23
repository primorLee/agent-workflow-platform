# OpenAI-compatible reference Agent CLI

This example connects the real AWP Desktop subprocess protocol to an
OpenAI-compatible `POST /v1/chat/completions` streaming endpoint. It is useful
for validating the complete Desktop-to-model path and as source code for a
custom adapter.

It is not a general agent framework. By default it is chat-only. An exact
opt-in adds one bounded managed-task tool so the repository's full local
vertical slice can be exercised; planning, retrieval, domain tools, and
business logic still belong to the Agent CLI that a product developer brings.

## Run with a local model

After starting an OpenAI-compatible local server and making a model available:

```powershell
npm --prefix apps/desktop ci
$env:AWP_AGENT_MODEL='llama3.2'
npm --prefix apps/desktop run openai-compatible:electron
```

```bash
npm --prefix apps/desktop ci
AWP_AGENT_MODEL=llama3.2 npm --prefix apps/desktop run openai-compatible:electron
```

The default endpoint is `http://127.0.0.1:11434/v1`. A remote endpoint must use
HTTPS and additionally requires:

- `AWP_AGENT_API_BASE_URL`
- `AWP_AGENT_API_TOKEN` when the provider requires it
- `AWP_AGENT_REMOTE_API_OPT_IN=1`

Optional settings are `AWP_AGENT_SYSTEM_PROMPT`, `AWP_AGENT_TIMEOUT_MS`, and
`AWP_AGENT_STATE_DIR`.

## Optional local managed-task bridge

Start the local Compose stack, install Desktop dependencies, and then run from
the repository root:

```text
python scripts/launch_local_agent_desktop.py --model YOUR_TOOL_CAPABLE_MODEL
```

The endpoint and selected model must implement streamed OpenAI-style
`tool_calls`. The helper captures the generated localhost key without printing it and sets
the exact managed-task opt-in. The adapter exposes only
`awp_run_managed_task`; the worker's command allow-list remains authoritative.
The submitted `argv` is bounded and never interpreted by a shell. The Python
worker is a trusted launcher, not a security sandbox.

## What is exercised

```text
Electron renderer
  -> guarded IPC
  -> Electron main-process wrapper
  -> this long-lived JSONL process
  -> streaming compatible provider
  -> Desktop text, usage, completion, and error events
```

With the managed-task opt-in, a provider tool call adds:

```text
reference CLI -> FastAPI task API -> real polling worker -> allow-listed process
              <- bounded task result <-
              -> provider follow-up -> Desktop final response
```

History uses same-filesystem replace writes in a per-session JSON file so the opaque id emitted
by `system/init` can restore provider messages after an application restart.
Files contain messages, not provider credentials.

See the complete [AWP Agent CLI protocol](../../docs/agent-cli-protocol.md),
including failure and trust-boundary semantics.
