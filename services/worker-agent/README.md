# AWP worker agent

The Python worker is the outbound-only, poll-based execution adapter. It keeps
the production mechanisms that matter: bounded concurrency, retry with
backoff, FIFO offline result replay, process-tree cleanup, atomic status,
single-instance ownership, disk-pressure cleanup, and graceful drain.

## Local trusted-operator demo

Task execution is disabled by default. For a loopback demo operated by one
trusted user:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
cp agent.yaml.example agent.yaml
export AWP_TRUSTED_TASK_EXECUTION_OPT_IN=1
.venv/bin/python agent.py --config agent.yaml
```

Only the exact value `1` enables execution. Values such as `true`, `01`,
or whitespace-padded `1` remain disabled. The opt-in is never copied into a
task environment.

This mode is **not an OS sandbox**. An allowed interpreter can access resources
available to the worker's operating-system identity and can start other
programs. Untrusted or multi-tenant tasks need a separate container or OS
identity with no mounted host credentials.

## Private state root

`work_dir` is a dedicated application-owned state root, not a shared project
folder. On first start its final path must not already exist. The worker creates
it with a fixed marker and private permissions; later starts accept only that
same marked root. An unmarked directory, symlink/reparse point, wrong POSIX
owner or mode, or linked fixed-name state file is a fatal integrity error. In
Compose, mount the parent volume and use a new child such as `/state/work`.

The root contains:

- `state/agent.token`: the registered agent token, written with a random
  exclusive temporary file, fsync, atomic replace, and directory fsync.
- `offline-queue/` and `rejected/`: strict, size-bounded replay records.
- `tasks/<task-id>--<random-run-id>/`: per-attempt task state.
- `worker.pid`: a persistent, private single-instance lock file.
- `worker.status.json`: an atomically replaced status snapshot.
- `worker.log` and five bounded rotations, all opened without following
  links.

Registration never edits the operator's YAML. `AWP_AGENT_TOKEN` or an explicit
YAML token takes precedence; otherwise the worker reads its private saved token.
Filesystem integrity errors fail closed rather than changing permissions,
adopting paths, or following links.

## Execution boundary

Tasks contain `payload.argv`, for example
`{"argv":["python","-c","print('hello')"]}`. `argv[0]` must be a strict
basename from `runner.allowed_commands`; absolute paths and all path separators
are rejected. At worker startup each available basename is resolved to a fixed
absolute executable outside the task root, and that frozen path is used for
execution. This allowlist limits accidental command selection but does not turn
an interpreter into a sandbox.

Each task receives a newly constructed minimal environment. Control-plane
variables, proxy settings, and names associated with credentials are never
inherited and cannot be added to `runner.allowed_env_keys`. Explicit safe keys
may be listed. Task `HOME` and temporary directories point into that attempt's
random run directory.

Input paths are created one private component at a time; traversal, links,
pre-existing files, oversized files, and permissive directories are rejected.
A task run directory is never reopened or adopted, even if its marker looks
valid. Normal and disk-pressure cleanup can remove only random run directories
created and tracked by the current process. Runs left by a prior process are
retained for operator inspection. Cleanup rechecks the directory inode, marker,
containment, mode, owner, and every link/reparse boundary before recursive
removal.

The runner never invokes a shell implicitly, caps captured output, and tracks
the initial process tree. POSIX tasks use a dedicated session/process group.
Windows tasks are assigned before resume to a verified kill-on-close Job
Object. Timeout, cancellation, and parent exit trigger bounded descendant
cleanup. A trusted POSIX task can deliberately detach into a new session, so
this remains best-effort process-tree cleanup rather than a sandbox.

## Offline result replay

A transport failure stores a strict, size-bounded result record using a random
`O_EXCL` file with private permissions and durable metadata. Replay atomically
claims one file before sending. A process-wide lock plus the claim prevents
concurrent flushes from double-sending a record. Orphan claims are recovered on
the next flush, so delivery is intentionally at-least-once.

Transient transport failures return the claim to the FIFO queue and stop that
flush. A non-retryable 4xx response moves only that record into the owned
`rejected/` directory and continues with later results, preventing one bad
record from starving the queue. Malformed records are also rejected. Unsafe,
linked, wrong-owner, wrong-mode, oversized, or identity-changing entries are
left untouched and never read through another path.

## Control-plane transport

Use HTTPS for every non-loopback control plane. Plain HTTP is accepted only for
exact `localhost` or an IP loopback literal, without DNS lookup. URLs with
userinfo, query strings, fragments, malformed authorities, or ambiguous host
syntax are rejected. Authenticated requests use a private HTTP session with
ambient proxy discovery disabled and never follow redirects. Transport and
worker errors are logged as finite error types rather than raw exception text.

Use `AWP_URL`, `AWP_API_KEY`, `AWP_AGENT_TOKEN`, and `AWP_WORK_DIR` to
override file settings without baking credentials into images.
