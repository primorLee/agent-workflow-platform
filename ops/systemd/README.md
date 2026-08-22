# systemd templates

These units are deployment templates for one Linux host. They assume the
repository is present at `/opt/agent-workflow-platform`, a Python 3.12 virtual
environment exists at `/opt/agent-workflow-platform/.venv`, and service
configuration has been reviewed under `/etc/awp`. If your paths differ, edit
all `WorkingDirectory` and `ExecStart` entries before installing the units.

The hardening directives reduce accidental access for the checked-in services;
they are not an OS sandbox for untrusted task code.

## One-time host setup

1. Put a reviewed checkout at the path expected by the units and create the
   virtual environment. Dependency installation is an explicit networked step:

```bash
sudo install -d -o root -g root -m 0755 /opt/agent-workflow-platform
# Copy or clone the reviewed source into /opt/agent-workflow-platform first.
cd /opt/agent-workflow-platform
sudo python3.12 -m venv .venv
sudo .venv/bin/python -m pip install -r services/control-plane/requirements.txt
```

2. Create the service account and the independently managed backup and
   configuration directories. Do not pre-create `/var/lib/awp`: systemd creates
   that dedicated `StateDirectory` for the service with mode `0700`.

```bash
sudo useradd --system --no-create-home --home-dir /var/lib/awp --shell /usr/sbin/nologin awp
sudo install -d -o awp -g awp -m 0750 /var/backups/awp
sudo install -d -o root -g awp -m 0750 /etc/awp
```

`AWP_DATA_ROOT_BOOTSTRAP=1` lets the control plane claim only the empty,
unmarked state directory that systemd has just prepared. It tightens that
directory to mode `0700`, writes an ownership marker, and is safe on later
starts because the marker is validated. A non-empty unmarked directory is
still rejected without changing or deleting its contents.

3. Create `/etc/awp/control-plane.env` with `sudoedit`, set the deployment
   mode, database/broker choices, and an explicit API credential required by
   that mode, then restrict it:

```bash
sudoedit /etc/awp/control-plane.env
sudo chown root:awp /etc/awp/control-plane.env
sudo chmod 0640 /etc/awp/control-plane.env
```

Do not put credential values in command arguments, shell history, the unit
file, or this repository. Optional `/etc/awp/health-probe.env` and
`/etc/awp/backup.env` files may override the checked-in local probe and backup
settings.

4. Verify the source paths in each unit, then install and start them:

```bash
sudo install -m 0644 ops/systemd/awp-*.service ops/systemd/awp-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now awp-control-plane.service
sudo systemctl enable --now awp-health-probe.timer awp-db-backup.timer
```

The control plane binds only to loopback. Put TLS and any external identity
layer in a separately reviewed reverse proxy if remote access is required.
`RestartPreventExitStatus=77` prevents an explicitly permanent compatibility
failure from entering a restart loop.

## Verification

Run unit verification against the installed host because executable,
environment-file, user, and directory existence are host-specific:

```bash
systemd-analyze verify /etc/systemd/system/awp-*.service /etc/systemd/system/awp-*.timer
sudo systemctl status awp-control-plane.service
curl --fail http://127.0.0.1:8100/v1/health/ready
sudo systemctl start awp-health-probe.service
sudo systemctl start awp-db-backup.service
```

`sqlite_backup.py` uses SQLite's online backup API, includes committed WAL
pages, runs `PRAGMA integrity_check`, writes a SHA-256 sidecar, and then applies
retention. No generic broker-version rollback command is provided: the public
server does not read the former rollback flags. Define rollback around the
configuration and deployment mechanism that your composed service actually
uses.
