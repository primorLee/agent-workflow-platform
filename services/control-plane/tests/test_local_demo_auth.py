from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

import local_demo_auth


@pytest.fixture
def auth_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "auth"
    root.mkdir(mode=0o700)
    root.chmod(0o700)
    monkeypatch.setattr(local_demo_auth, "_AUTH_DIR", root)
    monkeypatch.setattr(local_demo_auth, "_MARKER", root / ".awp-local-auth-v1")
    monkeypatch.setattr(local_demo_auth, "_KEY", root / "control-plane.key")
    monkeypatch.setattr(
        local_demo_auth.os,
        "geteuid",
        lambda: os.lstat(root).st_uid,
        raising=False,
    )
    monkeypatch.setenv("AWP_LOCAL_DEMO_AUTH_BOOTSTRAP", "1")
    if os.name == "nt":
        real_lstat = os.lstat

        def private_lstat(path: os.PathLike[str] | str) -> os.stat_result:
            current = real_lstat(path)
            candidate = Path(path)
            if candidate == root or root in candidate.parents:
                fields = list(current)
                fields[0] &= ~0o077
                return os.stat_result(fields)
            return current

        monkeypatch.setattr(local_demo_auth.os, "lstat", private_lstat)
        monkeypatch.setattr(local_demo_auth, "_fsync_directory", lambda _path: None)
    return root


def _write_owned_state(root: Path, payload: bytes) -> Path:
    marker = root / ".awp-local-auth-v1"
    marker.write_bytes(local_demo_auth._MARKER_BYTES)
    marker.chmod(0o600)
    key = root / "control-plane.key"
    key.write_bytes(payload)
    key.chmod(0o600)
    return key


def test_bootstrap_is_idempotent_and_creates_a_private_key_without_whitespace(
    auth_root: Path,
) -> None:
    local_demo_auth.bootstrap()
    key_path = auth_root / "control-plane.key"
    first = key_path.read_bytes()

    local_demo_auth.bootstrap()

    assert key_path.read_bytes() == first
    assert 32 <= len(first) <= 512
    assert not any(chr(byte).isspace() for byte in first)
    if os.name != "nt":
        assert stat.S_IMODE(key_path.stat().st_mode) & 0o077 == 0


@pytest.mark.parametrize(
    "payload",
    [
        b"a" * 32,
        b"b" * 32 + b"\n",
        b"c" * 32 + b"\r\n",
    ],
)
def test_bootstrap_accepts_existing_config_compatible_key_files(
    auth_root: Path,
    payload: bytes,
) -> None:
    key_path = _write_owned_state(auth_root, payload)

    local_demo_auth.bootstrap()

    assert key_path.read_bytes() == payload


@pytest.mark.parametrize(
    "payload",
    [
        b" " + b"a" * 32,
        b"a" * 16 + b" " + b"a" * 16,
        b"a" * 32 + b" ",
        b"a" * 32 + b"\n\n",
        b"a" * 32 + b"\r\n\n",
    ],
)
def test_bootstrap_rejects_extra_or_non_terminal_whitespace(
    auth_root: Path,
    payload: bytes,
) -> None:
    _write_owned_state(auth_root, payload)

    with pytest.raises(RuntimeError, match="local demo API key is invalid"):
        local_demo_auth.bootstrap()


def test_bootstrap_rejects_key_symlink(auth_root: Path, tmp_path: Path) -> None:
    marker = auth_root / ".awp-local-auth-v1"
    marker.write_bytes(local_demo_auth._MARKER_BYTES)
    marker.chmod(0o600)
    target = tmp_path / "outside-key"
    target.write_bytes(b"a" * 32)
    target.chmod(0o600)
    try:
        (auth_root / "control-plane.key").symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are unavailable")

    with pytest.raises(RuntimeError, match="not a regular file"):
        local_demo_auth.bootstrap()


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits are required")
def test_bootstrap_rejects_public_key_permissions(auth_root: Path) -> None:
    key_path = _write_owned_state(auth_root, b"a" * 32)
    key_path.chmod(0o644)

    with pytest.raises(RuntimeError, match="not private"):
        local_demo_auth.bootstrap()
