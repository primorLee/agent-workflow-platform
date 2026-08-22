# Local HTTP observability preview

This deployment example runs the part of the observability path that is
actually wired: Prometheus scrapes the control-plane `/metrics` endpoint and
Grafana provisions a dashboard for those HTTP metrics.

It intentionally does **not** claim to provide traces, log transport,
OpenTelemetry collection, Alertmanager delivery, TLS, backups, or a hosted
monitoring service. Prometheus evaluates the checked-in alert rules, but no
notification receiver is configured.

## Scope and platform

The stack uses Linux host networking so that it can reach a control-plane which
is correctly bound to `127.0.0.1:8100`. Prometheus and Grafana also listen only
on loopback (`127.0.0.1:9090` and `127.0.0.1:3000`). This avoids weakening the
control-plane's non-loopback startup policy just to make a local monitoring
demo work.

Use this Compose file on a Linux Docker host. Docker Desktop host-network
support is optional and platform/version dependent, so it is not claimed by
this source preview.

## Start it safely

Create two different, untracked files containing strong random values. Each
file must contain only one value and should be readable only by its owner.

```sh
install -d -m 700 .local-observability-secrets
umask 077
openssl rand -hex 32 > .local-observability-secrets/metrics-token
openssl rand -base64 36 > .local-observability-secrets/grafana-password
export AWP_METRICS_BEARER_TOKEN_FILE="$PWD/.local-observability-secrets/metrics-token"
export AWP_GRAFANA_ADMIN_PASSWORD_FILE="$PWD/.local-observability-secrets/grafana-password"
```

Start the control-plane on loopback with the same metrics bearer token:

```sh
export AWP_DEV_API_KEY="$(openssl rand -hex 32)"
export AWP_METRICS_BEARER_TOKEN="$(tr -d '\r\n' < "$AWP_METRICS_BEARER_TOKEN_FILE")"
export AWP_HOST=127.0.0.1
python services/control-plane/cloud/server.py
```

In another shell, export the two `*_FILE` variables again and start the
monitoring stack:

```sh
docker compose -f deploy/observability-stack.yml config --quiet
docker compose -f deploy/observability-stack.yml up -d
```

Compose fails during interpolation if either secret-file variable is absent.
There is no checked-in Grafana password and no password fallback. Open Grafana
at <http://127.0.0.1:3000>; the initial username is Grafana's standard
`admin` account and the password is the value in your private file.

Stop the containers with:

```sh
docker compose -f deploy/observability-stack.yml down
```

Named Prometheus and Grafana volumes are retained. Add `-v` only when you
explicitly want to discard that local monitoring data. The generated
`.local-observability-secrets/` directory is ignored by Git.
