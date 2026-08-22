"""Conservative OS-user workspace provisioning for the control plane.

Provisioning is disabled unless AWP_SANDBOX_ROOT is set. When enabled, each
call creates a fresh, randomly named nologin account and a fresh directory
under an operator-created root. Existing accounts and paths are never reused.

This module deliberately has no automatic teardown path. A partial failure is
left in place for an operator to inspect; guessing which account or directory
is safe to delete is more dangerous than leaving an orphaned resource.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import stat
import subprocess
from pathlib import Path

from config import SANDBOX_ROOT as SANDBOX_ROOT

_log = logging.getLogger(__name__)

PROJECT_ROOT = os.getenv("AWP_PROJECT_DIR", "")
AGENT_GROUP = "awp-runners"
NOLOGIN_SHELL = "/usr/sbin/nologin"

_USERNAME_RANDOM_BYTES = 10
_USERNAME_RE = re.compile(r"awp_[0-9a-f]{20}\Z")
_SANDBOX_DIR_NAMES = (".agent", "workspace", "data", "artifacts", "tmp")
_SANDBOX_ROOT_MARKER_NAME = ".awp-sandbox-root.json"
_SANDBOX_ROOT_MARKER_BYTES = (
    b'{"owner":"agent-workflow-platform","schema":"awp-sandbox-root","version":1}\n'
)
_CLEANUP_DISABLED_REASON = (
    "automatic sandbox cleanup is disabled; inspect and remove resources manually"
)


def _is_enabled() -> bool:
    """Return whether optional OS-user provisioning is configured."""
    return bool(SANDBOX_ROOT.strip())


def _detect_project_root() -> str:
    """Resolve the generic Agent workspace root for local, disabled mode."""
    configured = PROJECT_ROOT.strip()
    if configured:
        try:
            resolved = Path(configured).expanduser().resolve(strict=True)
        except OSError as exc:
            raise RuntimeError(
                "AWP_PROJECT_DIR must name an existing directory"
            ) from exc
        if not resolved.is_dir():
            raise RuntimeError("AWP_PROJECT_DIR must name an existing directory")
        return str(resolved)

    module_dir = Path(__file__).resolve().parent
    candidates = (module_dir, *module_dir.parents)

    for candidate in candidates:
        if (candidate / ".agent-workflow").exists():
            return str(candidate)

    for candidate in candidates:
        if (candidate / "workflows").is_dir() and (candidate / "services").is_dir():
            return str(candidate)

    return str(module_dir.parent)


def _random_username() -> str:
    """Return one cryptographically random, useradd-safe account name."""
    username = f"awp_{secrets.token_hex(_USERNAME_RANDOM_BYTES)}"
    if _USERNAME_RE.fullmatch(username) is None:
        raise RuntimeError("secure username generation returned an invalid value")
    return username


def _reject_broad_sandbox_root(root: Path) -> None:
    """Reject filesystem roots, home directories, and shallow shared roots."""
    anchor = Path(root.anchor)
    try:
        relative_parts = root.relative_to(anchor).parts
    except ValueError as exc:
        raise RuntimeError("AWP_SANDBOX_ROOT has an invalid filesystem anchor") from exc
    if len(relative_parts) < 2:
        raise RuntimeError("AWP_SANDBOX_ROOT is too broad for sandbox provisioning")

    try:
        home = Path.home().resolve(strict=True)
    except OSError:
        home = None
    if home is not None and root == home:
        raise RuntimeError("AWP_SANDBOX_ROOT must not be an operator home directory")


def _validate_posix_root_security(
    root_stat: os.stat_result,
    marker_stat: os.stat_result,
) -> None:
    """Require root-owned, non-writable provisioning anchors on POSIX."""
    if os.name != "posix":
        return
    if root_stat.st_uid != 0 or marker_stat.st_uid != 0:
        raise RuntimeError("AWP_SANDBOX_ROOT and its marker must be owned by uid 0")
    if root_stat.st_mode & 0o022 or marker_stat.st_mode & 0o022:
        raise RuntimeError(
            "AWP_SANDBOX_ROOT and its marker must not be group/world writable"
        )


def _read_root_marker(marker: Path) -> bytes:
    """Read the fixed marker without following a symlink on POSIX."""
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    try:
        descriptor = os.open(marker, flags)
    except OSError as exc:
        raise RuntimeError("AWP_SANDBOX_ROOT marker is not safely readable") from exc
    try:
        opened_stat = os.fstat(descriptor)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise RuntimeError("AWP_SANDBOX_ROOT marker must be a regular file")
        return os.read(descriptor, len(_SANDBOX_ROOT_MARKER_BYTES) + 1)
    finally:
        os.close(descriptor)


def _resolve_sandbox_root() -> Path:
    """Return a dedicated, operator-marked, non-symlink sandbox root."""
    configured = SANDBOX_ROOT.strip()
    if not configured:
        raise RuntimeError("AWP_SANDBOX_ROOT is not configured")

    raw_root = Path(configured).expanduser()
    if not raw_root.is_absolute():
        raise RuntimeError("AWP_SANDBOX_ROOT must be an absolute path")

    try:
        raw_stat = os.lstat(raw_root)
    except OSError as exc:
        raise RuntimeError("AWP_SANDBOX_ROOT must name an existing directory") from exc
    if stat.S_ISLNK(raw_stat.st_mode) or not stat.S_ISDIR(raw_stat.st_mode):
        raise RuntimeError("AWP_SANDBOX_ROOT must be a real non-symlink directory")

    try:
        root = raw_root.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError("AWP_SANDBOX_ROOT must name an existing directory") from exc
    if root != raw_root.absolute():
        raise RuntimeError("AWP_SANDBOX_ROOT must not traverse symlink components")
    if not root.is_dir():
        raise RuntimeError("AWP_SANDBOX_ROOT must name an existing directory")

    _reject_broad_sandbox_root(root)
    marker = root / _SANDBOX_ROOT_MARKER_NAME
    try:
        marker_stat = os.lstat(marker)
    except OSError as exc:
        raise RuntimeError("AWP_SANDBOX_ROOT marker is missing") from exc
    if stat.S_ISLNK(marker_stat.st_mode) or not stat.S_ISREG(marker_stat.st_mode):
        raise RuntimeError("AWP_SANDBOX_ROOT marker must be a real regular file")

    _validate_posix_root_security(raw_stat, marker_stat)
    if _read_root_marker(marker) != _SANDBOX_ROOT_MARKER_BYTES:
        raise RuntimeError("AWP_SANDBOX_ROOT marker content is invalid")
    return root


def _sandbox_path(username: str) -> Path:
    """Build a contained sandbox path from a validated generated username."""
    if _USERNAME_RE.fullmatch(username) is None:
        raise RuntimeError("invalid generated sandbox username")

    root = _resolve_sandbox_root()
    candidate = root / username
    if candidate.parent != root:
        raise RuntimeError("sandbox path escapes AWP_SANDBOX_ROOT")
    return candidate


def _reject_shared_directory_configuration() -> None:
    """Fail closed when the removed shared-directory feature is requested."""
    if os.getenv("AWP_SHARED_READONLY_DIR", "").strip():
        raise RuntimeError("shared sandbox directories are disabled")


def get_or_create_sandbox_user(tenant_id: str) -> tuple:
    """Create a fresh OS user and private workspace.

    The function name is retained for API compatibility, but enabled mode never
    gets or reuses an existing account. It returns (uid, gid, path).
    With provisioning disabled it performs no OS mutation and returns
    (None, None, project_dir).
    """
    if not _is_enabled():
        return None, None, _detect_project_root()
    if not isinstance(tenant_id, str) or not tenant_id:
        raise RuntimeError("tenant_id must be a non-empty string")

    _reject_shared_directory_configuration()
    root = _resolve_sandbox_root()
    username = _random_username()
    sandbox_path = root / username
    if sandbox_path.parent != root:
        raise RuntimeError("sandbox path escapes AWP_SANDBOX_ROOT")

    # A leaf that already exists could belong to another process or operator.
    # Refuse it before invoking useradd; never attempt to adopt or clean it up.
    if os.path.lexists(sandbox_path):
        raise RuntimeError("generated sandbox directory already exists; refusing reuse")

    uid, gid = _create_user(username, str(sandbox_path))
    try:
        _create_sandbox(username, uid, gid, str(sandbox_path))
    except Exception:
        _log.exception(
            "Sandbox directory provisioning failed for %s; account and partial "
            "directory are intentionally left in place",
            username,
        )
        raise

    return uid, gid, str(sandbox_path)


def _lookup_user(username: str) -> tuple[int | None, int | None]:
    """Look up an OS user, returning (None, None) when it is absent."""
    try:
        import pwd

        record = pwd.getpwnam(username)
        return record.pw_uid, record.pw_gid
    except (KeyError, ImportError):
        return None, None


def _create_user(username: str, home_dir: str) -> tuple[int, int]:
    """Create one previously absent nologin account.

    Any pre-existing lookup or useradd failure, including an already-exists
    race, is a hard error. No ownership inference or compatibility fallback is
    attempted.
    """
    expected_home = _sandbox_path(username)
    if Path(home_dir) != expected_home:
        raise RuntimeError("sandbox home must be the generated contained path")

    uid, gid = _lookup_user(username)
    if uid is not None or gid is not None:
        raise RuntimeError("generated OS user already exists; refusing reuse")

    command = [
        "useradd",
        "-r",
        "-g",
        AGENT_GROUP,
        "-s",
        NOLOGIN_SHELL,
        "-d",
        str(expected_home),
        "-M",
        "-c",
        "Agent Workflow Platform sandbox",
        username,
    ]
    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            timeout=10,
        )
    except subprocess.CalledProcessError as exc:
        _log.error("useradd failed for %s (exit=%s)", username, exc.returncode)
        raise RuntimeError("cannot create sandbox OS user") from exc
    except (OSError, subprocess.TimeoutExpired) as exc:
        _log.error("useradd could not complete for %s", username)
        raise RuntimeError("cannot create sandbox OS user") from exc

    uid, gid = _lookup_user(username)
    if uid is None or gid is None:
        raise RuntimeError("sandbox OS user was created but cannot be verified")
    return uid, gid


def _secure_new_path(path: Path, uid: int, gid: int, mode: int) -> None:
    """Apply ownership and mode to one freshly created, non-symlink path."""
    current = os.lstat(path)
    if stat.S_ISLNK(current.st_mode):
        raise RuntimeError("refusing to secure a symlink in the sandbox")
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def _create_sandbox(
    username: str,
    uid: int,
    gid: int,
    sandbox_path: str,
) -> None:
    """Create a brand-new credential-free directory tree.

    Every path is created exclusively. On any failure, created paths remain in
    place; this function never guesses that rollback deletion is safe.
    """
    if not isinstance(uid, int) or uid < 0 or not isinstance(gid, int) or gid < 0:
        raise RuntimeError("sandbox uid and gid must be non-negative integers")

    expected = _sandbox_path(username)
    requested = Path(sandbox_path)
    if requested != expected:
        raise RuntimeError("sandbox path must remain inside AWP_SANDBOX_ROOT")
    if os.path.lexists(requested):
        raise RuntimeError("sandbox directory already exists; refusing reuse")

    os.mkdir(requested, 0o700)
    _secure_new_path(requested, uid, gid, 0o700)

    for dirname in _SANDBOX_DIR_NAMES:
        child = requested / dirname
        os.mkdir(child, 0o700)
        _secure_new_path(child, uid, gid, 0o700)

    settings_path = requested / ".agent" / "settings.json"
    _write_settings_exclusive(settings_path, uid, gid)
    _log.info("Created fresh sandbox %s", username)


def _write_settings_exclusive(settings_path: Path, uid: int, gid: int) -> None:
    """Create settings atomically with mode 0600 from the first filesystem instant."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    descriptor = os.open(settings_path, flags, 0o600)
    try:
        opened_stat = os.fstat(descriptor)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise RuntimeError("sandbox settings path is not a regular file")
        os.fchown(descriptor, uid, gid)
        with os.fdopen(
            descriptor,
            "w",
            encoding="utf-8",
            newline="\n",
        ) as handle:
            descriptor = -1
            json.dump(generate_cloud_settings(), handle, indent=2)
            handle.write("\n")
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def generate_cloud_settings() -> dict:
    """Return portable task defaults for a newly created workspace.

    The deny list is a convenience guardrail, not the isolation boundary. OS
    account separation and directory permissions remain mandatory.
    """
    return {
        "permissions": {
            "allow": [
                "Read",
                "Write",
                "Edit",
                "Grep",
                "Glob",
                "Bash",
                "Agent",
            ],
            "deny": [
                "WebFetch",
                "WebSearch",
                "Bash(sudo *)",
                "Bash(su *)",
                "Bash(apt *)",
                "Bash(pip install *)",
                "Bash(systemctl *)",
                "Bash(kill -9 *)",
                "Bash(pkill *)",
                "Bash(chmod *)",
                "Bash(chown *)",
                "Bash(docker *)",
                "Bash(mount *)",
                "Bash(umount *)",
                "Bash(dd *)",
                "Bash(mkfs *)",
                "Bash(iptables *)",
                "Bash(reboot)",
                "Bash(shutdown *)",
                "Bash(useradd *)",
                "Bash(userdel *)",
                "Bash(passwd *)",
                "Bash(rm -rf /)",
            ],
        },
        "enableAllProjectMcpServers": False,
    }


def _cleanup_disabled_result() -> dict:
    return {
        "ok": True,
        "status": "disabled",
        "enabled": False,
        "removed": 0,
        "reason": _CLEANUP_DISABLED_REASON,
    }


def cleanup_stale_sandboxes() -> dict:
    """Return an explicit disabled result without inspecting or deleting paths."""
    return _cleanup_disabled_result()


def cleanup_stale_sandboxes_periodic() -> dict:
    """Scheduler-compatible no-op; automatic sandbox deletion is disabled."""
    return _cleanup_disabled_result()
