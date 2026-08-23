# Getting started

Agent Workflow Platform is a curated extraction of a retired production system,
not a newly written mock. The repository has two independently useful base
paths—a real model streamed through the Electron/Agent-CLI contract and a
managed task executed through the FastAPI/Python-worker stack—and one exact-
opt-in reference tool that joins them into a narrow end-to-end vertical slice.

## Prerequisites

| You want to run | Required locally |
| --- | --- |
| Full localhost task round trip | Docker Engine or Docker Desktop with Compose, plus Python 3.12 for the helper |
| Desktop, admin, or mobile web | Node.js `>=22.12.0`; a compatible CLI or model endpoint for real responses |
| Static gate, workflow runtime, control plane, or Python worker | Python 3.12 |
| VM agent | Go 1.25.13 exactly, as pinned by the [`go.mod`](../services/vm-agent/go.mod) `go` directive |
| Shell operations checks | Bash on Linux/macOS, WSL, or Git Bash |

On Windows, the doctor and validator derive Git Bash from the `git.exe`
installation root before checking standard Git for Windows locations. Git may
therefore be enough even when `bash.exe` is not separately on `PATH`.

Clone the public source preview:

```text
git clone https://github.com/primorLee/agent-workflow-platform.git
cd agent-workflow-platform
```

## 1. Recommended: complete localhost round trip

The Compose stack starts the FastAPI control plane, Redis, the trusted Python
worker, a random-key bootstrap job, and a loopback gateway:

```text
docker compose -f deploy/local/docker-compose.local-dev.yml config --quiet
docker compose -f deploy/local/docker-compose.local-dev.yml up -d --build
python scripts/wait_for_http.py http://127.0.0.1:8100/v1/health/ready --timeout 120 --json-field database
python scripts/submit_local_task.py --timeout 60
python scripts/verify_task_lifecycle.py --count 10 --timeout 120
```

The final command submits an allow-listed, shell-free Python invocation, waits
for the worker result, and prints its output. It accepts only the documented
localhost origin, disables ambient proxies and redirects, bounds responses, and
discovers the generated Compose key without printing it.

The backlog check submits ten tasks together and fails if any task is dropped,
left non-terminal, or completed unsuccessfully. CI additionally runs
`python scripts/verify_worker_crash_recovery.py --timeout 120`: it hard-stops
the busy demo worker, waits for lease-based requeue, restarts the worker, and
requires completion under a new attempt fence. That command intentionally
stops the local worker container for a short period.

The unusual network layout is intentional:

- FastAPI binds only to numeric loopback `127.0.0.1:8100`.
- The worker shares the control-plane network namespace and connects directly
  to that loopback socket.
- HAProxy shares the same namespace, listens on an internal bridge port, and
  Docker publishes that port only as host `127.0.0.1:8100`.
- The API key is random on first start and lives in a private named volume; no
  fixed development credential is checked in.

This proves the public task create, worker registration, capacity-aware claim,
leased retry, fenced result, SQLite, strict Redis broker, readiness, and
container network paths together. It does not prove exactly-once external side
effects, remote exposure, production scale, or untrusted-code isolation.

Stop the containers while retaining the named volumes:

```text
docker compose -f deploy/local/docker-compose.local-dev.yml down --remove-orphans
```

Add `-v` only when you explicitly want to discard the demo database, worker
state, Redis data, and generated local key.

## 2. Real model through Electron and the Agent CLI contract

The fastest credential-free real-model path uses a local server exposing the
OpenAI-compatible `POST /v1/chat/completions` streaming contract. For example,
after installing Ollama and pulling `llama3.2`:

### Windows PowerShell

```powershell
npm --prefix apps/desktop ci
$env:AWP_AGENT_MODEL='llama3.2'
npm --prefix apps/desktop run openai-compatible:electron
```

### Linux or macOS

```bash
npm --prefix apps/desktop ci
AWP_AGENT_MODEL=llama3.2 npm --prefix apps/desktop run openai-compatible:electron
```

The launcher defaults to `http://127.0.0.1:11434/v1`, starts the actual Electron
application, and configures the checked-in reference CLI without a shell. One
turn follows this path:

```text
Desktop renderer
  -> guarded main-process IPC
  -> long-lived reference CLI subprocess over JSONL
  -> user-selected OpenAI-compatible endpoint over streaming HTTP
  -> translated delta/usage/done events
  -> normal Desktop chat state and rendering
```

The reference CLI stores only conversation messages and its opaque session id
under the ignored `apps/desktop/.agent-data/reference-agent-sessions` directory.
On restart, Desktop supplies that id through `--resume`; the next provider
request includes the restored history. Provider tokens are read from the
launching process and are not written to the session file.

For a remote compatible endpoint, set all of the following in the launching
shell. The exact opt-in prevents a URL copied into another variable from
silently enabling remote traffic:

```powershell
$env:AWP_AGENT_API_BASE_URL='https://provider.example/v1'
$env:AWP_AGENT_API_TOKEN='<read from your own secret store>'
$env:AWP_AGENT_MODEL='provider-model-id'
$env:AWP_AGENT_REMOTE_API_OPT_IN='1'
npm --prefix apps/desktop run openai-compatible:electron
```

### Connect that model to the real local worker

The reference CLI is chat-only by default. With the Compose stack from step 1
still running, launch the Desktop with its single managed-task tool enabled:

```text
python scripts/launch_local_agent_desktop.py --model YOUR_TOOL_CAPABLE_MODEL
```

The selected endpoint and model must implement streamed OpenAI-style
`tool_calls`. The helper obtains the random Compose API key in memory and passes it only to
the child process environment. It does not print the key or place it in a
command argument. The complete turn can now be:

```text
Desktop -> reference Agent CLI -> real model
        <- awp_run_managed_task tool call
        -> FastAPI task API -> SQLite/Redis -> Python worker
        <- allow-listed process result
        -> real model final response -> Desktop stream
```

This reference bridge exposes exactly one tool. Arguments are bounded, the
executable must be a basename, the worker enforces its own allow-list, and no
shell is used. The model still chooses whether to call the tool. The worker is
a trusted launcher, not a sandbox; do not send it untrusted code.

The public CI runs this same bridge against a deterministic Chat Completions
fixture and the real Compose control plane/worker. That proves the wiring and
execution path without claiming that a hosted model or its credentials are in
the repository. The separate provider regression verifies streaming and native
session resume through a real subprocess.

For richer planning or tools, an existing Agent CLI can replace the reference
implementation by implementing the [AWP Agent CLI protocol](agent-cli-protocol.md):

```powershell
$env:AWP_AGENT_CLI_EXECUTABLE='C:\absolute\path\to\agent-cli.exe'
$env:AWP_AGENT_DEFAULT_MODEL='provider-model-id'
$env:AWP_AGENT_CLI_PROTOCOL='awp-jsonl'
$env:AWP_AGENT_CLI_ARGS_JSON='[]'
$env:AWP_AGENT_CLI_ENV_JSON='{}'
npm --prefix apps/desktop run agent:electron
```

`agent:electron` rejects relative paths and symbolic-link executables. It also
uses fail-visible mode: if the CLI cannot start or dies mid-turn, the Desktop
shows that failure and never replaces it with a deterministic response.

## 3. Deterministic Desktop UI and local stream adapter

The command is the same in PowerShell, Linux, and macOS:

```text
cd apps/desktop
npm ci
npm run dev
```

Open the URL printed by Vite. The command starts the Vue renderer and the owned
chat adapter on `127.0.0.1:8787`. Send a message, stop both processes, then run
`npm run dev` again: the conversation is restored from the ignored local demo
state through the normal history path.

To exercise the Electron main/preload and clean build path, run:

```text
npm run demo:electron
```

The local adapter uses an ephemeral in-memory capability and requires no
account. Hosted adapters are separate exact opt-ins. External Agent CLI
execution requires an explicit absolute executable or an explicitly signed
managed-runtime manifest; no provider binary is bundled. The deterministic
demo reply is not an LLM and does not prove arbitrary Agent CLI execution; it proves
the actual renderer, bounded HTTP client, SSE event parsing/rendering, durable
history/artifact contract, and restart recovery path.

The desktop adapter on port `8787` and the control plane on port `8100` expose
different protocols. Starting one does not silently emulate the other.

## 4. Workflow runtime in an existing project

The scheduler and guardian use only the Python standard library and keep
mutable state under the ignored `.agent-workflow/` directory:

```text
python workflows/runtime/scheduler.py add "Create a deterministic smoke test" 2 --group reliability
python workflows/runtime/scheduler.py heartbeat
python workflows/runtime/scheduler.py checkpoint "Run the regression and attach its output"
python workflows/runtime/guardian.py resume
```

`next <mode>` is a read-only preview. `batch start <mode>` re-reads state while
holding an OS lock and atomically claims dependency-ready tasks. See the
[workflow pack README](../workflows/README.md) and
[index](../workflows/INDEX.md) for scheduling modes, review roles, `/repro`,
templates, and incident recipes.

## 5. Public release gates

The static gate parses public JSON/YAML, compiles Python, checks manifests and
documentation links, enforces GitHub-hosted-only CI, runs scanner fail-closed
fixtures, and scans the public boundary. The workflow gate performs disposable
scheduler, locking, checkpoint/resume, and guardian regressions.

### Windows PowerShell

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-validation.txt
.\.venv\Scripts\python.exe scripts\doctor.py --component core
.\.venv\Scripts\python.exe scripts\validate.py --component static --component workflows
```

### Linux or macOS

```bash
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements-validation.txt
./.venv/bin/python scripts/doctor.py --component core
./.venv/bin/python scripts/validate.py --component static --component workflows
```

Add `--history` to the static validation before publication to scan every blob
reachable from current Git refs. The repository-specific scanner reports only
rule, path, and line metadata, never the matched value. CI separately runs
pinned Gitleaks and TruffleHog versions over complete history.

Generated `dist`/`build` trees are rescanned after desktop and admin builds.
Opaque binaries, package archives, databases, logs, private-key files, and
oversized/unreadable fixtures fail closed. Installer artifacts remain a
separate pre-tag gate because this source-preview CI does not publish them.

## 6. Manual control plane and Python worker

Compose is the recommended path. Use the manual path when you want to inspect
each process. It still supports loopback only and uses a random private key.

Install both services into one virtual environment:

Windows PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services\control-plane\requirements.txt -r services\worker-agent\requirements.txt
```

Linux or macOS:

```bash
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r services/control-plane/requirements.txt -r services/worker-agent/requirements.txt
```

### One-time private key setup

The commands below create an ignored key file without printing its value. POSIX
uses owner-only modes. The Windows example creates a protected parent DACL for
the current user because the Python storage checks reject reparse points but do
not independently prove Windows ACL privacy.

Windows PowerShell:

```powershell
$stateParent = [IO.Path]::GetFullPath((Join-Path $PWD.Path ".awp-data"))
New-Item -ItemType Directory -Force -Path $stateParent | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$stateAcl = [Security.AccessControl.DirectorySecurity]::new()
$stateAcl.SetOwner($currentSid)
$stateAcl.SetAccessRuleProtection($true, $false)
$stateRule = [Security.AccessControl.FileSystemAccessRule]::new($currentSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
$stateAcl.AddAccessRule($stateRule)
Set-Acl -LiteralPath $stateParent -AclObject $stateAcl
$secretDir = Join-Path $stateParent "secrets"
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$keyFile = Join-Path $secretDir "control-plane.key"
if (Test-Path -LiteralPath $keyFile) { throw "Key file already exists; reuse it or choose a new private path." }
$keyValue = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
[IO.File]::WriteAllText($keyFile, $keyValue + "`n", [Text.UTF8Encoding]::new($false))
```

Linux or macOS:

```bash
state_parent="$PWD/.awp-data"
secret_dir="$state_parent/secrets"
install -d -m 700 "$secret_dir"
key_file="$secret_dir/control-plane.key"
test ! -e "$key_file" || { printf '%s\n' 'Key file already exists; reuse it or choose a new private path.' >&2; exit 1; }
(umask 077; ./.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))' > "$key_file")
```

On restart, reuse that file and skip the one-time creation command.

### Terminal A: control plane

Windows PowerShell:

```powershell
$stateParent = [IO.Path]::GetFullPath((Join-Path $PWD.Path ".awp-data"))
$env:AWP_HOST = "127.0.0.1"
$env:AWP_DEV_API_KEY_FILE = Join-Path $stateParent "secrets\control-plane.key"
$env:AWP_DATA_DIR = Join-Path $stateParent "control-plane"
$env:AWP_DATABASE_URL = Join-Path $env:AWP_DATA_DIR "awp.db"
$env:AWP_WS_BROKER = "memory"
.\.venv\Scripts\python.exe services\control-plane\cloud\server.py
```

Linux or macOS:

```bash
state_parent="$PWD/.awp-data"
export AWP_HOST=127.0.0.1
export AWP_DEV_API_KEY_FILE="$state_parent/secrets/control-plane.key"
export AWP_DATA_DIR="$state_parent/control-plane"
export AWP_DATABASE_URL="$AWP_DATA_DIR/awp.db"
export AWP_WS_BROKER=memory
./.venv/bin/python services/control-plane/cloud/server.py
```

The supported entrypoint is `cloud/server.py`, which owns the validated socket
configuration. Readiness is
`http://127.0.0.1:8100/v1/health/ready`; interactive API docs are at
`http://127.0.0.1:8100/docs`.

The final `AWP_DATA_DIR` path must be absent on first use or already contain the
exact control-plane marker from an earlier run. A non-empty unmarked directory
is intentionally not adopted or migrated; choose a new dedicated path instead.

### Terminal B: Python worker

Windows PowerShell:

```powershell
if (!(Test-Path services\worker-agent\agent.yaml)) { Copy-Item services\worker-agent\agent.yaml.example services\worker-agent\agent.yaml }
$stateParent = [IO.Path]::GetFullPath((Join-Path $PWD.Path ".awp-data"))
$env:AWP_URL = "http://127.0.0.1:8100"
$env:AWP_API_KEY = (Get-Content -LiteralPath (Join-Path $stateParent "secrets\control-plane.key") -Raw).Trim()
$env:AWP_WORK_DIR = Join-Path $stateParent "worker-agent"
$env:AWP_TRUSTED_TASK_EXECUTION_OPT_IN = "1"
.\.venv\Scripts\python.exe services\worker-agent\agent.py --config services\worker-agent\agent.yaml
```

Linux or macOS:

```bash
test -e services/worker-agent/agent.yaml || cp services/worker-agent/agent.yaml.example services/worker-agent/agent.yaml
state_parent="$PWD/.awp-data"
export AWP_URL=http://127.0.0.1:8100
export AWP_API_KEY="$(tr -d '\r\n' < "$state_parent/secrets/control-plane.key")"
export AWP_WORK_DIR="$state_parent/worker-agent"
export AWP_TRUSTED_TASK_EXECUTION_OPT_IN=1
./.venv/bin/python services/worker-agent/agent.py --config services/worker-agent/agent.yaml
```

Only the exact opt-in value `1` enables execution. The worker is a trusted
single-operator launcher, not an OS sandbox. Run untrusted tasks under a
separate container or OS identity that cannot read worker credentials or host
files.

The final worker `work_dir` must also be absent on first start or already carry
the exact worker-owned marker. Old unmarked roots are not migrated. Successful
registration writes the agent token to private
`<work_dir>/state/agent.token`; the operator YAML is never modified.

### Terminal C: submit and observe one task

Windows PowerShell:

```powershell
$keyFile = [IO.Path]::GetFullPath((Join-Path $PWD.Path ".awp-data\secrets\control-plane.key"))
$env:AWP_DEV_API_KEY = (Get-Content -LiteralPath $keyFile -Raw).Trim()
.\.venv\Scripts\python.exe scripts\submit_local_task.py --timeout 60
```

Linux or macOS:

```bash
export AWP_DEV_API_KEY="$(tr -d '\r\n' < "$PWD/.awp-data/secrets/control-plane.key")"
./.venv/bin/python scripts/submit_local_task.py --timeout 60
```

The helper accepts only canonical localhost, refuses redirects and ambient
proxies, and waits for a terminal task state.

## 7. Admin monitor

After the control plane is healthy:

```text
cd apps/admin
npm ci
npm run dev
```

Open `http://127.0.0.1:5174/admin/` and enter the same random operator key. For
Compose, the retrieval command is documented in the
[admin README](../apps/admin/README.md). The monitor is read-only and keeps the
entered key only in browser `sessionStorage`.

## 8. VM agent: hydrate once, verify offline

The Go toolchain needs its public modules once:

```text
cd services/vm-agent
go mod download
cd ../..
python scripts/validate.py --component vm-agent
```

The validator then forces `GOPROXY=off` and `GOSUMDB=off` while it runs Go tests,
replay stress, `go vet`, and a disposable main build. A cold or incomplete
module cache fails instead of silently contacting the network.

The public Go `main` speaks a richer WebSocket protocol that the FastAPI demo
does not mount. Queue/replay and artifact upload are tested composition
packages, not all default-main features. There is no self-updater or published
VM binary.

## Other component checks

Install each component's dependencies first; the root validator never hides a
networked dependency-install step.

| Component | Command from repository root | Scope |
| --- | --- | --- |
| Control plane | `python scripts/validate.py --component control-plane` | API, auth, database, broker/SSE, sessions, rollout/sandbox libraries, logging and startup security |
| Python worker | `python scripts/validate.py --component worker-agent` | Trusted execution boundary, private state, token, process cleanup and offline replay |
| Desktop | `python scripts/validate.py --component desktop` | Lint, TypeScript, unit/contract tests, renderer and Electron/local-service builds |
| Admin/mobile | `python scripts/validate.py --component admin --component mobile` | Admin tests/typecheck/build and mobile typecheck/contracts |
| VM agent | `python scripts/validate.py --component vm-agent` | Offline protocol, dialer, runner, queue/replay, artifact, watchdog, vet and build checks |
| Operations | `python scripts/validate.py --component operations` | Health transitions, WAL backup/restore and public shell syntax |

For the wired metrics path, see [`deploy/README.md`](../deploy/README.md) and
`deploy/observability-stack.yml`. That example is for a Linux Docker host and
claims Prometheus/Grafana HTTP metrics only.

## Local state

`.awp-data/`, `.demo-data/`, `.agent-workflow/`, and the generated worker
`agent.yaml` are ignored. Do not remove a marked state root while its process is
running. Prefer a new path over attempting to repair or adopt an old unmarked
directory. The checked-in [`.env.example`](../.env.example) is a reference;
component commands do not load it implicitly.
