# Agent Workflow Platform mobile monitor

This Expo app is a faithful extraction of the production mobile operator shell:
local settings, pull-to-refresh, defensive API handling, background
polling, local notifications, light/dark themes, and detail navigation are
retained. The retired hosted digest and domain-specific result panels were
removed.

The app now talks only to the public local control-plane contract:

- `GET /v1/health/ready`
- `GET /v1/tasks`
- `GET /v1/sessions`

It does not use a hosted account or a mobile-only backend.

This directory is an optional source harness; no mobile binary is published from
this repository. It is intended for trusted local control-plane data and local
operator-selected attachments. Before the first binary release, rerun the
production dependency audit and resolve or isolate every remaining upstream
Expo toolchain advisory rather than applying the audit tool's incompatible
major-version downgrade suggestion.

As of 2026-08-22, `npm audit` reports 11 moderate, 0 high, and 0 critical
findings in the Expo 57 toolchain. Its automatic fixes require an incompatible
major change or downgrade, so this repository does not force them. CI still runs a
clean Linux install and TypeScript check.

## Run

Use Node `>=22.12.0`.

```bash
npm ci
npm run typecheck
npm run doctor
npm start
```

The default URL is `http://127.0.0.1:8100`, but the development key is empty.
Start the control plane first, retrieve its Compose-generated random key, and paste
it into Settings:

```powershell
$key = docker compose -f deploy/local/docker-compose.local-dev.yml exec -T control-plane python -c "from config import DEV_API_KEY; print(DEV_API_KEY)"
```

The source preview persists the URL and development key through AsyncStorage
(browser storage when run on the web). That is convenience storage, not
OS-backed secret protection. Use only disposable local-development credentials
here; never paste a production credential. A native secure-storage integration
is required before treating a future binary as a production credential client.

The loopback URL works only when the app and control plane share the same host (for
example, a local simulator with host-loopback support).

For an Android device connected over USB, keep the loopback URL and forward the
port without exposing the service on the LAN:

```bash
adb reverse tcp:8100 tcp:8100
```

Remove the forwarding rule when testing is complete. Do not bind the development
control plane to `0.0.0.0` or advertise an unauthenticated plaintext LAN URL.
A physical iOS device cannot use `adb reverse`; provide an operator-managed HTTPS
reverse proxy or trusted tunnel and enter that HTTPS origin in Settings.

Background scheduling is best-effort and controlled by iOS/Android. The first
successful poll records a baseline without sending alerts; later newly failed
tasks trigger a local notification.
