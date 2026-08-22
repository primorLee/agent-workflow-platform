"""Safety-contract tests for cloud/sandbox_manager.py.

All account and destructive operations are mocked. Tests may create ordinary
temporary directories under pytest's isolated tmp_path only.
"""

from contextlib import contextmanager
import json
import os
import re
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

import sandbox_manager


_FIXED_USERNAME = "awp_0123456789abcdefabcd"


def _write_valid_root_marker(root: Path) -> Path:
    marker = root / sandbox_manager._SANDBOX_ROOT_MARKER_NAME
    marker.write_bytes(sandbox_manager._SANDBOX_ROOT_MARKER_BYTES)
    return marker


@contextmanager
def _configured_root(tmp_path):
    _write_valid_root_marker(tmp_path)
    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", str(tmp_path)),
        mock.patch.object(sandbox_manager, "_validate_posix_root_security"),
    ):
        yield


@contextmanager
def _provisioning_mutation_spies():
    with (
        mock.patch.object(sandbox_manager, "_random_username") as random_name,
        mock.patch.object(sandbox_manager, "_lookup_user") as lookup,
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
        mock.patch.object(sandbox_manager.os, "mkdir") as mkdir,
        mock.patch.object(sandbox_manager.os, "chown", create=True) as chown,
        mock.patch.object(sandbox_manager.os, "chmod") as chmod,
        mock.patch.object(sandbox_manager.os, "remove") as remove,
        mock.patch.object(sandbox_manager.os, "rmdir") as rmdir,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        yield (random_name, lookup, run, mkdir, chown, chmod, remove, rmdir, rmtree)


def _assert_no_provisioning_mutation(spies):
    for operation in spies:
        operation.assert_not_called()


def test_disabled_mode_returns_project_root_without_os_mutation(tmp_path):
    project = tmp_path / "project"
    project.mkdir()

    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", ""),
        mock.patch.object(sandbox_manager, "PROJECT_ROOT", str(project)),
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
        mock.patch.object(sandbox_manager.os, "mkdir") as mkdir,
        mock.patch.object(sandbox_manager.os, "chown", create=True) as chown,
        mock.patch.object(sandbox_manager.os, "chmod") as chmod,
    ):
        assert sandbox_manager.get_or_create_sandbox_user("tenant-alpha") == (
            None,
            None,
            str(project.resolve()),
        )

    run.assert_not_called()
    mkdir.assert_not_called()
    chown.assert_not_called()
    chmod.assert_not_called()


def test_random_usernames_are_distinct_and_useradd_safe():
    names = {sandbox_manager._random_username() for _ in range(64)}

    assert len(names) == 64
    assert all(re.fullmatch(r"awp_[0-9a-f]{20}", name) for name in names)
    assert all(len(name) < 32 for name in names)


def test_random_username_fails_closed_on_invalid_generator_output():
    with mock.patch.object(
        sandbox_manager.secrets,
        "token_hex",
        return_value="not-hex-not-hex-not-hex",
    ):
        with pytest.raises(RuntimeError, match="username generation"):
            sandbox_manager._random_username()


def test_sandbox_path_is_contained_under_existing_absolute_root(tmp_path):
    with _configured_root(tmp_path):
        path = sandbox_manager._sandbox_path(_FIXED_USERNAME)

    assert path == tmp_path.resolve() / _FIXED_USERNAME
    assert path.parent == tmp_path.resolve()


@pytest.mark.parametrize(
    "username",
    [
        "awp_../outside",
        "../awp_0123456789abcdefabcd",
        "awp_0123456789abcdefabcg",
        "awp_0123456789abcdefabcde",
        "root",
    ],
)
def test_sandbox_path_rejects_untrusted_names_before_filesystem_use(
    tmp_path,
    username,
):
    with (
        _configured_root(tmp_path),
        mock.patch.object(sandbox_manager.os.path, "lexists") as lexists,
    ):
        with pytest.raises(RuntimeError, match="username"):
            sandbox_manager._sandbox_path(username)

    lexists.assert_not_called()


def test_sandbox_root_must_be_absolute():
    with mock.patch.object(sandbox_manager, "SANDBOX_ROOT", "relative/root"):
        with pytest.raises(RuntimeError, match="absolute"):
            sandbox_manager._sandbox_path(_FIXED_USERNAME)


def test_missing_root_marker_fails_before_random_or_os_mutation(tmp_path):
    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", str(tmp_path)),
        mock.patch.object(sandbox_manager, "_validate_posix_root_security"),
        _provisioning_mutation_spies() as spies,
    ):
        with pytest.raises(RuntimeError, match="marker is missing"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    _assert_no_provisioning_mutation(spies)


@pytest.mark.parametrize(
    "content",
    [
        b"{}\n",
        b'{"schema":"awp-sandbox-root","owner":"agent-workflow-platform","version":1}\n',
    ],
)
def test_wrong_root_marker_content_fails_before_random_or_os_mutation(
    tmp_path,
    content,
):
    marker = tmp_path / sandbox_manager._SANDBOX_ROOT_MARKER_NAME
    marker.write_bytes(content)

    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", str(tmp_path)),
        mock.patch.object(sandbox_manager, "_validate_posix_root_security"),
        _provisioning_mutation_spies() as spies,
    ):
        with pytest.raises(RuntimeError, match="marker content is invalid"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    _assert_no_provisioning_mutation(spies)


@pytest.mark.parametrize("symlink_target", ["root", "marker"])
def test_symlink_root_or_marker_fails_before_random_or_os_mutation(
    tmp_path,
    symlink_target,
):
    marker = _write_valid_root_marker(tmp_path)
    rejected_path = tmp_path if symlink_target == "root" else marker
    real_lstat = os.lstat

    def fake_lstat(path):
        if Path(path) == rejected_path:
            return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0)
        return real_lstat(path)

    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", str(tmp_path)),
        mock.patch.object(sandbox_manager.os, "lstat", side_effect=fake_lstat),
        _provisioning_mutation_spies() as spies,
    ):
        with pytest.raises(RuntimeError, match="non-symlink|regular file"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    _assert_no_provisioning_mutation(spies)


@pytest.mark.parametrize(
    "root_uid,marker_uid,root_permissions,marker_permissions,error",
    [
        (1000, 0, 0o755, 0o644, "owned by uid 0"),
        (0, 1000, 0o755, 0o644, "owned by uid 0"),
        (0, 0, 0o775, 0o644, "group/world writable"),
        (0, 0, 0o755, 0o666, "group/world writable"),
    ],
)
def test_insecure_posix_root_or_marker_fails_before_random_or_os_mutation(
    tmp_path,
    root_uid,
    marker_uid,
    root_permissions,
    marker_permissions,
    error,
):
    root = tmp_path.resolve()
    marker = _write_valid_root_marker(root)
    real_lstat = os.lstat
    real_validator = sandbox_manager._validate_posix_root_security

    def fake_lstat(path):
        candidate = Path(path)
        if candidate == root:
            return SimpleNamespace(
                st_mode=stat.S_IFDIR | root_permissions,
                st_uid=root_uid,
            )
        if candidate == marker:
            return SimpleNamespace(
                st_mode=stat.S_IFREG | marker_permissions,
                st_uid=marker_uid,
            )
        return real_lstat(path)

    def validate_as_posix(root_stat, marker_stat):
        with mock.patch.object(sandbox_manager.os, "name", "posix"):
            real_validator(root_stat, marker_stat)

    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", str(root)),
        mock.patch.object(sandbox_manager.os, "lstat", side_effect=fake_lstat),
        mock.patch.object(
            sandbox_manager,
            "_validate_posix_root_security",
            side_effect=validate_as_posix,
        ),
        _provisioning_mutation_spies() as spies,
    ):
        with pytest.raises(RuntimeError, match=error):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    _assert_no_provisioning_mutation(spies)


def test_posix_root_security_accepts_root_owned_nonwritable_paths():
    root_stat = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
    marker_stat = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)

    with mock.patch.object(sandbox_manager.os, "name", "posix"):
        sandbox_manager._validate_posix_root_security(root_stat, marker_stat)


def test_broad_filesystem_root_fails_before_random_or_os_mutation(tmp_path):
    broad_root = Path(tmp_path.anchor)

    with (
        mock.patch.object(sandbox_manager, "SANDBOX_ROOT", str(broad_root)),
        _provisioning_mutation_spies() as spies,
    ):
        with pytest.raises(RuntimeError, match="too broad"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    _assert_no_provisioning_mutation(spies)
    with pytest.raises(RuntimeError, match="too broad"):
        sandbox_manager._reject_broad_sandbox_root(broad_root / "shared")

def test_existing_os_user_is_never_reused_or_mutated(tmp_path):
    with (
        _configured_root(tmp_path),
        mock.patch.object(
            sandbox_manager,
            "_random_username",
            return_value=_FIXED_USERNAME,
        ),
        mock.patch.object(
            sandbox_manager,
            "_lookup_user",
            return_value=(1200, 1200),
        ),
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
        mock.patch.object(sandbox_manager.os, "mkdir") as mkdir,
        mock.patch.object(sandbox_manager.os, "chown", create=True) as chown,
        mock.patch.object(sandbox_manager.os, "chmod") as chmod,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(RuntimeError, match="already exists"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    run.assert_not_called()
    mkdir.assert_not_called()
    chown.assert_not_called()
    chmod.assert_not_called()
    rmtree.assert_not_called()


def test_existing_sandbox_directory_is_never_reused_or_deleted(tmp_path):
    existing = tmp_path / _FIXED_USERNAME
    existing.mkdir()
    marker = existing / "operator-owned"
    marker.write_text("keep", encoding="utf-8")

    with (
        _configured_root(tmp_path),
        mock.patch.object(
            sandbox_manager,
            "_random_username",
            return_value=_FIXED_USERNAME,
        ),
        mock.patch.object(sandbox_manager, "_lookup_user") as lookup,
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(RuntimeError, match="directory already exists"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    lookup.assert_not_called()
    run.assert_not_called()
    rmtree.assert_not_called()
    assert marker.read_text(encoding="utf-8") == "keep"


def test_shared_directory_configuration_fails_before_any_os_mutation(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("AWP_SHARED_READONLY_DIR", str(tmp_path / "shared"))

    with (
        _configured_root(tmp_path),
        mock.patch.object(sandbox_manager, "_random_username") as random_name,
        mock.patch.object(sandbox_manager, "_lookup_user") as lookup,
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
        mock.patch.object(sandbox_manager.os, "mkdir") as mkdir,
        mock.patch.object(sandbox_manager.os, "symlink") as symlink,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(RuntimeError, match="shared sandbox directories"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    random_name.assert_not_called()
    lookup.assert_not_called()
    run.assert_not_called()
    mkdir.assert_not_called()
    symlink.assert_not_called()
    rmtree.assert_not_called()


def test_useradd_uses_random_name_nologin_and_no_tenant_identity(tmp_path):
    home = tmp_path / _FIXED_USERNAME
    lookups = iter([(None, None), (1201, 1301)])

    with (
        _configured_root(tmp_path),
        mock.patch.object(
            sandbox_manager,
            "_lookup_user",
            side_effect=lambda _name: next(lookups),
        ),
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
    ):
        assert sandbox_manager._create_user(_FIXED_USERNAME, str(home)) == (
            1201,
            1301,
        )

    run.assert_called_once()
    command = run.call_args.args[0]
    assert command[0] == "useradd"
    assert command[-1] == _FIXED_USERNAME
    assert command[command.index("-s") + 1] == "/usr/sbin/nologin"
    assert command[command.index("-d") + 1] == str(home.resolve())
    assert "-M" in command
    assert "tenant-alpha" not in " ".join(command)
    assert run.call_args.kwargs == {
        "check": True,
        "capture_output": True,
        "timeout": 10,
    }


def test_useradd_existing_user_race_is_fail_closed(tmp_path):
    home = tmp_path / _FIXED_USERNAME
    collision = subprocess.CalledProcessError(
        returncode=9,
        cmd=["useradd"],
        stderr=b"account already exists",
    )

    with (
        _configured_root(tmp_path),
        mock.patch.object(
            sandbox_manager,
            "_lookup_user",
            return_value=(None, None),
        ) as lookup,
        mock.patch.object(
            sandbox_manager.subprocess,
            "run",
            side_effect=collision,
        ) as run,
        mock.patch.object(sandbox_manager.os, "mkdir") as mkdir,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(RuntimeError, match="cannot create"):
            sandbox_manager._create_user(_FIXED_USERNAME, str(home))

    lookup.assert_called_once_with(_FIXED_USERNAME)
    run.assert_called_once()
    mkdir.assert_not_called()
    rmtree.assert_not_called()


def test_user_home_outside_root_is_rejected_before_lookup_or_useradd(tmp_path):
    outside = tmp_path.parent / _FIXED_USERNAME

    with (
        _configured_root(tmp_path),
        mock.patch.object(sandbox_manager, "_lookup_user") as lookup,
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
    ):
        with pytest.raises(RuntimeError, match="contained path"):
            sandbox_manager._create_user(_FIXED_USERNAME, str(outside))

    lookup.assert_not_called()
    run.assert_not_called()


def test_create_sandbox_builds_only_fresh_private_tree(tmp_path):
    sandbox = tmp_path / _FIXED_USERNAME

    with (
        _configured_root(tmp_path),
        mock.patch.object(sandbox_manager, "_secure_new_path") as secure,
        mock.patch.object(sandbox_manager.os, "fchown", create=True) as fchown,
    ):
        sandbox_manager._create_sandbox(
            _FIXED_USERNAME,
            1201,
            1301,
            str(sandbox),
        )

    assert sandbox.is_dir()
    assert {child.name for child in sandbox.iterdir()} == set(
        sandbox_manager._SANDBOX_DIR_NAMES
    )
    assert all((sandbox / name).is_dir() for name in sandbox_manager._SANDBOX_DIR_NAMES)
    settings = json.loads(
        (sandbox / ".agent" / "settings.json").read_text(encoding="utf-8")
    )
    assert settings == sandbox_manager.generate_cloud_settings()

    secured = {Path(call.args[0]): call.args[3] for call in secure.call_args_list}
    settings_path = sandbox / ".agent" / "settings.json"
    assert secured[sandbox] == 0o700
    assert settings_path not in secured
    assert len(secured) == len(sandbox_manager._SANDBOX_DIR_NAMES) + 1
    fchown.assert_called_once()
    assert fchown.call_args.args[1:] == (1201, 1301)


def test_settings_file_is_created_exclusively_with_mode_0600(tmp_path):
    settings_path = tmp_path / "settings.json"
    real_open = os.open

    with (
        mock.patch.object(sandbox_manager.os, "open", wraps=real_open) as open_file,
        mock.patch.object(sandbox_manager.os, "fchown", create=True) as fchown,
        mock.patch.object(sandbox_manager.os, "chmod") as chmod,
    ):
        sandbox_manager._write_settings_exclusive(settings_path, 1201, 1301)

    open_file.assert_called_once()
    flags = open_file.call_args.args[1]
    mode = open_file.call_args.args[2]
    assert flags & os.O_WRONLY
    assert flags & os.O_CREAT
    assert flags & os.O_EXCL
    assert mode == 0o600
    fchown.assert_called_once()
    chmod.assert_not_called()
    assert json.loads(settings_path.read_text(encoding="utf-8")) == (
        sandbox_manager.generate_cloud_settings()
    )
    if os.name == "posix":
        assert stat.S_IMODE(settings_path.stat().st_mode) == 0o600


def test_settings_write_failure_leaves_only_a_0600_evidence_file(tmp_path):
    settings_path = tmp_path / "settings.json"
    real_open = os.open

    with (
        mock.patch.object(sandbox_manager.os, "open", wraps=real_open) as open_file,
        mock.patch.object(sandbox_manager.os, "fchown", create=True),
        mock.patch.object(
            sandbox_manager.json,
            "dump",
            side_effect=RuntimeError("synthetic serialization failure"),
        ),
        mock.patch.object(sandbox_manager.os, "chmod") as chmod,
        mock.patch.object(sandbox_manager.os, "remove") as remove,
        mock.patch.object(sandbox_manager.os, "rmdir") as rmdir,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(RuntimeError, match="synthetic serialization failure"):
            sandbox_manager._write_settings_exclusive(settings_path, 1201, 1301)

    assert settings_path.is_file()
    assert open_file.call_args.args[2] == 0o600
    if os.name == "posix":
        assert stat.S_IMODE(settings_path.stat().st_mode) == 0o600
    chmod.assert_not_called()
    remove.assert_not_called()
    rmdir.assert_not_called()
    rmtree.assert_not_called()


def test_settings_file_is_never_reused_or_overwritten(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text("operator-owned", encoding="utf-8")

    with mock.patch.object(sandbox_manager.os, "fchown", create=True) as fchown:
        with pytest.raises(FileExistsError):
            sandbox_manager._write_settings_exclusive(settings_path, 1201, 1301)

    fchown.assert_not_called()
    assert settings_path.read_text(encoding="utf-8") == "operator-owned"

def test_create_sandbox_rejects_outside_path_without_mkdir(tmp_path):
    outside = tmp_path.parent / _FIXED_USERNAME

    with (
        _configured_root(tmp_path),
        mock.patch.object(sandbox_manager.os, "mkdir") as mkdir,
    ):
        with pytest.raises(RuntimeError, match="inside"):
            sandbox_manager._create_sandbox(
                _FIXED_USERNAME,
                1201,
                1301,
                str(outside),
            )

    mkdir.assert_not_called()


def test_partial_directory_failure_leaves_evidence_and_never_deletes(tmp_path):
    sandbox = tmp_path / _FIXED_USERNAME
    security_calls = 0

    def fail_after_root(_path, _uid, _gid, _mode):
        nonlocal security_calls
        security_calls += 1
        if security_calls == 2:
            raise PermissionError("synthetic ownership failure")

    with (
        _configured_root(tmp_path),
        mock.patch.object(
            sandbox_manager,
            "_secure_new_path",
            side_effect=fail_after_root,
        ),
        mock.patch.object(sandbox_manager.os, "remove") as remove,
        mock.patch.object(sandbox_manager.os, "rmdir") as rmdir,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(PermissionError, match="synthetic"):
            sandbox_manager._create_sandbox(
                _FIXED_USERNAME,
                1201,
                1301,
                str(sandbox),
            )

    assert sandbox.is_dir()
    assert (sandbox / ".agent").is_dir()
    remove.assert_not_called()
    rmdir.assert_not_called()
    rmtree.assert_not_called()


def test_provisioning_failure_never_rolls_back_user_or_directory(tmp_path):
    lookups = iter([(None, None), (1201, 1301)])
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return mock.Mock(returncode=0)

    with (
        _configured_root(tmp_path),
        mock.patch.object(
            sandbox_manager,
            "_random_username",
            return_value=_FIXED_USERNAME,
        ),
        mock.patch.object(
            sandbox_manager,
            "_lookup_user",
            side_effect=lambda _name: next(lookups),
        ),
        mock.patch.object(
            sandbox_manager.subprocess,
            "run",
            side_effect=fake_run,
        ),
        mock.patch.object(
            sandbox_manager,
            "_create_sandbox",
            side_effect=PermissionError("synthetic create failure"),
        ),
        mock.patch.object(sandbox_manager.os, "remove") as remove,
        mock.patch.object(sandbox_manager.os, "rmdir") as rmdir,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        with pytest.raises(PermissionError, match="synthetic"):
            sandbox_manager.get_or_create_sandbox_user("tenant-alpha")

    assert [command[0] for command in commands] == ["useradd"]
    assert all(command[0] not in {"userdel", "mount", "umount"} for command in commands)
    remove.assert_not_called()
    rmdir.assert_not_called()
    rmtree.assert_not_called()


@pytest.mark.parametrize(
    "entrypoint",
    [
        sandbox_manager.cleanup_stale_sandboxes,
        sandbox_manager.cleanup_stale_sandboxes_periodic,
    ],
)
def test_cleanup_entrypoints_explicitly_disabled_and_non_destructive(
    entrypoint,
):
    with (
        mock.patch.object(sandbox_manager.os, "scandir") as scandir,
        mock.patch.object(sandbox_manager.os, "remove") as remove,
        mock.patch.object(sandbox_manager.os, "rmdir") as rmdir,
        mock.patch.object(sandbox_manager.subprocess, "run") as run,
        mock.patch("shutil.rmtree") as rmtree,
    ):
        result = entrypoint()

    assert result["ok"] is True
    assert result["status"] == "disabled"
    assert result["enabled"] is False
    assert result["removed"] == 0
    assert "manual" in result["reason"]
    scandir.assert_not_called()
    remove.assert_not_called()
    rmdir.assert_not_called()
    run.assert_not_called()
    rmtree.assert_not_called()


def test_detect_project_root_prefers_explicit_directory(tmp_path):
    explicit = tmp_path / "configured-workspace"
    explicit.mkdir()
    with mock.patch.object(sandbox_manager, "PROJECT_ROOT", str(explicit)):
        assert sandbox_manager._detect_project_root() == str(explicit.resolve())


def test_detect_project_root_rejects_invalid_explicit_directory(tmp_path):
    missing = tmp_path / "missing-workspace"
    with mock.patch.object(sandbox_manager, "PROJECT_ROOT", str(missing)):
        with pytest.raises(RuntimeError, match="AWP_PROJECT_DIR"):
            sandbox_manager._detect_project_root()


def test_detect_project_root_prefers_agent_workflow_marker(tmp_path):
    workspace = tmp_path / "workspace"
    module_dir = workspace / "services" / "control-plane" / "cloud"
    module_dir.mkdir(parents=True)
    (workspace / ".agent-workflow").mkdir()

    module_file = module_dir / "sandbox_manager.py"
    with (
        mock.patch.object(sandbox_manager, "PROJECT_ROOT", ""),
        mock.patch.object(sandbox_manager, "__file__", str(module_file)),
    ):
        assert sandbox_manager._detect_project_root() == str(workspace.resolve())


def test_detect_project_root_uses_generic_source_tree_fallback(tmp_path):
    workspace = tmp_path / "workspace"
    module_dir = workspace / "services" / "control-plane" / "cloud"
    module_dir.mkdir(parents=True)
    (workspace / "workflows").mkdir()

    module_file = module_dir / "sandbox_manager.py"
    with (
        mock.patch.object(sandbox_manager, "PROJECT_ROOT", ""),
        mock.patch.object(sandbox_manager, "__file__", str(module_file)),
    ):
        assert sandbox_manager._detect_project_root() == str(workspace.resolve())
