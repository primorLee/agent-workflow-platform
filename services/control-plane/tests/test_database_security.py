from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

import database


def _configure(monkeypatch, root: Path, db: Path | None = None) -> Path:
    target = db or (root / "control.db")
    monkeypatch.setattr(database, "DATA_DIR", root)
    monkeypatch.setattr(database, "DATABASE_URL", str(target))
    monkeypatch.delenv("AWP_DATA_ROOT_BOOTSTRAP", raising=False)
    return target


def test_private_storage_creates_owned_marker_and_database(monkeypatch, tmp_path):
    root = tmp_path / "private-data"
    db_path = _configure(monkeypatch, root)
    connection = database._connect()
    connection.execute("CREATE TABLE proof (id INTEGER PRIMARY KEY)")
    connection.close()

    marker = root / database._MARKER_NAME
    assert root.is_dir()
    assert marker.is_file()
    assert db_path.is_file()
    marker_text = marker.read_text(encoding="utf-8")
    assert database._MARKER_OWNER in marker_text
    assert "install_id" in marker_text
    if os.name != "nt":
        assert stat.S_IMODE(os.lstat(root).st_mode) == 0o700
        assert stat.S_IMODE(os.lstat(marker).st_mode) == 0o600
        assert stat.S_IMODE(os.lstat(db_path).st_mode) == 0o600


def test_systemd_empty_state_directory_bootstrap_is_private_and_idempotent(
    monkeypatch,
    tmp_path,
):
    root = tmp_path / "systemd-state-directory"
    root.mkdir(mode=0o750)
    if os.name != "nt":
        root.chmod(0o750)
    db_path = _configure(monkeypatch, root)
    monkeypatch.setenv("AWP_DATA_ROOT_BOOTSTRAP", "1")

    first = database._connect()
    first.execute("CREATE TABLE systemd_restart_proof (value TEXT NOT NULL)")
    first.execute("INSERT INTO systemd_restart_proof(value) VALUES ('kept')")
    first.commit()
    first.close()
    marker = root / database._MARKER_NAME
    marker_before = marker.read_bytes()

    monkeypatch.delenv("AWP_DATA_ROOT_BOOTSTRAP")
    second = database._connect()
    value = second.execute("SELECT value FROM systemd_restart_proof").fetchone()[0]
    second.close()

    assert value == "kept"
    assert marker.read_bytes() == marker_before
    assert db_path.is_file()
    if os.name != "nt":
        assert stat.S_IMODE(os.lstat(root).st_mode) == 0o700


def test_unmarked_existing_root_with_content_is_never_claimed_even_with_bootstrap(
    monkeypatch,
    tmp_path,
):
    root = tmp_path / "unknown-root"
    root.mkdir()
    sentinel = root / "belongs-to-user.txt"
    sentinel.write_text("keep", encoding="utf-8")
    _configure(monkeypatch, root)
    monkeypatch.setenv("AWP_DATA_ROOT_BOOTSTRAP", "1")

    with pytest.raises(RuntimeError):
        database._connect()
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert not (root / database._MARKER_NAME).exists()


def test_database_must_be_direct_canonical_child(monkeypatch, tmp_path):
    root = tmp_path / "data"
    outside = tmp_path / "outside.db"
    _configure(monkeypatch, root, outside)
    with pytest.raises(RuntimeError, match="direct .db child"):
        database._connect()
    assert not root.exists()
    assert not outside.exists()


def test_preplanted_database_symlink_is_rejected_without_touching_target(
    monkeypatch,
    tmp_path,
):
    root = tmp_path / "data"
    db_path = _configure(monkeypatch, root)
    connection = database._connect()
    connection.close()
    db_path.unlink()

    external = tmp_path / "external.txt"
    external.write_text("outside", encoding="utf-8")
    try:
        db_path.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are unavailable")

    with pytest.raises(RuntimeError, match="must not be a link"):
        database._connect()
    assert external.read_text(encoding="utf-8") == "outside"


def test_symlinked_data_root_is_rejected_without_claiming_target(monkeypatch, tmp_path):
    external = tmp_path / "external-root"
    external.mkdir()
    sentinel = external / "keep.txt"
    sentinel.write_text("outside", encoding="utf-8")
    root_link = tmp_path / "data-link"
    try:
        root_link.symlink_to(external, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("directory symlinks are unavailable")
    _configure(monkeypatch, root_link, root_link / "control.db")

    with pytest.raises(RuntimeError, match="link|reparse"):
        database._connect()
    assert sentinel.read_text(encoding="utf-8") == "outside"
    assert not (external / database._MARKER_NAME).exists()


def test_corrupt_marker_fails_closed_and_preserves_database(monkeypatch, tmp_path):
    root = tmp_path / "data"
    db_path = _configure(monkeypatch, root)
    connection = database._connect()
    connection.close()
    before = db_path.read_bytes()
    marker = root / database._MARKER_NAME
    marker.write_text('{"schema":1}', encoding="utf-8")
    if os.name != "nt":
        marker.chmod(0o600)

    with pytest.raises(RuntimeError, match="marker is invalid"):
        database._connect()
    assert db_path.read_bytes() == before