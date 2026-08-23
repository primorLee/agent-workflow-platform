from __future__ import annotations

import importlib.util
import io
import os
import sys
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "scripts" / "submit_local_task.py"
SPEC = importlib.util.spec_from_file_location("submit_local_task", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
helper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = helper
SPEC.loader.exec_module(helper)

LAUNCHER_PATH = ROOT / "scripts" / "launch_local_agent_desktop.py"
LAUNCHER_SPEC = importlib.util.spec_from_file_location(
    "launch_local_agent_desktop", LAUNCHER_PATH,
)
assert LAUNCHER_SPEC is not None and LAUNCHER_SPEC.loader is not None
launcher = importlib.util.module_from_spec(LAUNCHER_SPEC)
sys.modules[LAUNCHER_SPEC.name] = launcher
LAUNCHER_SPEC.loader.exec_module(launcher)


class FakeResponse:
    def __init__(
        self,
        payload: bytes,
        *,
        url: str = "http://127.0.0.1:8100/v1/tasks",
        content_type: str = "application/json",
        length: str | None = None,
    ) -> None:
        self._payload = payload
        self._url = url
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        if length is not None:
            self.headers["Content-Length"] = length

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self):
        return self._url

    def read(self, limit: int):
        return self._payload[:limit]


class FakeOpener:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return self.response


def test_private_opener_disables_environment_proxies_and_redirects(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "getproxies",
        lambda: {"http": "http://attacker.example.invalid:8080"},
    )
    opener = helper.private_opener()
    # Passing an explicit empty ProxyHandler suppresses build_opener's
    # environment-derived default; urllib omits that inert handler afterward.
    assert not any(
        isinstance(handler, urllib.request.ProxyHandler)
        for handler in opener.handlers
    )
    redirect = next(
        handler for handler in opener.handlers
        if isinstance(handler, helper.RejectRedirects)
    )
    request = urllib.request.Request("http://127.0.0.1:8100/v1/tasks")
    with pytest.raises(urllib.error.HTTPError):
        redirect.redirect_request(
            request,
            io.BytesIO(),
            302,
            "moved",
            Message(),
            "http://attacker.example.invalid/collect",
        )


def test_request_json_pins_origin_content_type_and_size():
    key = "x" * 32
    valid = FakeOpener(FakeResponse(b'{"id":"value"}', length="14"))
    assert helper.request_json(
        "GET",
        "http://127.0.0.1:8100",
        "/v1/tasks",
        key,
        opener=valid,
    ) == {"id": "value"}
    request, timeout = valid.requests[0]
    assert timeout == 5
    assert request.get_header("Authorization") == f"Bearer {key}"

    changed_origin = FakeOpener(
        FakeResponse(b"{}", url="http://attacker.example.invalid/v1/tasks"),
    )
    with pytest.raises(RuntimeError, match="origin"):
        helper.request_json(
            "GET", "http://127.0.0.1:8100", "/v1/tasks", key,
            opener=changed_origin,
        )

    wrong_type = FakeOpener(FakeResponse(b"{}", content_type="text/html"))
    with pytest.raises(ValueError, match="not JSON"):
        helper.request_json(
            "GET", "http://127.0.0.1:8100", "/v1/tasks", key,
            opener=wrong_type,
        )

    oversized = FakeOpener(
        FakeResponse(b"{}", length=str(helper.MAX_RESPONSE_BYTES + 1)),
    )
    with pytest.raises(ValueError, match="too large"):
        helper.request_json(
            "GET", "http://127.0.0.1:8100", "/v1/tasks", key,
            opener=oversized,
        )


def test_local_origin_and_key_validation_are_fail_closed():
    for raw in (
        "http://127.0.0.1:8100" + "@attacker.example.invalid",
        "http://127.0.0.1:8100?next=evil",
        "http://localhost:8101",
        " http://127.0.0.1:8100",
    ):
        with pytest.raises(ValueError):
            helper.canonical_local_base(raw)

    for key in ("short", "x" * 16 + "\n", " " + "x" * 32):
        with pytest.raises(ValueError):
            helper.validate_api_key(key)


def test_key_source_is_environment_or_captured_compose_only(monkeypatch):
    key = "e" * 32
    monkeypatch.setenv("AWP_DEV_API_KEY", key)
    monkeypatch.setattr(
        helper,
        "discover_compose_key",
        lambda: (_ for _ in ()).throw(AssertionError("must not run")),
    )
    assert helper.load_api_key() == key

    monkeypatch.delenv("AWP_DEV_API_KEY", raising=False)
    monkeypatch.setattr(helper, "discover_compose_key", lambda: "c" * 32)
    assert helper.load_api_key() == "c" * 32


def test_compose_key_discovery_imports_packaged_config(monkeypatch):
    captured = {}

    class Result:
        returncode = 0
        stdout = "k" * 32 + "\n"

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return Result()

    monkeypatch.setattr(helper.subprocess, "run", fake_run)
    assert helper.discover_compose_key() == "k" * 32
    assert captured["command"][-2:] == [
        "-c",
        "from cloud.config import DEV_API_KEY; print(DEV_API_KEY)",
    ]
    assert captured["kwargs"] == {
        "cwd": helper.ROOT,
        "capture_output": True,
        "text": True,
        "timeout": 10,
        "check": False,
    }


def test_cli_has_no_api_key_option_and_timeout_is_bounded():
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert '"--api-key"' not in source
    assert "urlopen(" not in source
    parser = helper.build_parser()
    assert parser.parse_args(["--timeout", "60"]).timeout == 60
    for invalid in ("nan", "0", "3601"):
        with pytest.raises(SystemExit):
            parser.parse_args(["--timeout", invalid])


def test_desktop_bridge_launcher_passes_captured_key_only_in_child_environment(monkeypatch):
    key = "q" * 32
    captured = {}

    class Result:
        returncode = 0

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return Result()

    monkeypatch.setattr(launcher, "load_api_key", lambda: key)
    monkeypatch.setattr(launcher.shutil, "which", lambda name: "/tools/npm" if name == "npm" else None)
    monkeypatch.setattr(launcher.subprocess, "run", fake_run)

    assert launcher.main(["--model", "fixture-model"]) == 0
    assert key not in " ".join(captured["command"])
    environment = captured["kwargs"]["env"]
    assert environment["AWP_AGENT_MANAGED_TASKS_OPT_IN"] == "1"
    assert environment["AWP_CONTROL_PLANE_URL"] == "http://127.0.0.1:8100"
    assert environment["AWP_CONTROL_PLANE_API_KEY"] == key
    assert captured["kwargs"]["check"] is False


def test_desktop_bridge_launcher_has_no_key_cli_and_rejects_bad_models():
    source = LAUNCHER_PATH.read_text(encoding="utf-8")
    assert '"--api-key"' not in source
    with pytest.raises(launcher.argparse.ArgumentTypeError):
        launcher.valid_model("\n")
