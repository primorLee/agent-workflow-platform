# Control-plane monitor

This Vue application is a read-only monitor for the Agent Workflow Platform
control plane. It calls the mounted health, task, and session APIs; it does not
contain a second mock backend and it never mutates control-plane state.

## Run against the local Compose stack

Start the stack from the repository root:

```text
docker compose -f deploy/local/docker-compose.local-dev.yml up -d --build
python scripts/wait_for_http.py http://127.0.0.1:8100/v1/health/ready --timeout 120 --json-field database
```

Compose generates a random control-plane key in a private named volume. To open
the monitor, retrieve that local key from the running control-plane container
and treat the terminal output as a secret:

```text
docker compose -f deploy/local/docker-compose.local-dev.yml exec -T control-plane python -c "from config import DEV_API_KEY; print(DEV_API_KEY)"
```

Then start the UI:

```text
cd apps/admin
npm ci
npm run dev
```

Open `http://127.0.0.1:5174/admin/` and paste the retrieved key. There is no
fixed development key in the public workflow.

For a manually started control plane, enter the same random key supplied through
`AWP_DEV_API_KEY` or the private file named by `AWP_DEV_API_KEY_FILE`.

## Browser security boundary

`VITE_AWP_API_URL` defaults to `http://127.0.0.1:8100` and accepts only a
canonical loopback URL. Vite proxies `/awp-api` in development and preview mode
because the control plane deliberately does not enable broad browser CORS. For
a downstream deployment, place the built UI and API behind the same reviewed
reverse proxy.

The operator key is entered at runtime and held only in `sessionStorage`. It is
removed by **Disconnect** or when the browser session ends. Never put a real key
in a `VITE_*` variable: Vite embeds those values in browser assets.

## What is shown

- `/v1/health/live` and `/v1/health/ready`: HTTP, SQLite, and broker readiness;
- `/v1/tasks`: task status, assignment, payload, result, and timestamps;
- `/v1/sessions`: active session type, heartbeat, metadata, and resource hints.

Session resource values are scheduling hints reported by the registry, not
proof of CPU, memory, disk, container, or OS-level enforcement.

## Verify

```text
npm run verify
```

This runs response-normalization tests, strict Vue/TypeScript checks, and a
production build. `npm run preview` serves that build at
`http://127.0.0.1:4174/admin/` with the same local API proxy.
