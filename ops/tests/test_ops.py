from __future__ import annotations

import hashlib
import importlib.util
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OPS = Path(__file__).resolve().parents[1]
SYSTEMD = OPS / "systemd"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


health_probe = load_module("awp_health_probe", OPS / "monitoring" / "health_probe.py")
sqlite_backup = load_module("awp_sqlite_backup", OPS / "backup" / "sqlite_backup.py")


def test_control_plane_systemd_private_state_directory_contract():
    control = (SYSTEMD / "awp-control-plane.service").read_text(encoding="utf-8")
    backup = (SYSTEMD / "awp-db-backup.service").read_text(encoding="utf-8")
    probe = (SYSTEMD / "awp-health-probe.service").read_text(encoding="utf-8")
    readme = (SYSTEMD / "README.md").read_text(encoding="utf-8")

    assert "Environment=AWP_DATA_DIR=/var/lib/awp" in control
    assert "Environment=AWP_DATA_ROOT_BOOTSTRAP=1" in control
    for unit in (control, backup, probe):
        assert "StateDirectory=awp" in unit
        assert "StateDirectoryMode=0700" in unit

    assert "useradd --system --no-create-home --home-dir /var/lib/awp" in readme
    assert "Do not pre-create `/var/lib/awp`" in readme
    assert "-m 0750 /var/lib/awp" not in readme
    assert "empty,\nunmarked state directory" in readme
    assert "non-empty unmarked directory is\nstill rejected" in readme


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/ok" else 503)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, _format, *_args):
        pass


def test_health_probe_success_and_failure_transition():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        healthy, status, error, _latency = health_probe.probe_once(base, "/ok", 2)
        assert healthy and status == 200 and error is None
        failed, status, error, _latency = health_probe.probe_once(base, "/fail", 2)
        assert not failed and status == 503 and error == "HTTP 503"
        state = health_probe.EndpointState()
        assert health_probe.update_state(state, False, 503, error, 1.0, 2) is None
        assert health_probe.update_state(state, False, 503, error, 1.0, 2) == "failed"
        assert health_probe.update_state(state, True, 200, None, 1.0, 2) == "recovered"
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_sqlite_backup_captures_wal_and_checksum(tmp_path):
    source = tmp_path / "awp.db"
    connection = sqlite3.connect(source)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE tasks(id INTEGER PRIMARY KEY, name TEXT)")
    connection.execute("INSERT INTO tasks(name) VALUES ('durable')")
    connection.commit()
    destination = tmp_path / "backups"
    backup = sqlite_backup.create_backup(source, destination, retention=2)
    with sqlite3.connect(backup) as restored:
        assert restored.execute("SELECT name FROM tasks").fetchone()[0] == "durable"
        assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    expected = hashlib.sha256(backup.read_bytes()).hexdigest()
    assert backup.with_suffix(".db.sha256").read_text(encoding="ascii").strip() == expected
    connection.close()
REPO = OPS.parent
VM_INSTALL = REPO / "services" / "vm-agent" / "install"


def _bash() -> str:
    import os
    import shutil

    binary = shutil.which("bash")
    if binary:
        return binary
    if os.name == "nt":
        git = shutil.which("git")
        candidates = []
        if git:
            git_path = Path(git).resolve()
            candidates.extend((git_path.parent.parent / "bin" / "bash.exe", git_path.parent / "bash.exe"))
        program_files = os.environ.get("ProgramFiles")
        if program_files:
            candidates.append(Path(program_files) / "Git" / "bin" / "bash.exe")
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
    raise AssertionError("bash is required by the operations validation component")


def _write_script(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8", newline="\n")
    path.chmod(0o755)


def _fake_root_environment(tmp_path: Path) -> dict[str, str]:
    import os

    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(exist_ok=True)
    _write_script(fake_bin / "id", "#!/bin/sh\nprintf '0\\n'\n")
    _write_script(
        fake_bin / "flock",
        "#!/bin/sh\n"
        "[ \"${AWP_TEST_LOCK_LOSER:-0}\" = 1 ] && exit 1\n"
        "exit 0\n",
    )
    _write_script(fake_bin / "gpg", "#!/bin/sh\nexit 0\n")
    _write_script(
        fake_bin / "getent",
        "#!/bin/sh\n"
        "case \"$1\" in\n"
        "  passwd) db=$AWP_TEST_PASSWD_DB ;;\n"
        "  group) db=$AWP_TEST_GROUP_DB ;;\n"
        "  *) exit 2 ;;\n"
        "esac\n"
        "[ -f \"$db\" ] || exit 1\n"
        "grep \"^$2:\" \"$db\"\n",
    )
    _write_script(
        fake_bin / "groupadd",
        "#!/bin/sh\n"
        "printf 'groupadd %s\\n' \"$*\" >>\"$AWP_ACCOUNT_LOG\"\n"
        "[ \"$*\" = '-r awp-vm-agent' ] || exit 64\n"
        "if [ \"${AWP_TEST_RACE_GROUPADD:-0}\" = 1 ]; then\n"
        "  printf 'awp-vm-agent:x:%s:\\n' \"$AWP_TEST_GID\" >\"$AWP_TEST_GROUP_DB\"; exit 9\n"
        "fi\n"
        "[ \"${AWP_TEST_FAIL_GROUPADD:-0}\" = 1 ] && exit 9\n"
        "printf 'awp-vm-agent:x:%s:\\n' \"$AWP_TEST_GID\" >\"$AWP_TEST_GROUP_DB\"\n",
    )
    _write_script(
        fake_bin / "useradd",
        "#!/bin/sh\n"
        "printf 'useradd %s\\n' \"$*\" >>\"$AWP_ACCOUNT_LOG\"\n"
        "expected=\"-r -g awp-vm-agent -M -d $AWP_TEST_DATA_DIR -s $AWP_TEST_SHELL awp-vm-agent\"\n"
        "[ \"$*\" = \"$expected\" ] || exit 64\n"
        "if [ \"${AWP_TEST_RACE_USERADD:-0}\" = 1 ]; then\n"
        "  printf 'awp-vm-agent:x:%s:%s::%s:%s\\n' \"$AWP_TEST_UID\" \"$AWP_TEST_GID\" \"$AWP_TEST_DATA_DIR\" \"$AWP_TEST_SHELL\" >\"$AWP_TEST_PASSWD_DB\"; exit 9\n"
        "fi\n"
        "[ \"${AWP_TEST_FAIL_USERADD:-0}\" = 1 ] && exit 9\n"
        "printf 'awp-vm-agent:x:%s:%s::%s:%s\\n' \"$AWP_TEST_UID\" \"$AWP_TEST_GID\" \"$AWP_TEST_DATA_DIR\" \"$AWP_TEST_SHELL\" >\"$AWP_TEST_PASSWD_DB\"\n",
    )
    inherited_names = (
        "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE",
        "PATH",
        "TEMP", "TMP",
    )
    environment = {name: os.environ[name] for name in inherited_names if name in os.environ}
    bash_tmp = tmp_path / "bash-tmp"
    bash_tmp.mkdir(exist_ok=True)
    if os.name == "nt":
        def msys(path: Path) -> str:
            value = path.resolve().as_posix()
            return f"/{value[0].lower()}{value[2:]}"
        environment["PATH"] = f"{msys(fake_bin)}:/usr/bin:/bin:/mingw64/bin"
        environment["AWP_TEST_FAKE_BIN"] = msys(fake_bin)
        environment["TMPDIR"] = msys(bash_tmp)
    else:
        environment["PATH"] = str(fake_bin) + os.pathsep + environment.get("PATH", "")
        environment["TMPDIR"] = str(bash_tmp)
    environment["LC_ALL"] = "C"
    environment["LANG"] = "C"
    environment["AWP_TEST_PASSWD_DB"] = str(tmp_path / "passwd.db")
    environment["AWP_TEST_GROUP_DB"] = str(tmp_path / "group.db")
    environment["AWP_ACCOUNT_LOG"] = str(tmp_path / "account.log")
    environment["AWP_TEST_UID"] = "42420"
    environment["AWP_TEST_GID"] = "42420"
    return environment


def _combined_output(result) -> str:
    return (result.stdout or "") + (result.stderr or "")


def _run_script(path: Path, arguments: tuple[str, ...], environment: dict[str, str], timeout: int = 20):
    import os
    import subprocess

    if os.name == "nt" and environment.get("AWP_TEST_FAKE_BIN"):
        command = [
            _bash(), "-c", 'PATH="$1:$PATH"; shift; exec "$@"',
            "awp-test", environment["AWP_TEST_FAKE_BIN"], str(path), *arguments,
        ]
    else:
        command = [_bash(), str(path), *arguments]
    return subprocess.run(
        command,
        cwd=REPO,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def _run_install(tmp_path: Path, *arguments: str, test_mode: str | None = None):
    environment = _fake_root_environment(tmp_path)
    if test_mode is not None:
        environment["AWP_INSTALL_TEST_MODE"] = test_mode
    else:
        environment.pop("AWP_INSTALL_TEST_MODE", None)
    dry_args = arguments if "--dry-run" in arguments else (*arguments, "--dry-run")
    return _run_script(VM_INSTALL / "install.sh", tuple(dry_args), environment)


def _prepare_test_root(tmp_path: Path, name: str) -> Path:
    root = tmp_path / f"awp-install-test.{name}"
    for directory in (
        root / "usr" / "local" / "bin",
        root / "usr" / "sbin",
        root / "etc" / "systemd" / "system",
        root / "etc" / "init.d",
        root / "var" / "lib",
        root / "var" / "log",
        root / "run" / "lock",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    shell = root / "usr" / "sbin" / "nologin"
    _write_script(shell, "#!/bin/sh\nexit 1\n")
    return root


def _lifecycle_environment(tmp_path: Path, root: Path, init_system: str = "systemd") -> dict[str, str]:
    import os

    environment = _fake_root_environment(tmp_path)
    root_value = root.resolve().as_posix()
    if os.name == "nt":
        root_value = f"/{root_value[0].lower()}{root_value[2:]}"
    environment.update(
        {
            "AWP_INSTALL_TEST_MODE": "1",
            "AWP_INSTALL_TEST_ROOT": root_value,
            "AWP_INSTALL_TEST_INIT": init_system,
            "AWP_INSTALL_TEST_INSTALL_ID": "a" * 64,
            "AWP_INSTALL_MUTATION_LOG": str(tmp_path / "mutations.log"),
            "AWP_TEST_DATA_DIR": f"{root_value}/var/lib/awp-vm-agent",
            "AWP_TEST_SHELL": f"{root_value}/usr/sbin/nologin",
        }
    )
    return environment


def _release_arguments(tmp_path: Path) -> tuple[tuple[str, ...], str]:
    artifact = tmp_path / "awp-vm-agent-fixture"
    _write_script(
        artifact,
        "#!/bin/sh\n"
        "if [ \"${1:-}\" = --version ]; then printf 'awp-vm-agent test\\n'; exit 0; fi\n"
        "exit 0\n",
    )
    signature = tmp_path / "awp-vm-agent-fixture.asc"
    signature.write_text("detached test signature\n", encoding="utf-8")
    pubkey = tmp_path / "release.asc"
    pubkey.write_text("reviewed test public key\n", encoding="utf-8")
    api_key = tmp_path / "agent-api-key"
    secret = "unit-test-sentinel"
    api_key.write_text(secret + "\n", encoding="utf-8")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    arguments = (
        "--server-url", "ws://127.0.0.1:8100/agent/connect",
        "--binary-url", artifact.resolve().as_uri(),
        "--signature-url", signature.resolve().as_uri(),
        "--binary-sha256", digest,
        "--pubkey", str(pubkey),
        "--api-key-file", str(api_key),
        "--arch", "amd64",
        "--force-distro-unknown",
    )
    return arguments, secret


def _marker(root: Path) -> dict[str, str]:
    marker = root / "etc" / "awp-vm-agent" / ".awp-install-owner-v1"
    lines = marker.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 17
    return dict(line.split("=", 1) for line in lines)


def test_vm_installer_contract_is_explicit_and_fail_closed(tmp_path):
    installer = (VM_INSTALL / "install.sh").read_text(encoding="utf-8")
    uninstaller = (VM_INSTALL / "uninstall.sh").read_text(encoding="utf-8")
    bootstrap = (VM_INSTALL / "one-liner.sh").read_text(encoding="utf-8")
    sysv_init = (VM_INSTALL / "awp-vm-agent.init.d").read_text(encoding="utf-8")
    openrc = (VM_INSTALL / "openrc" / "awp-vm-agent").read_text(encoding="utf-8")

    assert 'SVC_USER="awp-vm-agent"' in installer
    assert 'SVC_GROUP="awp-vm-agent"' in installer
    assert '.awp-install-owner-v1' in installer
    assert 'groupadd -r "$SVC_GROUP"' in installer
    assert 'useradd -r -g "$SVC_GROUP" -M -d "$DATA_DIR" -s "$FRESH_SHELL"' in installer
    assert 'flock -n 9' in installer
    assert 'START_SERVICE=0' in installer
    assert '[ "$START_SERVICE" -eq 1 ] || return 0' in installer
    assert "--api-key)" not in installer
    assert "--api-key-file)" in installer
    assert 'AWP_INSTALL_TEST_MODE' in installer
    assert 'mktemp -d "${TMP_ROOT%/}/awp-vm-agent.XXXXXX"' in installer
    assert "userdel" not in uninstaller
    assert "deluser" not in uninstaller
    assert "rm -rf" not in uninstaller
    assert '--purge is disabled' in uninstaller
    assert "unknown argument" in uninstaller

    for service in (sysv_init, openrc):
        assert "awp-vm-agent-owner-v1" in service
        assert "validate_contract" in service
        assert "awp-vm-agent" in service
        assert "/run/${PROG}" in service
        assert "mkdir -p /var/" not in service
        assert "chown -R" not in service
    assert 'RUNDIR=/run/${PROG}' in sysv_init
    assert 'runuser -s /bin/sh "$SVC_USER" -c' in sysv_init
    assert 'command_user="awp-vm-agent:awp-vm-agent"' in openrc

    assert "curl" not in bootstrap
    assert "mktemp" not in bootstrap
    disabled = _run_script(VM_INSTALL / "one-liner.sh", (), _fake_root_environment(tmp_path))
    assert disabled.returncode == 77
    assert "unsupported" in _combined_output(disabled)


def test_vm_installer_required_fields_and_exact_test_mode(tmp_path):
    pubkey = tmp_path / "release.asc"
    pubkey.write_text("not a real key", encoding="utf-8")
    key_file = tmp_path / "agent-api-key"
    secret = "unit-test-sentinel"
    key_file.write_text(secret + "\n", encoding="utf-8")
    artifact = tmp_path / "agent"
    _write_script(artifact, "#!/bin/sh\nexit 0\n")
    signature = tmp_path / "agent.asc"
    signature.write_text("signature\n", encoding="utf-8")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    server = "ws://127.0.0.1:8100/agent/connect"

    insecure = _run_install(
        tmp_path,
        "--server-url", server,
        "--binary-url", "http://example.invalid/agent",
        test_mode="1",
    )
    assert insecure.returncode != 0
    assert "must use HTTPS" in _combined_output(insecure)

    arguments = (
        "--server-url", server,
        "--binary-url", artifact.resolve().as_uri(),
        "--signature-url", signature.resolve().as_uri(),
        "--binary-sha256", digest,
        "--pubkey", str(pubkey),
        "--api-key-file", str(key_file),
        "--arch", "amd64",
        "--force-distro-unknown",
        "--dry-run",
    )
    for mode in (None, "0", "true", "01"):
        result = _run_install(tmp_path, *arguments, test_mode=mode)
        assert result.returncode != 0
        assert "file URL is test-only" in _combined_output(result)
        assert secret not in _combined_output(result)

    exact = _run_install(tmp_path, *arguments, test_mode="1")
    assert exact.returncode == 0
    assert "no host mutation occurred" in _combined_output(exact)
    assert secret not in _combined_output(exact)


def test_vm_manual_lifecycle_fresh_reinstall_retained_and_purge(tmp_path):
    root = _prepare_test_root(tmp_path, "lifecycle")
    environment = _lifecycle_environment(tmp_path, root)
    arguments, secret = _release_arguments(tmp_path)
    mutation_log = Path(environment["AWP_INSTALL_MUTATION_LOG"])
    account_log = Path(environment["AWP_ACCOUNT_LOG"])
    test_root = environment["AWP_INSTALL_TEST_ROOT"]

    fresh = _run_script(VM_INSTALL / "install.sh", arguments, environment)
    assert fresh.returncode == 0, _combined_output(fresh)
    assert secret not in _combined_output(fresh)
    installed = _marker(root)
    assert installed == {
        "schema": "awp-vm-agent-owner-v1",
        "state": "installed",
        "install-id": "a" * 64,
        "registered": "0",
        "user": "awp-vm-agent",
        "uid": "42420",
        "group": "awp-vm-agent",
        "gid": "42420",
        "home": f"{test_root}/var/lib/awp-vm-agent",
        "shell": f"{test_root}/usr/sbin/nologin",
        "conf": f"{test_root}/etc/awp-vm-agent",
        "data": f"{test_root}/var/lib/awp-vm-agent",
        "log": f"{test_root}/var/log/awp-vm-agent",
        "binary": f"{test_root}/usr/local/bin/awp-vm-agent",
        "systemd": f"{test_root}/etc/systemd/system/awp-vm-agent.service",
        "init": f"{test_root}/etc/init.d/awp-vm-agent",
        "init-system": "systemd",
    }
    account_calls = account_log.read_text(encoding="utf-8").splitlines()
    assert account_calls == [
        "groupadd -r awp-vm-agent",
        (
            "useradd -r -g awp-vm-agent -M -d "
            f"{test_root}/var/lib/awp-vm-agent -s "
            f"{test_root}/usr/sbin/nologin awp-vm-agent"
        ),
    ]
    assert (root / "etc/awp-vm-agent/agent.env").read_text(encoding="utf-8") == f"AWP_AGENT_API_KEY={secret}\n"

    mutation_log.write_text("", encoding="utf-8")
    no_replace = _run_script(VM_INSTALL / "install.sh", arguments, environment)
    assert no_replace.returncode == 77
    assert mutation_log.read_text(encoding="utf-8") == ""

    replaced = _run_script(VM_INSTALL / "install.sh", (*arguments, "--replace-config"), environment)
    assert replaced.returncode == 0, _combined_output(replaced)
    assert _marker(root)["install-id"] == installed["install-id"]
    assert account_log.read_text(encoding="utf-8").splitlines() == account_calls

    for rejected in (("--unknown",), ("--purge",)):
        mutation_log.write_text("", encoding="utf-8")
        result = _run_script(VM_INSTALL / "uninstall.sh", rejected, environment)
        assert result.returncode in (1, 77)
        assert mutation_log.read_text(encoding="utf-8") == ""

    mutation_log.write_text("", encoding="utf-8")
    removed = _run_script(VM_INSTALL / "uninstall.sh", (), environment)
    assert removed.returncode == 0, _combined_output(removed)
    retained = _marker(root)
    assert retained["state"] == "retained"
    assert retained["registered"] == "0"
    assert retained["install-id"] == installed["install-id"]
    assert not (root / "usr/local/bin/awp-vm-agent").exists()
    assert not (root / "etc/systemd/system/awp-vm-agent.service").exists()
    for kept in (
        root / "etc/awp-vm-agent/config.yaml",
        root / "etc/awp-vm-agent/agent.env",
        root / "var/lib/awp-vm-agent",
        root / "var/log/awp-vm-agent",
    ):
        assert kept.exists()
    assert Path(environment["AWP_TEST_PASSWD_DB"]).exists()
    assert Path(environment["AWP_TEST_GROUP_DB"]).exists()

    mutation_log.write_text("", encoding="utf-8")
    repeated = _run_script(VM_INSTALL / "uninstall.sh", (), environment)
    assert repeated.returncode == 0
    assert mutation_log.read_text(encoding="utf-8") == ""

    restored = _run_script(VM_INSTALL / "install.sh", (*arguments, "--replace-config"), environment)
    assert restored.returncode == 0, _combined_output(restored)
    assert _marker(root)["install-id"] == installed["install-id"]


def test_vm_manual_installer_collision_marker_and_lock_matrix(tmp_path):
    arguments, _secret = _release_arguments(tmp_path)

    def run_case(name: str, seed, extra_env: dict[str, str] | None = None):
        case_dir = tmp_path / name
        case_dir.mkdir()
        root = _prepare_test_root(case_dir, name)
        environment = _lifecycle_environment(case_dir, root)
        if extra_env:
            environment.update(extra_env)
        seed(case_dir, root, environment)
        log = Path(environment["AWP_INSTALL_MUTATION_LOG"])
        result = _run_script(VM_INSTALL / "install.sh", arguments, environment)
        assert result.returncode == 77, _combined_output(result)
        assert not log.exists() or log.read_text(encoding="utf-8") == ""
        return root

    def account_collision(case_dir, root, environment):
        Path(environment["AWP_TEST_GROUP_DB"]).write_text("awp-vm-agent:x:42420:\n", encoding="utf-8")
        Path(environment["AWP_TEST_PASSWD_DB"]).write_text(
            f"awp-vm-agent:x:42420:42420::{environment['AWP_TEST_DATA_DIR']}:{environment['AWP_TEST_SHELL']}\n",
            encoding="utf-8",
        )

    def directory_collision(_case_dir, root, _environment):
        (root / "etc/awp-vm-agent").mkdir()

    def corrupt_marker(_case_dir, root, environment):
        conf = root / "etc/awp-vm-agent"
        conf.mkdir()
        marker = conf / ".awp-install-owner-v1"
        marker.write_text("schema=wrong\n", encoding="utf-8")
        (root / ".awp-install-test-meta").write_text(
            f"{environment['AWP_INSTALL_TEST_ROOT']}/etc/awp-vm-agent/.awp-install-owner-v1\t0\t0\t400\n", encoding="utf-8"
        )

    run_case("account", account_collision)
    run_case("directory", directory_collision)
    run_case("marker", corrupt_marker)
    run_case("lock", lambda *_args: None, {"AWP_TEST_LOCK_LOSER": "1"})


def test_vm_account_mutation_failures_are_not_swallowed(tmp_path):
    root = _prepare_test_root(tmp_path, "account-failure")
    environment = _lifecycle_environment(tmp_path, root)
    environment["AWP_TEST_FAIL_GROUPADD"] = "1"
    arguments, _secret = _release_arguments(tmp_path)
    result = _run_script(VM_INSTALL / "install.sh", arguments, environment)
    assert result.returncode == 77
    calls = Path(environment["AWP_ACCOUNT_LOG"]).read_text(encoding="utf-8").splitlines()
    assert calls == ["groupadd -r awp-vm-agent"]
    assert not Path(environment["AWP_TEST_GROUP_DB"]).exists()
    assert not Path(environment["AWP_TEST_PASSWD_DB"]).exists()
    assert not (root / "etc/awp-vm-agent").exists()

    group_case = tmp_path / "group-race"
    group_case.mkdir()
    group_root = _prepare_test_root(group_case, "group-race")
    group_env = _lifecycle_environment(group_case, group_root)
    group_env["AWP_TEST_RACE_GROUPADD"] = "1"
    group_result = _run_script(VM_INSTALL / "install.sh", arguments, group_env)
    assert group_result.returncode == 77
    assert "group creation raced" in _combined_output(group_result)
    assert Path(group_env["AWP_TEST_GROUP_DB"]).exists()
    assert not Path(group_env["AWP_TEST_PASSWD_DB"]).exists()
    assert not (group_root / "etc/awp-vm-agent").exists()

    user_case = tmp_path / "user-race"
    user_case.mkdir()
    user_root = _prepare_test_root(user_case, "user-race")
    user_env = _lifecycle_environment(user_case, user_root)
    user_env["AWP_TEST_RACE_USERADD"] = "1"
    user_result = _run_script(VM_INSTALL / "install.sh", arguments, user_env)
    assert user_result.returncode == 77
    assert "user creation raced" in _combined_output(user_result)
    assert Path(user_env["AWP_TEST_GROUP_DB"]).exists()
    assert Path(user_env["AWP_TEST_PASSWD_DB"]).exists()
    assert not (user_root / "etc/awp-vm-agent").exists()


def test_vm_package_hooks_and_make_targets_fail_before_mutation(tmp_path):
    import re

    hook_paths = (
        REPO / "services/vm-agent/packaging/debian/preinst",
        REPO / "services/vm-agent/packaging/debian/postinst",
        REPO / "services/vm-agent/packaging/debian/prerm",
        REPO / "services/vm-agent/packaging/debian/postrm",
        REPO / "services/vm-agent/packaging/apk/awp-vm-agent.pre-install",
        REPO / "services/vm-agent/packaging/apk/awp-vm-agent.post-install",
        REPO / "services/vm-agent/packaging/apk/awp-vm-agent.pre-deinstall",
    )
    environment = _fake_root_environment(tmp_path)
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("unchanged\n", encoding="utf-8")
    before = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    for hook in hook_paths:
        result = _run_script(hook, ("configure",), environment)
        assert result.returncode == 77
        assert "source preview" in _combined_output(result)
    after = {p.relative_to(tmp_path): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert after == before

    lifecycle_sources = [*(p.read_text(encoding="utf-8") for p in hook_paths)]
    lifecycle_sources.extend(
        [
            (VM_INSTALL / "uninstall.sh").read_text(encoding="utf-8"),
            (REPO / "services/vm-agent/packaging/awp-vm-agent.spec").read_text(encoding="utf-8"),
        ]
    )
    joined = "\n".join(lifecycle_sources)
    assert not re.search(r"\b(userdel|deluser)\b", joined)
    assert "rm -rf" not in joined
    assert "chown -R" not in joined

    makefile = (REPO / "services/vm-agent/Makefile").read_text(encoding="utf-8")
    for target in (
        "package-tar", "package-rpm", "package-deb", "package-apk",
        "package-all", "install-local", "uninstall-local",
    ):
        assert re.search(rf"(?m)^{re.escape(target)}:\s*$", makefile)
    assert "install/uninstall.sh --purge" not in makefile
    assert makefile.count("unsupported until a signed release is published") >= 5


def test_vm_runtime_inputs_permission_model_and_stub(tmp_path):
    import os
    import stat
    import subprocess

    import pytest

    config_root = tmp_path / "etc" / "awp-vm-agent"
    config_root.mkdir(parents=True)
    config = config_root / "config.yaml"
    env_file = config_root / "agent.env"
    config.write_text(
        "server_url: ws://127.0.0.1:8100/agent/connect\n"
        "agent_name: permission-smoke\n",
        encoding="utf-8",
    )
    env_file.write_text("AWP_AGENT_API_KEY=smoke-test-key\n", encoding="utf-8")
    config_root.chmod(0o750)
    config.chmod(0o640)
    env_file.chmod(0o640)

    metadata = {
        config_root: ("root", "awp-vm-agent", 0o750),
        config: ("root", "awp-vm-agent", 0o640),
        env_file: ("root", "awp-vm-agent", 0o640),
    }

    def access_bits(user: str, groups: frozenset[str], target: Path) -> int:
        owner, group, mode = metadata[target]
        shift = 6 if user == owner else 3 if group in groups else 0
        return (mode >> shift) & 0o7

    def modeled_read(user: str, groups: frozenset[str], target: Path) -> str:
        if not (access_bits(user, groups, config_root) & 0o1):
            raise PermissionError("identity cannot traverse config root")
        if not (access_bits(user, groups, target) & 0o4):
            raise PermissionError("identity cannot read runtime input")
        return target.read_text(encoding="utf-8")

    service_groups = frozenset({"awp-vm-agent"})
    assert modeled_read("awp-vm-agent", service_groups, config).startswith("server_url:")
    assert modeled_read("awp-vm-agent", service_groups, env_file).startswith("AWP_AGENT_API_KEY=")
    with pytest.raises(PermissionError):
        modeled_read("outsider", frozenset({"outsider"}), config)
    with pytest.raises(PermissionError):
        modeled_read("outsider", frozenset({"outsider"}), env_file)

    if os.name != "nt":
        assert stat.S_IMODE(config_root.stat().st_mode) == 0o750
        assert stat.S_IMODE(config.stat().st_mode) == 0o640
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o640

    environment = os.environ.copy()
    environment["AWP_AGENT_API_KEY"] = "smoke-test-key"
    environment["AWP_SMOKE_ENV_FILE"] = env_file.as_posix()
    environment["AWP_SMOKE_ONESHOT"] = "1"
    fake_binary = REPO / "services" / "vm-agent" / "test" / "distros" / "common" / "fake-binary.sh"
    result = subprocess.run(
        [_bash(), fake_binary.as_posix(), "--daemon", "--config", config.as_posix()],
        cwd=REPO,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )
    output = _combined_output(result)
    assert result.returncode == 0
    assert output.strip() == "runtime-inputs-readable"
    assert "smoke-test-key" not in output


def test_systemd_and_release_docs_match_wired_behavior():
    import subprocess

    vm_unit = (VM_INSTALL / "awp-vm-agent.service").read_text(encoding="utf-8")
    control_unit = (OPS / "systemd" / "awp-control-plane.service").read_text(encoding="utf-8")
    rollback_path = OPS / "rollback" / "broker_v2_to_v1.sh"
    rollback = rollback_path.read_text(encoding="utf-8")
    makefile = (REPO / "services" / "vm-agent" / "Makefile").read_text(encoding="utf-8")
    getting_started = (REPO / "docs" / "getting-started.md").read_text(encoding="utf-8")
    architecture = (REPO / "docs" / "architecture.md").read_text(encoding="utf-8")
    control_readme = (REPO / "services" / "control-plane" / "README.md").read_text(encoding="utf-8")
    distro_smoke = (REPO / "services" / "vm-agent" / "test" / "distros" / "common" / "smoke.sh").read_text(encoding="utf-8")
    distro_runner = (REPO / "services" / "vm-agent" / "test" / "distros" / "run-all.sh").read_text(encoding="utf-8")

    for unit in (vm_unit, control_unit):
        assert "RestartPreventExitStatus=77" in unit
    assert "Documentation=http" not in vm_unit
    assert "EnvironmentFile=/etc/awp-vm-agent/agent.env" in vm_unit
    assert "EnvironmentFile=/etc/awp/control-plane.env" in control_unit

    assert "exit 77" in rollback
    assert "systemctl" not in rollback
    assert "AWP_BROKER_V2=" not in rollback
    disabled = subprocess.run(
        [_bash(), str(rollback_path)], cwd=REPO,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=10, check=False,
    )
    assert disabled.returncode == 77
    assert "unsupported" in _combined_output(disabled)
    assert "sign-release" not in makefile
    assert "one-liner-pin" not in makefile
    assert "-X main.Version=$(VERSION)" in makefile
    assert "Node.js `>=22.12.0`" in getting_started
    assert "^20.19.0" not in getting_started
    assert "caller and adapter responsibility" in architecture
    assert "never part of workflow state" not in architecture
    assert "outside the default HTTP" in control_readme
    assert "not features activated" in control_readme
    assert "AWP_INSTALL_TEST_MODE=1" in distro_smoke
    assert "--binary-sha256" in distro_smoke
    assert "--pubkey" in distro_smoke
    assert "--api-key-file" in distro_smoke
    assert "--server-url" in distro_smoke
    assert "--cdn-base" not in distro_smoke
    assert '${VM_AGENT_ROOT}/install:/src/install:ro' in distro_runner
    assert "/vm-agent/install:/src/install" not in distro_runner


def test_retired_vm_runtime_update_source_and_identifiers_are_absent():
    vm_root = REPO / "services" / "vm-agent"
    assert not (vm_root / "internal" / "updater").exists()
    banned = (
        b"internal/" + b"updater",
        b"AWP_AGENT_" + b"SIGNING_OPTIONAL",
        b"/v1/agent/" + b"version/check",
        b"/v1/agent/" + b"version/report",
        b"awp-vm-agent-" + b"revocation",
    )
    offenders: list[str] = []
    for path in vm_root.rglob("*"):
        if not path.is_file() or path.stat().st_size > 1_000_000:
            continue
        payload = path.read_bytes()
        if any(token in payload for token in banned):
            offenders.append(path.relative_to(vm_root).as_posix())
    assert offenders == []
