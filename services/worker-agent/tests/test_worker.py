import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import requests

import agent as agent_module
from agent import (
    Agent,
    CommandRunner,
    _InstanceLock,
    _TASK_MARKER_NAME,
    _TASK_MARKER_SCHEMA,
    _setup_logging,
    _write_status,
)
from cloud_client import (
    CloudClient,
    PermanentRequestError,
    validate_cloud_url,
)
from config import load, load_saved_token, save_token
from storage import prepare_app_root, write_exclusive


_EXECUTABLE = Path(sys.executable).name
_SECRET_FIXTURE = "seeded-host-credential-fixture"
_ATTEMPT_ID = "00000000-0000-4000-8000-000000000001"


def _prepare_trusted_host(monkeypatch, opt_in="1"):
    monkeypatch.setenv(
        "PATH",
        str(Path(sys.executable).resolve().parent) + os.pathsep + os.environ.get("PATH", ""),
    )
    if opt_in is None:
        monkeypatch.delenv("AWP_TRUSTED_TASK_EXECUTION_OPT_IN", raising=False)
    else:
        monkeypatch.setenv("AWP_TRUSTED_TASK_EXECUTION_OPT_IN", opt_in)


def config_dict(tmp_path, *, timeout=5, allowed_env_keys=None, keep_workdirs=True):
    return {
        "work_dir": str(tmp_path / "work"),
        "runner": {
            "allowed_commands": [_EXECUTABLE],
            "allowed_env_keys": list(allowed_env_keys or []),
            "timeout_seconds": timeout,
            "max_output_bytes": 65536,
            "keep_workdirs": keep_workdirs,
        },
    }


def cloud_config(tmp_path, **overrides):
    cfg = {
        "cloud_url": "http://127.0.0.1:8100",
        "api_key": "local-test-key",
        "agent_token": None,
        "request_timeout": 1,
        "work_dir": str(tmp_path / "cloud-work"),
    }
    cfg.update(overrides)
    return cfg


@pytest.mark.parametrize("value", [None, "", "true", "01", " 1", "1 "])
def test_command_runner_requires_exact_trusted_opt_in(tmp_path, monkeypatch, value):
    _prepare_trusted_host(monkeypatch, value)
    runner = CommandRunner(config_dict(tmp_path))
    with pytest.raises(PermissionError, match="explicitly opt in"):
        runner.run({
            "task_id": "opt-in-denied",
            "argv": [_EXECUTABLE, "-c", "print('must not run')"],
        })


def test_command_runner_executes_resolved_argv_without_shell(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path))
    result = runner.run({
        "task_id": "task-1",
        "argv": [_EXECUTABLE, "-c", "print('hello')"],
    })
    assert result["status"] == "success"
    assert result["output"]["exit_code"] == 0
    assert result["output"]["timed_out"] is False
    assert result["output"]["canceled"] is False
    assert "hello" in result["output"]["stdout"]


@pytest.mark.parametrize("disguised", [
    str(Path(sys.executable).resolve()),
    "./" + _EXECUTABLE,
    ".\\" + _EXECUTABLE,
    "subdir/" + _EXECUTABLE,
    "subdir\\" + _EXECUTABLE,
    "C:" + _EXECUTABLE,
])
def test_command_runner_rejects_path_disguised_argv0(tmp_path, monkeypatch, disguised):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path))
    with pytest.raises(PermissionError, match="basename"):
        runner.run({"task_id": "path-denied", "argv": [disguised]})


def test_command_runner_ignores_same_name_file_in_task_directory(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path))
    result = runner.run({
        "task_id": "fixed-executable",
        "argv": [_EXECUTABLE, "-c", "print('trusted-runtime')"],
        "files": {_EXECUTABLE: "this task file must never be executed"},
    })
    assert result["status"] == "success"
    assert result["output"]["stdout"].strip() == "trusted-runtime"


def test_command_runner_rejects_unlisted_command_and_input_escape(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path))
    with pytest.raises(PermissionError):
        runner.run({"task_id": "task-2", "argv": ["definitely-not-allowed"]})
    with pytest.raises(ValueError):
        runner.run({
            "task_id": "task-3",
            "argv": [_EXECUTABLE, "-c", "print('x')"],
            "files": {"../escape.txt": "blocked"},
        })


def test_task_gets_minimal_env_without_seeded_host_secrets(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    seeded = {
        "AWP_AGENT_TOKEN": _SECRET_FIXTURE,
        "HTTPS_PROXY": "http://" + _SECRET_FIXTURE + "@proxy.invalid",
        "HOST_DATABASE_PASSWORD": _SECRET_FIXTURE,
        "GITHUB_TOKEN": _SECRET_FIXTURE,
        "SAFE_PARENT_VALUE": _SECRET_FIXTURE,
    }
    for key, value in seeded.items():
        monkeypatch.setenv(key, value)
    runner = CommandRunner(config_dict(tmp_path, allowed_env_keys=["TASK_MODE"]))
    result = runner.run({
        "task_id": "minimal-env",
        "argv": [
            _EXECUTABLE,
            "-c",
            "import json, os; print(json.dumps(dict(os.environ), sort_keys=True))",
        ],
        "env": {"TASK_MODE": "local-fixture"},
    })
    output = result["output"]["stdout"]
    child_env = json.loads(output)
    assert _SECRET_FIXTURE not in output
    assert child_env["TASK_MODE"] == "local-fixture"
    assert Path(child_env["HOME"]).name.startswith("minimal-env--")
    for key in [*seeded, "AWP_TRUSTED_TASK_EXECUTION_OPT_IN"]:
        assert key not in child_env


@pytest.mark.parametrize("key", [
    "AWP_AGENT_TOKEN",
    "HTTPS_PROXY",
    "GITHUB_TOKEN",
    "DATABASE_PASSWORD",
    "SERVICE_CREDENTIAL",
    "AUTH_HEADER",
])
def test_runner_rejects_sensitive_env_allowlist_keys(tmp_path, monkeypatch, key):
    _prepare_trusted_host(monkeypatch)
    with pytest.raises(ValueError, match="forbidden key"):
        CommandRunner(config_dict(tmp_path, allowed_env_keys=[key]))


_PARENT_SCRIPT = """
import os
import subprocess
import sys
import time
from pathlib import Path

child = subprocess.Popen([sys.executable, "grandchild.py"])
Path("parent.pid").write_text(str(os.getpid()), encoding="ascii")
Path("grandchild.pid").write_text(str(child.pid), encoding="ascii")
while True:
    time.sleep(1)
"""

_GRANDCHILD_SCRIPT = """
import os
import time
from pathlib import Path

Path("grandchild.started").write_text(str(os.getpid()), encoding="ascii")
heartbeat = Path("grandchild.heartbeat")
while True:
    heartbeat.write_text(str(time.monotonic_ns()), encoding="ascii")
    time.sleep(0.05)
"""


def _wait_for_path(path: Path, timeout=4.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {path.name}")


def _process_is_alive(pid: int) -> bool:
    if os.name == "nt":
        synchronize = 0x00100000
        wait_timeout = 0x00000102
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
        finally:
            kernel32.CloseHandle(handle)
    stat = Path(f"/proc/{pid}/stat")
    if stat.exists():
        try:
            if stat.read_text(encoding="ascii").split()[2] == "Z":
                return False
        except (OSError, IndexError):
            pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def _assert_process_gone(pid: int):
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and _process_is_alive(pid):
        time.sleep(0.05)
    assert not _process_is_alive(pid), f"owned process {pid} survived tree cleanup"


def _wait_for_run(runner: CommandRunner, task_id: str, timeout=4.0) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with runner._task_dirs_lock:
            record = runner._owned_runs.get(task_id)
            if record is not None:
                return record["path"]
        time.sleep(0.02)
    raise AssertionError("timed out waiting for a tracked task run")


@pytest.mark.parametrize("mode", ["timeout", "cancel"])
def test_timeout_and_cancel_remove_owned_parent_and_grandchild(tmp_path, monkeypatch, mode):
    _prepare_trusted_host(monkeypatch)
    timeout = 0.7 if mode == "timeout" else 10
    cfg = config_dict(tmp_path, timeout=timeout)
    runner = CommandRunner(cfg)
    task_id = "tree-" + mode
    task = {
        "task_id": task_id,
        "argv": [_EXECUTABLE, "parent.py"],
        "files": {"parent.py": _PARENT_SCRIPT, "grandchild.py": _GRANDCHILD_SCRIPT},
    }
    cancel_event = threading.Event()
    holder = {}

    if mode == "cancel":
        def execute():
            try:
                holder["result"] = runner.run(task, cancel_event=cancel_event)
            except BaseException as exc:
                holder["error"] = exc

        thread = threading.Thread(target=execute, daemon=True)
        thread.start()
        task_dir = _wait_for_run(runner, task_id)
        _wait_for_path(task_dir / "grandchild.pid")
        cancel_event.set()
        thread.join(timeout=6)
        assert not thread.is_alive(), "canceled runner did not return within its bound"
        assert "error" not in holder, repr(holder.get("error"))
        result = holder["result"]
    else:
        result = runner.run(task)
        task_dir = _wait_for_run(runner, task_id)

    assert result["status"] == "error"
    assert result["output"]["timed_out"] is (mode == "timeout")
    assert result["output"]["canceled"] is (mode == "cancel")
    _wait_for_path(task_dir / "parent.pid")
    _wait_for_path(task_dir / "grandchild.pid")
    parent_pid = int((task_dir / "parent.pid").read_text(encoding="ascii"))
    grandchild_pid = int((task_dir / "grandchild.pid").read_text(encoding="ascii"))
    _assert_process_gone(parent_pid)
    _assert_process_gone(grandchild_pid)
    heartbeat = task_dir / "grandchild.heartbeat"
    if heartbeat.exists():
        before = heartbeat.read_text(encoding="ascii")
        time.sleep(0.15)
        assert heartbeat.read_text(encoding="ascii") == before


def _create_directory_link(link: Path, target: Path):
    try:
        os.symlink(target, link, target_is_directory=True)
        return
    except (OSError, NotImplementedError):
        if os.name != "nt":
            raise
    command = [
        os.environ.get("COMSPEC", "cmd.exe"),
        "/d",
        "/c",
        "mklink",
        "/J",
        str(link),
        str(target),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        pytest.fail(f"could not create reparse-point fixture (exit {result.returncode})")


def _write_task_marker(directory: Path, task_id: str):
    (directory / _TASK_MARKER_NAME).write_text(
        json.dumps({
            "schema": _TASK_MARKER_SCHEMA,
            "task_id": task_id,
            "run_id": "fixture",
        }),
        encoding="utf-8",
    )


def test_normal_cleanup_never_creates_or_deletes_unowned_paths(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    cfg = config_dict(tmp_path, keep_workdirs=False)
    runner = CommandRunner(cfg)
    work_root = Path(cfg["work_dir"])
    tasks_root = work_root / "tasks"

    before = {path.name for path in tasks_root.iterdir()}
    runner.cleanup("missing-task")
    assert {path.name for path in tasks_root.iterdir()} == before

    result = runner.run({
        "task_id": "owned-cleanup",
        "argv": [_EXECUTABLE, "-c", "print('owned')"],
    })
    assert result["status"] == "success"
    owned = runner._owned_runs["owned-cleanup"]["path"]
    assert owned.is_dir()
    assert owned.name.startswith("owned-cleanup--")

    unmarked = tasks_root / "unmarked-task"
    unmarked.mkdir()
    wrong = tasks_root / "wrong-marker"
    wrong.mkdir()
    _write_task_marker(wrong, "different-task")
    target = work_root / "user-link-target"
    target.mkdir()
    (target / "sentinel.txt").write_text("keep", encoding="utf-8")
    linked = tasks_root / "linked-task"
    _create_directory_link(linked, target)

    runner.cleanup("unmarked-task")
    runner.cleanup("wrong-marker")
    runner.cleanup("linked-task")
    assert unmarked.is_dir()
    assert wrong.is_dir()
    assert os.path.lexists(linked)
    assert (target / "sentinel.txt").read_text(encoding="utf-8") == "keep"

    runner.cleanup("owned-cleanup")
    assert not owned.exists()


def test_pressure_cleanup_only_removes_current_process_runs(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    cfg = config_dict(tmp_path)
    runner = CommandRunner(cfg)
    work_root = Path(cfg["work_dir"])
    user_neighbor = work_root / "user-project"
    user_neighbor.mkdir()
    (user_neighbor / "sentinel.txt").write_text("keep", encoding="utf-8")
    legacy = work_root / "legacy-task-layout"
    legacy.mkdir()
    (legacy / "sentinel.txt").write_text("keep", encoding="utf-8")

    for task_id in ("owned-old", "owned-new"):
        result = runner.run({
            "task_id": task_id,
            "argv": [_EXECUTABLE, "-c", "print('owned')"],
        })
        assert result["status"] == "success"
        time.sleep(0.01)
    tasks_root = work_root / "tasks"
    owned_old = runner._owned_runs["owned-old"]["path"]
    owned_new = runner._owned_runs["owned-new"]["path"]

    unmarked = tasks_root / "unmarked-task"
    unmarked.mkdir()
    wrong = tasks_root / "wrong-marker"
    wrong.mkdir()
    _write_task_marker(wrong, "not-wrong-marker")
    target = work_root / "linked-user-directory"
    target.mkdir()
    (target / "sentinel.txt").write_text("keep", encoding="utf-8")
    linked = tasks_root / "linked-task"
    _create_directory_link(linked, target)

    assert runner.cleanup_oldest(keep=1) == 1
    assert not owned_old.exists()
    assert owned_new.is_dir()
    assert user_neighbor.is_dir()
    assert legacy.is_dir(), "legacy layout must not be migrated or deleted"
    assert unmarked.is_dir()
    assert wrong.is_dir()
    assert os.path.lexists(linked)
    assert (target / "sentinel.txt").read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize(("raw", "valid"), [
    ("https://control.example.test", True),
    ("https://192.0.2.20:443/api", True),
    ("https://[2001:db8::1]:443", True),
    ("https://single-label", True),
    ("http://localhost:8100", True),
    ("http://LOCALHOST", True),
    ("http://127.255.255.254:8100", True),
    ("http://[::1]:8100", True),
    ("ftp://localhost", False),
    ("//localhost", False),
    ("http:///missing-host", False),
    ("http://user" + ":password@localhost", False),
    ("https://user" + ":password@control.example.test", False),
    ("http://localhost?mode=test", False),
    ("http://localhost#fragment", False),
    (" http://localhost", False),
    ("http://local\nhost", False),
    ("http://localhost\\@example.test", False),
    ("http://localhost:", False),
    ("http://localhost:0", False),
    ("http://localhost:65536", False),
    ("http://localhost:abc", False),
    ("http://::1:8100", False),
    ("http://[::1%25zone]:8100", False),
    ("http://localhost.evil", False),
    ("http://evil-localhost", False),
    ("http://localhost.", False),
    ("http://192.0.2.20", False),
    ("http://[2001:db8::1]", False),
    ("http://127.1", False),
    ("http://2130706433", False),
    ("http://0177.0.0.1", False),
    ("http://%6cocalhost", False),
    ("https://bad_host.example", False),
    ("https://bad..host", False),
])
def test_cloud_url_transport_boundary(raw, valid):
    if valid:
        assert validate_cloud_url(raw)
    else:
        with pytest.raises(ValueError):
            validate_cloud_url(raw)


def test_cloud_url_errors_do_not_echo_url_or_credentials():
    bad_urls = [
        "https://user:" + _SECRET_FIXTURE + "@control.example.test",
        "http://localhost.evil/" + _SECRET_FIXTURE,
        "not-a-url-" + _SECRET_FIXTURE,
    ]
    for raw in bad_urls:
        with pytest.raises(ValueError) as caught:
            validate_cloud_url(raw)
        assert _SECRET_FIXTURE not in str(caught.value)
        assert raw not in str(caught.value)


def test_authenticated_requests_disable_redirects_and_ambient_proxy(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("HTTP_PROXY", "http://" + _SECRET_FIXTURE + "@proxy.invalid")
    monkeypatch.setenv("HTTPS_PROXY", "http://" + _SECRET_FIXTURE + "@proxy.invalid")

    class Response:
        status_code = 200
        content = b"{}"

        @staticmethod
        def json():
            return {}

    def fake_request(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    client = CloudClient(cloud_config(tmp_path, agent_token=_SECRET_FIXTURE))
    assert client._session.trust_env is False
    assert client._session.proxies == {}
    monkeypatch.setattr(client._session, "request", fake_request)
    assert client._request("GET", "/v1/agent/tasks/pending", retries=1) == {}
    assert len(calls) == 1
    assert calls[0][1]["allow_redirects"] is False
    assert "proxies" not in calls[0][1]
    assert calls[0][1]["headers"]["Authorization"] == "Bearer " + _SECRET_FIXTURE


def test_redirect_and_transport_errors_are_sanitized(tmp_path, monkeypatch, caplog):
    client = CloudClient(cloud_config(tmp_path, agent_token=_SECRET_FIXTURE))

    class RedirectResponse:
        status_code = 302
        content = b""

    monkeypatch.setattr(
        client._session,
        "request",
        lambda *args, **kwargs: RedirectResponse(),
    )
    with pytest.raises(requests.HTTPError) as redirect_error:
        client._request("GET", "/redirect", retries=1)
    assert _SECRET_FIXTURE not in str(redirect_error.value)
    assert client._base not in str(redirect_error.value)

    def failed_request(*args, **kwargs):
        raise requests.ConnectionError(_SECRET_FIXTURE + " " + client._base)

    monkeypatch.setattr(client._session, "request", failed_request)
    with pytest.raises(ConnectionError) as transport_error:
        client._request("GET", "/failed", retries=1)
    assert _SECRET_FIXTURE not in str(transport_error.value)
    assert client._base not in str(transport_error.value)
    assert _SECRET_FIXTURE not in caplog.text
    assert client._base not in caplog.text

def _queue_payload(task_id: str) -> dict:
    return {
        "task_id": task_id,
        "payload": {
            "attempt_id": _ATTEMPT_ID,
            "status": "success",
            "output": {"exit_code": 0},
            "logs": "",
            "duration_s": 0,
        },
    }


def test_cloud_client_requests_exact_free_slots_and_preserves_fenced_identity(
    tmp_path, monkeypatch
):
    client = CloudClient(cloud_config(tmp_path))
    seen = []

    def request(method, path, payload=None, retries=5):
        seen.append((method, path))
        return [
            {
                "id": "authoritative-task",
                "type": "command",
                "attempt_id": _ATTEMPT_ID,
                "retry_count": 2,
                "payload": {
                    "task_id": "payload-must-not-override",
                    "_awp_attempt_id": "payload-must-not-override",
                    "argv": [_EXECUTABLE, "-V"],
                },
            }
        ]

    monkeypatch.setattr(client, "_request", request)
    tasks = client.poll_tasks(slots=2)
    assert seen == [("GET", "/v1/agent/tasks/pending?slots=2")]
    assert tasks == [
        {
            "task_id": "authoritative-task",
            "task_type": "command",
            "_awp_attempt_id": _ATTEMPT_ID,
            "_awp_retry_count": 2,
            "argv": [_EXECUTABLE, "-V"],
        }
    ]


def test_agent_never_drops_an_already_claimed_overflow_response(tmp_path, monkeypatch):
    class PendingFuture:
        def done(self):
            return False

    class RecordingPool:
        def __init__(self):
            self.submissions = []

        def submit(self, function, task):
            self.submissions.append((function, task))
            return PendingFuture()

    class RecordingCloud:
        def __init__(self):
            self.requested_slots = []
            self.heartbeats = []

        def heartbeat(self, **payload):
            self.heartbeats.append(payload)

        def flush_offline(self):
            return 0

        def poll_tasks(self, slots):
            self.requested_slots.append(slots)
            # A broken/older server may violate the requested capacity. Once
            # claimed, the worker must queue and renew every attempt, not drop it.
            return [
                {
                    "task_id": f"overflow-{index}",
                    "_awp_attempt_id": f"00000000-0000-4000-8000-{index:012d}",
                    "argv": [_EXECUTABLE, "-V"],
                }
                for index in range(3)
            ]

    class Runner:
        def cleanup_oldest(self, **_kwargs):
            return None

    instance = object.__new__(Agent)
    instance._cfg = {"work_dir": str(tmp_path)}
    instance._cloud = RecordingCloud()
    instance._runner = Runner()
    instance._max_concurrent = 2
    instance._running = {}
    instance._running_attempts = {}
    instance._started = time.time()
    instance._completed = 0
    instance._last_error = ""
    pool = RecordingPool()
    monkeypatch.setattr(agent_module, "_write_status", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        agent_module.shutil,
        "disk_usage",
        lambda _path: type("Usage", (), {"free": 1024 * 1024 * 1024})(),
    )

    instance._tick(pool)

    assert instance._cloud.requested_slots == [2]
    assert len(pool.submissions) == 3
    assert set(instance._running) == {"overflow-0", "overflow-1", "overflow-2"}
    assert set(instance._running_attempts) == set(instance._running)


def test_offline_result_replay_remains_fifo(tmp_path, monkeypatch):
    client = CloudClient(cloud_config(tmp_path))
    client._cache_offline("result", _queue_payload("first"))
    time.sleep(0.001)
    client._cache_offline("result", _queue_payload("second"))
    seen = []

    def record_request(method, path, payload=None, retries=5):
        seen.append(path.split("/")[-2])
        return {}

    monkeypatch.setattr(client, "_request", record_request)
    assert client.flush_offline() == 2
    assert seen == ["first", "second"]
    assert [
        path for path in client._offline_dir.glob("*.json")
        if not path.name.startswith(".")
    ] == []


def test_config_env_override_and_private_atomic_token(tmp_path, monkeypatch):
    path = tmp_path / "agent.yaml"
    work_dir = tmp_path / "worker-state"
    path.write_text(
        "cloud_url: http://127.0.0.1:8100\n"
        "api_key: local\n"
        f"work_dir: {work_dir.as_posix()}\n"
        "runner:\n  allowed_commands: [python]\n",
        encoding="utf-8",
    )
    original = path.read_bytes()
    monkeypatch.setenv("AWP_URL", "http://localhost:9000/")
    cfg = load(str(path))
    assert cfg["cloud_url"] == "http://localhost:9000"
    token_path = save_token("synthetic-token", cfg["work_dir"])
    assert path.read_bytes() == original
    assert token_path != path
    assert load_saved_token(cfg["work_dir"]) == "synthetic-token"
    loaded = load(str(path))
    assert loaded["agent_token"] == "synthetic-token"



def _create_file_link(link: Path, target: Path):
    try:
        os.symlink(target, link)
        return
    except (OSError, NotImplementedError):
        if os.name != "nt":
            raise
    result = subprocess.run(
        [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/d",
            "/c",
            "mklink",
            "/H",
            str(link),
            str(target),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.fail(f"could not create link fixture (exit {result.returncode})")


def _visible_json(directory: Path) -> list[Path]:
    return sorted(
        path
        for path in directory.glob("*.json")
        if not path.name.startswith(".")
    )


def test_unmarked_preexisting_work_root_is_rejected_without_mutation(tmp_path):
    root = tmp_path / "preexisting-root"
    root.mkdir()
    sentinel = root / "operator.txt"
    sentinel.write_text("keep", encoding="utf-8")
    with pytest.raises(PermissionError):
        prepare_app_root(root)
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert sorted(path.name for path in root.iterdir()) == ["operator.txt"]


def test_saved_token_rejects_link_without_touching_external_file(tmp_path):
    root = tmp_path / "worker-state"
    token_path = save_token("first-token", root)
    token_path.unlink()
    external = tmp_path / "operator-secret.txt"
    external.write_text("operator-owned", encoding="utf-8")
    _create_file_link(token_path, external)

    with pytest.raises(PermissionError):
        save_token("replacement-token", root)

    assert external.read_text(encoding="utf-8") == "operator-owned"
    assert os.path.lexists(token_path)


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
def test_saved_token_rejects_wrong_mode(tmp_path):
    root = tmp_path / "worker-state"
    token_path = save_token("first-token", root)
    token_path.chmod(0o644)
    with pytest.raises(PermissionError):
        load_saved_token(root)


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
def test_private_state_permissions_are_exact(tmp_path):
    root = tmp_path / "worker-state"
    token_path = save_token("first-token", root)
    assert root.stat().st_mode & 0o777 == 0o700
    assert token_path.parent.stat().st_mode & 0o777 == 0o700
    assert token_path.stat().st_mode & 0o777 == 0o600


def test_preplanted_task_run_is_never_adopted(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path))
    fixed_hex = "a" * 32

    class FixedUuid:
        hex = fixed_hex

    monkeypatch.setattr(agent_module.uuid, "uuid4", lambda: FixedUuid())
    planted = runner._tasks_root / f"preplanted--{fixed_hex}"
    planted.mkdir()
    sentinel = planted / "operator.txt"
    sentinel.write_text("keep", encoding="utf-8")

    with pytest.raises(RuntimeError, match="unique task run"):
        runner.run({
            "task_id": "preplanted",
            "argv": [_EXECUTABLE, "-c", "print('must not run')"],
        })

    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert "preplanted" not in runner._owned_runs


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
def test_task_run_and_marker_permissions_are_exact(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path))
    result = runner.run({
        "task_id": "private-mode",
        "argv": [_EXECUTABLE, "-c", "print('ok')"],
    })
    assert result["status"] == "success"
    run = runner._owned_runs["private-mode"]["path"]
    assert run.stat().st_mode & 0o777 == 0o700
    assert (run / _TASK_MARKER_NAME).stat().st_mode & 0o777 == 0o600


def test_restart_never_cleans_prior_process_run(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    cfg = config_dict(tmp_path, keep_workdirs=True)
    first = CommandRunner(cfg)
    result = first.run({
        "task_id": "restart-leftover",
        "argv": [_EXECUTABLE, "-c", "print('keep')"],
    })
    assert result["status"] == "success"
    leftover = first._owned_runs["restart-leftover"]["path"]

    second = CommandRunner(cfg)
    second.cleanup("restart-leftover")
    assert second.cleanup_oldest(keep=0) == 0
    assert leftover.is_dir()


def test_tampered_run_cleanup_does_not_follow_external_link(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    runner = CommandRunner(config_dict(tmp_path, keep_workdirs=False))
    result = runner.run({
        "task_id": "tampered-cleanup",
        "argv": [_EXECUTABLE, "-c", "print('done')"],
    })
    assert result["status"] == "success"
    run = runner._owned_runs["tampered-cleanup"]["path"]
    retained = run.with_name(run.name + "-retained")
    run.rename(retained)
    external = tmp_path / "outside-task-root"
    external.mkdir()
    sentinel = external / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    _create_directory_link(run, external)

    runner.cleanup("tampered-cleanup")

    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert os.path.lexists(run)
    assert retained.is_dir()


@pytest.mark.parametrize(
    "filename",
    ["worker.status.json", "worker.pid", "worker.log", "worker.log.1"],
)
def test_fixed_state_files_reject_links_without_external_mutation(
    tmp_path, filename
):
    root = prepare_app_root(tmp_path / ("state-" + filename.replace(".", "-")))
    external = tmp_path / ("external-" + filename.replace(".", "-"))
    external.write_text("operator-owned", encoding="utf-8")
    _create_file_link(root / filename, external)

    with pytest.raises(PermissionError):
        if filename == "worker.status.json":
            _write_status(str(root), "idle", time.time(), 0)
        elif filename == "worker.pid":
            with _InstanceLock(root):
                pass
        else:
            _setup_logging("INFO", str(root))

    assert external.read_text(encoding="utf-8") == "operator-owned"


def test_instance_lock_rejects_second_worker(tmp_path):
    root = prepare_app_root(tmp_path / "worker-state")
    with _InstanceLock(root):
        with pytest.raises(RuntimeError, match="another worker"):
            with _InstanceLock(root):
                pass


def test_offline_flush_is_single_delivery_under_concurrency(tmp_path, monkeypatch):
    cfg = cloud_config(tmp_path)
    first = CloudClient(cfg)
    second = CloudClient(cfg)
    task_ids = [f"task-{index:02d}" for index in range(12)]
    for task_id in task_ids:
        first._cache_offline("result", _queue_payload(task_id))
    seen = []
    seen_lock = threading.Lock()

    def record_request(method, path, payload=None, retries=5):
        with seen_lock:
            seen.append(path.split("/")[-2])
        time.sleep(0.005)
        return {}

    monkeypatch.setattr(first, "_request", record_request)
    monkeypatch.setattr(second, "_request", record_request)
    results = []
    threads = [
        threading.Thread(target=lambda client=client: results.append(client.flush_offline()))
        for client in (first, second)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive()

    assert sorted(seen) == sorted(task_ids)
    assert len(seen) == len(set(seen))
    assert sum(results) == len(task_ids)
    assert _visible_json(first._offline_dir) == []


def test_offline_404_is_rejected_without_starving_later_results(
    tmp_path, monkeypatch
):
    client = CloudClient(cloud_config(tmp_path))
    client._cache_offline("result", _queue_payload("first"))
    time.sleep(0.001)
    client._cache_offline("result", _queue_payload("second"))
    seen = []

    def request(method, path, payload=None, retries=5):
        task_id = path.split("/")[-2]
        seen.append(task_id)
        if task_id == "first":
            raise PermanentRequestError(404)
        return {}

    monkeypatch.setattr(client, "_request", request)
    assert client.flush_offline() == 1
    assert seen == ["first", "second"]
    assert _visible_json(client._offline_dir) == []
    assert len(_visible_json(client._rejected_dir)) == 1


def test_offline_transient_failure_retains_fifo_and_stops(tmp_path, monkeypatch):
    client = CloudClient(cloud_config(tmp_path))
    client._cache_offline("result", _queue_payload("first"))
    time.sleep(0.001)
    client._cache_offline("result", _queue_payload("second"))
    seen = []

    def request(method, path, payload=None, retries=5):
        seen.append(path.split("/")[-2])
        raise ConnectionError("transient fixture")

    monkeypatch.setattr(client, "_request", request)
    assert client.flush_offline() == 0
    assert seen == ["first"]
    assert len(_visible_json(client._offline_dir)) == 2
    assert _visible_json(client._rejected_dir) == []


def test_offline_malformed_record_moves_to_owned_rejected_queue(tmp_path):
    client = CloudClient(cloud_config(tmp_path))
    write_exclusive(
        client._offline_dir,
        "00000000000000000000-00000000000000000000000000000000.json",
        b"{}\n",
        max_bytes=1024,
    )
    assert client.flush_offline() == 0
    assert _visible_json(client._offline_dir) == []
    assert len(_visible_json(client._rejected_dir)) == 1


def test_offline_link_is_skipped_without_reading_or_mutating_target(tmp_path):
    client = CloudClient(cloud_config(tmp_path))
    external = tmp_path / "external-queue.json"
    external.write_text('{"operator":"owned"}\n', encoding="utf-8")
    linked = client._offline_dir / "00000000000000000000-11111111111111111111111111111111.json"
    _create_file_link(linked, external)

    assert client.flush_offline() == 0
    assert external.read_text(encoding="utf-8") == '{"operator":"owned"}\n'
    assert os.path.lexists(linked)
    assert _visible_json(client._rejected_dir) == []


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
def test_offline_wrong_mode_is_skipped_without_mutation(tmp_path):
    client = CloudClient(cloud_config(tmp_path))
    path = client._cache_offline("result", _queue_payload("wrong-mode"))
    path.chmod(0o644)
    assert client.flush_offline() == 0
    assert path.exists()
    assert _visible_json(client._rejected_dir) == []


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
def test_offline_queue_files_and_directories_are_private(tmp_path):
    client = CloudClient(cloud_config(tmp_path))
    path = client._cache_offline("result", _queue_payload("private"))
    assert client._offline_dir.stat().st_mode & 0o777 == 0o700
    assert client._rejected_dir.stat().st_mode & 0o777 == 0o700
    assert path.stat().st_mode & 0o777 == 0o600


def test_task_exception_logs_and_result_do_not_echo_raw_exception(
    tmp_path, caplog
):
    secret = _SECRET_FIXTURE

    class FailingRunner:
        def run(self, task, cancel_event=None):
            raise RuntimeError("sensitive " + secret)

        def cleanup(self, task_id):
            return None

    class RecordingCloud:
        def __init__(self):
            self.reports = []

        def report_result(self, task_id, attempt_id, result):
            self.reports.append((task_id, attempt_id, result))

    instance = object.__new__(Agent)
    instance._runner = FailingRunner()
    instance._cloud = RecordingCloud()
    instance._last_error = ""
    with caplog.at_level("WARNING"):
        instance._execute_task(
            {"task_id": "safe-task", "_awp_attempt_id": _ATTEMPT_ID}
        )

    assert secret not in caplog.text
    assert secret not in instance._last_error
    assert secret not in json.dumps(instance._cloud.reports)
    assert "RuntimeError" in instance._last_error



def test_offline_claim_collision_is_fail_closed_without_mutation(tmp_path):
    client = CloudClient(cloud_config(tmp_path))
    queued = client._cache_offline("result", _queue_payload("claim-collision"))
    queued_bytes = queued.read_bytes()
    sentinel = b"preplanted-claim\n"
    planted = write_exclusive(
        client._offline_dir,
        f".c{queued.stem}.s",
        sentinel,
        max_bytes=1024,
    )

    with pytest.raises(FileExistsError, match="claim already exists"):
        client._claim(queued)

    assert queued.read_bytes() == queued_bytes
    assert planted.read_bytes() == sentinel


def test_offline_rejected_collision_is_fail_closed_without_mutation(tmp_path):
    client = CloudClient(cloud_config(tmp_path))
    queued = client._cache_offline("result", _queue_payload("reject-collision"))
    claim, identity, original_name = client._claim(queued)
    claim_bytes = claim.read_bytes()
    sentinel = b"preplanted-rejected\n"
    planted = write_exclusive(
        client._rejected_dir,
        original_name,
        sentinel,
        max_bytes=1024,
    )

    with pytest.raises(FileExistsError, match="already exists"):
        client._reject_claim(claim, identity, original_name)

    assert claim.read_bytes() == claim_bytes
    assert planted.read_bytes() == sentinel


@pytest.mark.skipif(os.name != "nt", reason="Windows legacy MAX_PATH regression")
def test_offline_claim_and_rejected_names_fit_long_windows_path(tmp_path):
    queue_name = "0" * 20 + "-" + "0" * 32 + ".json"
    target_queue_path_length = 250
    queue_tail_length = 1 + len(str(Path("offline-queue") / queue_name))
    target_work_dir_length = target_queue_path_length - queue_tail_length
    padding = target_work_dir_length - len(str(tmp_path)) - 1
    assert 1 <= padding <= 200
    work_dir = tmp_path / ("w" * padding)
    client = CloudClient(cloud_config(tmp_path, work_dir=str(work_dir)))
    queued = client._cache_offline("result", _queue_payload("long-path"))
    queued_bytes = queued.read_bytes()

    assert len(str(queued)) == target_queue_path_length
    claim, identity, original_name = client._claim(queued)
    assert len(original_name) == 58
    assert len(claim.name) == 57
    assert len(str(claim)) < len(str(queued))

    client._recover_orphan_claims()
    restored = client._offline_dir / original_name
    restored_identity = os.lstat(restored)
    assert (restored_identity.st_dev, restored_identity.st_ino) == (
        identity.st_dev,
        identity.st_ino,
    )
    assert restored.read_bytes() == queued_bytes

    claim, identity, recovered_name = client._claim(restored)
    assert recovered_name == original_name
    client._reject_claim(claim, identity, recovered_name)
    rejected = client._rejected_dir / original_name
    assert rejected.name == original_name
    assert len(str(rejected)) <= target_queue_path_length
    assert rejected.read_bytes() == queued_bytes


def test_offline_orphan_claim_is_recovered_after_process_restart(
    tmp_path, monkeypatch
):
    client = CloudClient(cloud_config(tmp_path))
    queued = client._cache_offline("result", _queue_payload("orphan"))
    claim, _identity, _original = client._claim(queued)
    assert claim.exists()
    assert _visible_json(client._offline_dir) == []
    seen = []

    def request(method, path, payload=None, retries=5):
        seen.append(path.split("/")[-2])
        return {}

    monkeypatch.setattr(client, "_request", request)
    assert client.flush_offline() == 1
    assert seen == ["orphan"]
    assert not claim.exists()
    assert _visible_json(client._offline_dir) == []



def test_runner_rejects_unbounded_output_configuration(tmp_path, monkeypatch):
    _prepare_trusted_host(monkeypatch)
    cfg = config_dict(tmp_path)
    cfg["runner"]["max_output_bytes"] = 1048577
    with pytest.raises(ValueError, match="between 1 and 1048576"):
        CommandRunner(cfg)


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
def test_private_root_rejects_permissive_mode(tmp_path):
    root = prepare_app_root(tmp_path / "worker-state")
    root.chmod(0o755)
    with pytest.raises(PermissionError):
        prepare_app_root(root)


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode semantics")
@pytest.mark.parametrize("filename", ["worker.status.json", "worker.pid", "worker.log"])
def test_fixed_state_files_reject_permissive_mode(tmp_path, filename):
    root = prepare_app_root(tmp_path / ("mode-" + filename.replace(".", "-")))
    if filename == "worker.status.json":
        _write_status(str(root), "idle", time.time(), 0)
    elif filename == "worker.pid":
        with _InstanceLock(root):
            pass
    else:
        _setup_logging("INFO", str(root))
        root_logger = __import__("logging").getLogger()
        for handler in list(root_logger.handlers):
            handler.close()
        root_logger.handlers.clear()
    path = root / filename
    path.chmod(0o644)

    with pytest.raises(PermissionError):
        if filename == "worker.status.json":
            _write_status(str(root), "idle", time.time(), 0)
        elif filename == "worker.pid":
            with _InstanceLock(root):
                pass
        else:
            _setup_logging("INFO", str(root))
