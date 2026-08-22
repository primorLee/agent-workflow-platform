"""YAML, environment, and private token configuration for the worker."""
from __future__ import annotations

import copy
import logging
import os
from pathlib import Path

import yaml

from storage import (
    atomic_write,
    ensure_owned_subdir,
    existing_app_root,
    prepare_app_root,
    read_bytes,
)

logger = logging.getLogger("awp.worker.config")
_STATE_DIR_NAME = "state"
_STATE_MARKER_NAME = ".awp-worker-state.json"
_STATE_MARKER = {"schema": "awp-worker-state/v1"}
_TOKEN_FILE_NAME = "agent.token"
_TOKEN_MAX_BYTES = 8192
_DEFAULTS = {
    "cloud_url": "http://127.0.0.1:8100",
    "api_key": "",
    "agent_token": None,
    "work_dir": "./var/worker-agent",
    "poll_interval": 2,
    "max_concurrent": 2,
    "log_level": "INFO",
    "runner": {
        "allowed_commands": ["python", "python3", "node", "bash", "sh"],
        "allowed_env_keys": [],
        "timeout_seconds": 3600,
        "max_output_bytes": 1048576,
        "keep_workdirs": False,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _validate_token(token: str) -> bytes:
    if (
        not isinstance(token, str)
        or not token
        or len(token.encode("utf-8")) > _TOKEN_MAX_BYTES
        or any(ord(char) < 0x21 or ord(char) > 0x7E for char in token)
    ):
        raise ValueError("agent token must be non-empty printable ASCII without whitespace")
    return (token + "\n").encode("ascii")


def _state_directory(work_dir: str | Path, *, create: bool) -> Path | None:
    root = prepare_app_root(work_dir) if create else existing_app_root(work_dir)
    if root is None:
        return None
    state = root / _STATE_DIR_NAME
    if not create and not os.path.lexists(state):
        return None
    return ensure_owned_subdir(
        root,
        _STATE_DIR_NAME,
        _STATE_MARKER_NAME,
        _STATE_MARKER,
    )


def load_saved_token(work_dir: str | Path) -> str | None:
    state = _state_directory(work_dir, create=False)
    if state is None:
        return None
    path = state / _TOKEN_FILE_NAME
    if not os.path.lexists(path):
        return None
    raw = read_bytes(path, max_bytes=_TOKEN_MAX_BYTES + 1)
    try:
        token = raw.decode("ascii").rstrip("\n")
    except UnicodeDecodeError:
        raise PermissionError("saved agent token is not valid ASCII") from None
    _validate_token(token)
    if raw != (token + "\n").encode("ascii"):
        raise PermissionError("saved agent token has invalid framing")
    return token


def load(path: str | None = None) -> dict:
    if path is None:
        path = str(Path(__file__).with_name("agent.yaml"))
    if not os.path.isfile(path):
        logger.error("Config file not found")
        raise SystemExit(1)
    with open(path, "r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    cfg = _deep_merge(copy.deepcopy(_DEFAULTS), raw)
    cfg["cloud_url"] = os.getenv("AWP_URL", cfg["cloud_url"]).rstrip("/")
    cfg["api_key"] = os.getenv("AWP_API_KEY", cfg.get("api_key", ""))
    cfg["agent_token"] = os.getenv("AWP_AGENT_TOKEN", cfg.get("agent_token") or "") or None
    cfg["work_dir"] = str(
        Path(os.getenv("AWP_WORK_DIR", cfg["work_dir"])).expanduser().resolve()
    )
    if not cfg["agent_token"]:
        cfg["agent_token"] = load_saved_token(cfg["work_dir"])
    if not cfg["cloud_url"]:
        raise SystemExit("cloud_url is required")
    if not cfg.get("agent_token") and not cfg.get("api_key"):
        raise SystemExit("api_key is required for first registration")
    if not cfg["runner"].get("allowed_commands"):
        raise SystemExit("runner.allowed_commands must not be empty")
    return cfg


def save_token(token: str, work_dir: str | Path) -> Path:
    """Persist a token below app-owned state; never mutate operator YAML."""
    encoded = _validate_token(token)
    state = _state_directory(work_dir, create=True)
    assert state is not None
    return atomic_write(
        state,
        _TOKEN_FILE_NAME,
        encoded,
        max_bytes=_TOKEN_MAX_BYTES + 1,
    )
