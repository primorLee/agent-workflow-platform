#!/usr/bin/env python3
"""Outbound-only AWP worker with bounded execution and crash-safe result replay."""
from __future__ import annotations

__version__ = "1.0.0"

import argparse
import ctypes
import json
import logging
import logging.handlers
import os
import re
import shutil
import signal
import stat
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from cloud_client import CloudClient
from config import load as load_config, save_token
from storage import (
    atomic_write,
    ensure_owned_subdir,
    fsync_directory,
    is_link_or_reparse,
    lexists,
    open_append_file,
    open_existing,
    prepare_app_root,
    read_json,
    safe_unlink,
    write_exclusive,
)

logger = logging.getLogger("awp.worker")
_shutdown = threading.Event()
_MIN_DISK_FREE_MB = 500
_SAFE_TASK_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_SAFE_EXECUTABLE_BASENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
_SAFE_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_TASK_EXECUTION_OPT_IN = "AWP_TRUSTED_TASK_EXECUTION_OPT_IN"
_SENSITIVE_ENV_MARKERS = (
    "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL", "AUTH",
    "API_KEY", "PRIVATE_KEY", "ACCESS_KEY", "BEARER", "COOKIE", "SESSION",
)
_RESERVED_TASK_ENV_KEYS = {
    "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "TMP", "TEMP", "TMPDIR", "SYSTEMROOT", "WINDIR",
}
_TREE_GRACE_SECONDS = 2.0
_PROCESS_POLL_SECONDS = 0.05
_TASKS_DIR_NAME = "tasks"
_TASKS_ROOT_MARKER_NAME = ".awp-worker-tasks-root.json"
_TASK_MARKER_NAME = ".awp-worker-run.json"
_TASKS_ROOT_MARKER = {"schema": "awp-worker-tasks-root/v2"}
_TASK_MARKER_SCHEMA = "awp-worker-run/v2"
_MARKER_MAX_BYTES = 4096
_STATUS_MAX_BYTES = 64 * 1024
_PID_MAX_BYTES = 128
_INPUT_FILE_MAX_BYTES = 8 * 1024 * 1024
_INPUT_TOTAL_MAX_BYTES = 32 * 1024 * 1024


def _secure_move_log(root: Path, source_name: str, destination_name: str) -> None:
    source = root / source_name
    destination = root / destination_name
    descriptor, source_identity = open_existing(
        source, max_bytes=12 * 1024 * 1024
    )
    os.close(descriptor)
    if lexists(destination):
        destination_fd, destination_identity = open_existing(
            destination, max_bytes=12 * 1024 * 1024
        )
        os.close(destination_fd)
        safe_unlink(destination, destination_identity)
    os.rename(source, destination)
    moved = os.lstat(destination)
    if (moved.st_dev, moved.st_ino) != (
        source_identity.st_dev, source_identity.st_ino
    ):
        raise PermissionError("worker log identity changed during rotation")
    fsync_directory(root)


class _SecureRotatingFileHandler(logging.handlers.BaseRotatingHandler):
    def __init__(self, root: Path) -> None:
        self._owned_root = root
        super().__init__(
            str(root / "worker.log"),
            mode="a",
            encoding="utf-8",
            delay=True,
        )
        self.maxBytes = 10 * 1024 * 1024
        self.backupCount = 5
        for index in range(1, self.backupCount + 1):
            backup = self._owned_root / f"worker.log.{index}"
            if lexists(backup):
                descriptor, _ = open_existing(
                    backup, max_bytes=self.maxBytes + 1024 * 1024
                )
                os.close(descriptor)
        self.stream = self._open()

    def _open(self):
        return open_append_file(
            self._owned_root,
            "worker.log",
            max_existing_bytes=self.maxBytes + 1024 * 1024,
        )

    def shouldRollover(self, record) -> bool:
        if self.stream is None:
            self.stream = self._open()
        message = self.format(record) + self.terminator
        self.stream.seek(0, os.SEEK_END)
        return self.stream.tell() + len(message.encode("utf-8")) >= self.maxBytes

    def doRollover(self) -> None:
        if self.stream is not None:
            self.stream.flush()
            os.fsync(self.stream.fileno())
            self.stream.close()
            self.stream = None
        oldest = self._owned_root / f"worker.log.{self.backupCount}"
        if lexists(oldest):
            descriptor, identity = open_existing(
                oldest, max_bytes=self.maxBytes + 1024 * 1024
            )
            os.close(descriptor)
            safe_unlink(oldest, identity)
        for index in range(self.backupCount - 1, 0, -1):
            source = self._owned_root / f"worker.log.{index}"
            if lexists(source):
                _secure_move_log(
                    self._owned_root,
                    source.name,
                    f"worker.log.{index + 1}",
                )
        if lexists(self._owned_root / "worker.log"):
            _secure_move_log(self._owned_root, "worker.log", "worker.log.1")
        self.stream = self._open()


def _setup_logging(level_name: str, log_dir: str) -> None:
    owned_root = prepare_app_root(log_dir)
    level = getattr(logging, level_name.upper(), logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root_logger = logging.getLogger()
    previous_handlers = list(root_logger.handlers)
    root_logger.handlers.clear()
    for previous in previous_handlers:
        try:
            previous.close()
        except Exception:
            pass
    root_logger.setLevel(level)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    root_logger.addHandler(console)
    file_handler = _SecureRotatingFileHandler(owned_root)
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)


class _InstanceLock:
    def __init__(self, root: Path) -> None:
        self._root = prepare_app_root(root)
        self._path = self._root / "worker.pid"
        self._descriptor: int | None = None
        self._windows = os.name == "nt"

    def __enter__(self):
        if not lexists(self._path):
            try:
                write_exclusive(
                    self._root,
                    self._path.name,
                    b"0\n",
                    max_bytes=_PID_MAX_BYTES,
                )
            except FileExistsError:
                pass
        descriptor, _ = open_existing(
            self._path,
            max_bytes=_PID_MAX_BYTES,
            flags=os.O_RDWR,
        )
        try:
            if self._windows:
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            os.close(descriptor)
            raise RuntimeError("another worker already owns this state root") from None
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
        os.fsync(descriptor)
        self._descriptor = descriptor
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        descriptor = self._descriptor
        if descriptor is None:
            return
        try:
            os.ftruncate(descriptor, 0)
            os.lseek(descriptor, 0, os.SEEK_SET)
            os.write(descriptor, b"stopped\n")
            os.fsync(descriptor)
            if self._windows:
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)
            self._descriptor = None


def _normalized_command(name: str) -> str:
    return os.path.normcase(name) if os.name == "nt" else name


def _is_safe_executable_basename(name: str) -> bool:
    return bool(
        _SAFE_EXECUTABLE_BASENAME.fullmatch(name)
        and not os.path.isabs(name)
        and "/" not in name
        and "\\" not in name
        and ":" not in name
        and name not in {".", ".."}
    )


def _is_sensitive_env_key(key: str) -> bool:
    upper = key.upper()
    return (
        upper.startswith("AWP_")
        or "PROXY" in upper
        or any(marker in upper for marker in _SENSITIVE_ENV_MARKERS)
    )


def _task_marker(task_id: str, run_id: str) -> dict[str, str]:
    return {
        "schema": _TASK_MARKER_SCHEMA,
        "task_id": task_id,
        "run_id": run_id,
    }


def _private_directory_metadata(path: Path) -> os.stat_result:
    if not lexists(path) or is_link_or_reparse(path):
        raise PermissionError("worker task directory is missing or linked")
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode):
        raise PermissionError("worker task path is not a directory")
    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid != getuid():
        raise PermissionError("worker task directory owner is invalid")
    if os.name != "nt" and stat.S_IMODE(metadata.st_mode) != 0o700:
        raise PermissionError("worker task directory mode is invalid")
    return metadata


def _ensure_tasks_root(work_root: Path) -> Path:
    root = prepare_app_root(work_root)
    return ensure_owned_subdir(
        root,
        _TASKS_DIR_NAME,
        _TASKS_ROOT_MARKER_NAME,
        _TASKS_ROOT_MARKER,
    )


def _create_random_run(tasks_root: Path, task_id: str) -> dict:
    for _ in range(16):
        run_id = uuid.uuid4().hex
        directory = tasks_root / f"{task_id}--{run_id}"
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            continue
        os.chmod(directory, 0o700)
        identity = _private_directory_metadata(directory)
        marker = _task_marker(task_id, run_id)
        encoded = (
            json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        write_exclusive(
            directory,
            _TASK_MARKER_NAME,
            encoded,
            max_bytes=_MARKER_MAX_BYTES,
        )
        fsync_directory(tasks_root)
        return {
            "path": directory,
            "identity": (identity.st_dev, identity.st_ino),
            "marker": marker,
            "created": time.monotonic(),
            "task_id": task_id,
        }
    raise RuntimeError("could not allocate a unique task run directory")


def _validated_tracked_run(tasks_root: Path, record: dict) -> Path | None:
    directory = record["path"]
    if directory.parent != tasks_root or is_link_or_reparse(directory):
        return None
    try:
        metadata = _private_directory_metadata(directory)
        if (metadata.st_dev, metadata.st_ino) != tuple(record["identity"]):
            return None
        resolved = directory.resolve(strict=True)
        if resolved.parent != tasks_root:
            return None
        if read_json(
            resolved / _TASK_MARKER_NAME,
            max_bytes=_MARKER_MAX_BYTES,
        ) != record["marker"]:
            return None
    except (OSError, PermissionError, ValueError, TypeError):
        return None
    return resolved


def _contains_reparse(directory: Path) -> bool:
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                if is_link_or_reparse(path):
                    return True
                if entry.is_dir(follow_symlinks=False) and _contains_reparse(path):
                    return True
    except OSError:
        return True
    return False


def _delete_tracked_run(tasks_root: Path, record: dict) -> bool:
    directory = _validated_tracked_run(tasks_root, record)
    if directory is None or _contains_reparse(directory):
        return False
    try:
        shutil.rmtree(directory)
    except OSError:
        return False
    fsync_directory(tasks_root)
    return not lexists(directory)


def _ensure_private_child_directory(parent: Path, name: str) -> Path:
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("task input directory name is invalid")
    candidate = parent / name
    if lexists(candidate):
        _private_directory_metadata(candidate)
    else:
        candidate.mkdir(mode=0o700)
        os.chmod(candidate, 0o700)
        _private_directory_metadata(candidate)
    return candidate


def _write_private_input(directory: Path, name: str, data: bytes) -> None:
    write_exclusive(directory, name, data, max_bytes=_INPUT_FILE_MAX_BYTES)


if os.name == "nt":
    from ctypes import wintypes

    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
    _CREATE_SUSPENDED = 0x00000004

    class _IOCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class _JobBasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _JobExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JobBasicLimitInformation),
            ("IoInfo", _IOCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class _JobBasicAccountingInformation(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", ctypes.c_longlong),
            ("TotalKernelTime", ctypes.c_longlong),
            ("ThisPeriodTotalUserTime", ctypes.c_longlong),
            ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
            ("TotalPageFaultCount", wintypes.DWORD),
            ("TotalProcesses", wintypes.DWORD),
            ("ActiveProcesses", wintypes.DWORD),
            ("TotalTerminatedProcesses", wintypes.DWORD),
        ]

    class _WindowsJob:
        """Owned Windows process tree with verified assignment and kill-on-close."""

        def __init__(self) -> None:
            self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            self._ntdll = ctypes.WinDLL("ntdll")
            self._configure_apis()
            self._handle = self._kernel32.CreateJobObjectW(None, None)
            if not self._handle:
                raise ctypes.WinError(ctypes.get_last_error())
            info = _JobExtendedLimitInformation()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not self._kernel32.SetInformationJobObject(
                self._handle,
                _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                ctypes.byref(info),
                ctypes.sizeof(info),
            ):
                error = ctypes.WinError(ctypes.get_last_error())
                self.close()
                raise error

        def _configure_apis(self) -> None:
            self._kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
            self._kernel32.CreateJobObjectW.restype = wintypes.HANDLE
            self._kernel32.SetInformationJobObject.argtypes = [
                wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
            ]
            self._kernel32.SetInformationJobObject.restype = wintypes.BOOL
            self._kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            self._kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
            self._kernel32.IsProcessInJob.argtypes = [
                wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL),
            ]
            self._kernel32.IsProcessInJob.restype = wintypes.BOOL
            self._kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            self._kernel32.TerminateJobObject.restype = wintypes.BOOL
            self._kernel32.QueryInformationJobObject.argtypes = [
                wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID,
                wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ]
            self._kernel32.QueryInformationJobObject.restype = wintypes.BOOL
            self._kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            self._kernel32.CloseHandle.restype = wintypes.BOOL
            self._ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
            self._ntdll.NtResumeProcess.restype = ctypes.c_long

        def assign_and_resume(self, proc: subprocess.Popen) -> None:
            process_handle = wintypes.HANDLE(int(proc._handle))
            if not self._kernel32.AssignProcessToJobObject(self._handle, process_handle):
                raise ctypes.WinError(ctypes.get_last_error())
            in_job = wintypes.BOOL()
            if not self._kernel32.IsProcessInJob(process_handle, self._handle, ctypes.byref(in_job)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not in_job.value:
                raise OSError("process ownership verification failed")
            status = self._ntdll.NtResumeProcess(process_handle)
            if status != 0:
                raise OSError("suspended task process could not be resumed")

        def active_processes(self) -> int:
            info = _JobBasicAccountingInformation()
            if not self._kernel32.QueryInformationJobObject(
                self._handle,
                _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
                ctypes.byref(info),
                ctypes.sizeof(info),
                None,
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            return int(info.ActiveProcesses)

        def terminate(self, exit_code: int) -> None:
            if not self._kernel32.TerminateJobObject(self._handle, exit_code):
                if self.active_processes() != 0:
                    raise ctypes.WinError(ctypes.get_last_error())

        def wait_empty(self, timeout: float) -> bool:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if self.active_processes() == 0:
                    return True
                time.sleep(_PROCESS_POLL_SECONDS)
            return self.active_processes() == 0

        def close(self) -> None:
            if self._handle:
                self._kernel32.CloseHandle(self._handle)
                self._handle = None


class CommandRunner:
    """Execute explicitly trusted argv tasks inside owned process trees."""

    def __init__(self, cfg: dict):
        runner = cfg["runner"]
        self._work_root = prepare_app_root(cfg["work_dir"])
        self._tasks_root = _ensure_tasks_root(self._work_root)
        self._task_dirs_lock = threading.Lock()
        self._owned_runs: dict[str, dict] = {}
        self._execution_enabled = os.getenv(_TASK_EXECUTION_OPT_IN) == "1"
        self._allowed: set[str] = set()
        self._trusted_execs: dict[str, str] = {}
        trusted_dirs: list[str] = []
        allowed_commands = runner.get("allowed_commands")
        if not isinstance(allowed_commands, list) or not allowed_commands:
            raise ValueError("runner.allowed_commands must be a non-empty list")
        for raw_name in allowed_commands:
            if not isinstance(raw_name, str) or not _is_safe_executable_basename(raw_name):
                raise ValueError("runner.allowed_commands entries must be executable basenames")
            key = _normalized_command(raw_name)
            self._allowed.add(key)
            located = shutil.which(raw_name)
            if not located:
                continue
            try:
                resolved = Path(located).resolve(strict=True)
            except OSError:
                continue
            if not resolved.is_file():
                continue
            if resolved == self._work_root or self._work_root in resolved.parents:
                raise ValueError("allowlisted executable resolves inside the task work root")
            self._trusted_execs[key] = str(resolved)
            directory = str(resolved.parent)
            if directory not in trusted_dirs:
                trusted_dirs.append(directory)
        self._trusted_path = os.pathsep.join(trusted_dirs)

        self._allowed_env: dict[str, str] = {}
        allowed_env_keys = runner.get("allowed_env_keys", [])
        if not isinstance(allowed_env_keys, list):
            raise ValueError("runner.allowed_env_keys must be a list")
        for raw_key in allowed_env_keys:
            if not isinstance(raw_key, str) or not _SAFE_ENV_KEY.fullmatch(raw_key):
                raise ValueError("runner.allowed_env_keys contains an invalid key")
            upper = raw_key.upper()
            if _is_sensitive_env_key(raw_key) or upper in _RESERVED_TASK_ENV_KEYS:
                raise ValueError("runner.allowed_env_keys contains a forbidden key")
            self._allowed_env[upper] = raw_key

        self._timeout = float(runner.get("timeout_seconds", 3600))
        self._max_output = int(runner.get("max_output_bytes", 1048576))
        self._keep = bool(runner.get("keep_workdirs", False))
        if self._timeout <= 0:
            raise ValueError("runner.timeout_seconds must be positive")
        if self._max_output <= 0 or self._max_output > 1048576:
            raise ValueError(
                "runner.max_output_bytes must be between 1 and 1048576"
            )

    def _task_dir(self, task_id: str) -> Path:
        if not _SAFE_TASK_ID.fullmatch(task_id):
            raise ValueError("task_id must match [A-Za-z0-9_.-] and be <=128 chars")
        with self._task_dirs_lock:
            if task_id in self._owned_runs:
                raise RuntimeError("task_id already has a run owned by this process")
            record = _create_random_run(self._tasks_root, task_id)
            self._owned_runs[task_id] = record
            return record["path"]

    @staticmethod
    def _write_inputs(work_dir: Path, files: dict) -> None:
        if not isinstance(files, dict):
            raise ValueError("payload.files must be an object")
        if len(files) > 1024:
            raise ValueError("payload.files contains too many entries")
        total = 0
        for relative, content in files.items():
            if not isinstance(relative, str):
                raise ValueError("task input path must be a string")
            normalized = relative.replace("\\", "/")
            parsed = PurePosixPath(normalized)
            if (
                not normalized
                or parsed.is_absolute()
                or any(part in {"", ".", ".."} for part in parsed.parts)
                or ":" in parsed.parts[0]
            ):
                raise ValueError("task input path is invalid")
            data = str(content).encode("utf-8")
            total += len(data)
            if len(data) > _INPUT_FILE_MAX_BYTES or total > _INPUT_TOTAL_MAX_BYTES:
                raise ValueError("payload.files exceeds its size limit")
            parent = work_dir
            for part in parsed.parts[:-1]:
                parent = _ensure_private_child_directory(parent, part)
            _write_private_input(parent, parsed.parts[-1], data)

    def _task_environment(self, work_dir: Path, requested: object) -> dict[str, str]:
        if not isinstance(requested, dict):
            raise ValueError("payload.env must be an object")
        temp_dir = _ensure_private_child_directory(work_dir, ".tmp")
        env = {
            "HOME": str(work_dir),
            "PATH": self._trusted_path,
            "TEMP": str(temp_dir),
            "TMP": str(temp_dir),
            "TMPDIR": str(temp_dir),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        }
        if os.name == "nt":
            env["USERPROFILE"] = str(work_dir)
        for key in ("LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR"):
            value = os.environ.get(key)
            if value and "\x00" not in value and not _is_sensitive_env_key(key):
                env[key] = value
        for raw_key, raw_value in requested.items():
            if not isinstance(raw_key, str) or not _SAFE_ENV_KEY.fullmatch(raw_key):
                raise ValueError("payload.env contains an invalid key")
            upper = raw_key.upper()
            if _is_sensitive_env_key(raw_key) or upper in _RESERVED_TASK_ENV_KEYS:
                raise PermissionError("payload.env contains a forbidden key")
            canonical = self._allowed_env.get(upper)
            if canonical is None:
                continue
            value = str(raw_value)
            if "\x00" in value or len(value) > 65536:
                raise ValueError("payload.env value exceeds safety limits")
            env[canonical] = value
        return env

    @staticmethod
    def _posix_group_alive(process_group: int) -> bool:
        try:
            os.killpg(process_group, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError as exc:
            raise RuntimeError("owned process group could not be inspected") from exc

    @classmethod
    def _finish_posix_tree(cls, proc: subprocess.Popen) -> None:
        process_group = proc.pid
        if cls._posix_group_alive(process_group):
            try:
                os.killpg(process_group, signal.SIGTERM)
            except ProcessLookupError:
                pass
        term_deadline = time.monotonic() + (_TREE_GRACE_SECONDS / 2)
        while time.monotonic() < term_deadline and cls._posix_group_alive(process_group):
            time.sleep(_PROCESS_POLL_SECONDS)
        if cls._posix_group_alive(process_group):
            try:
                os.killpg(process_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        kill_deadline = time.monotonic() + (_TREE_GRACE_SECONDS / 2)
        while time.monotonic() < kill_deadline and cls._posix_group_alive(process_group):
            time.sleep(_PROCESS_POLL_SECONDS)
        try:
            proc.wait(timeout=_TREE_GRACE_SECONDS)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("owned task process did not terminate") from exc
        if cls._posix_group_alive(process_group):
            raise RuntimeError("owned task process group did not terminate")

    @staticmethod
    def _finish_windows_tree(proc: subprocess.Popen, job) -> None:
        cleanup_error = None
        try:
            job.terminate(124)
            if not job.wait_empty(_TREE_GRACE_SECONDS):
                cleanup_error = RuntimeError("owned Windows task tree did not terminate")
        except OSError:
            cleanup_error = RuntimeError("owned Windows task tree termination failed")
        finally:
            job.close()
        try:
            proc.wait(timeout=_TREE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=_TREE_GRACE_SECONDS)
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("owned task process did not terminate") from exc
        if cleanup_error is not None:
            raise cleanup_error

    @staticmethod
    def _wait_for_completion(proc: subprocess.Popen, timeout: float, cancel_event) -> tuple[bool, bool]:
        deadline = time.monotonic() + timeout
        while proc.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                return False, True
            if time.monotonic() >= deadline:
                return True, False
            time.sleep(min(_PROCESS_POLL_SECONDS, max(0.0, deadline - time.monotonic())))
        return False, False

    def run(self, task: dict, cancel_event=None) -> dict:
        if not self._execution_enabled:
            raise PermissionError(
                "task execution is disabled; trusted local operators must explicitly opt in"
            )
        task_id = str(task.get("task_id") or "")
        if not _SAFE_TASK_ID.fullmatch(task_id):
            raise ValueError("task_id must match [A-Za-z0-9_.-] and be <=128 chars")
        argv = task.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
            raise ValueError("payload.argv must be a non-empty list of strings")
        requested_executable = argv[0]
        if not _is_safe_executable_basename(requested_executable):
            raise PermissionError("argv[0] must be an allowlisted executable basename")
        command_key = _normalized_command(requested_executable)
        if command_key not in self._allowed:
            raise PermissionError("command is not allowlisted")
        executable = self._trusted_execs.get(command_key)
        if executable is None:
            raise PermissionError("allowlisted command is unavailable on this worker")
        if len(argv) > 128 or any("\x00" in arg or len(arg) > 8192 for arg in argv):
            raise ValueError("argv exceeds safety limits")

        work_dir = self._task_dir(task_id)
        self._write_inputs(work_dir, task.get("files") or {})
        env = self._task_environment(work_dir, task.get("env") or {})
        command = [executable, *argv[1:]]

        popen_kwargs = {
            "cwd": work_dir,
            "env": env,
            "shell": False,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "close_fds": True,
        }
        job = None
        proc = None
        try:
            if os.name == "nt":
                job = _WindowsJob()
                popen_kwargs["creationflags"] = (
                    subprocess.CREATE_NEW_PROCESS_GROUP | _CREATE_SUSPENDED
                )
            else:
                popen_kwargs["start_new_session"] = True
            proc = subprocess.Popen(command, **popen_kwargs)
            if job is not None:
                job.assign_and_resume(proc)
        except Exception:
            if proc is not None:
                try:
                    proc.kill()
                    proc.wait(timeout=_TREE_GRACE_SECONDS)
                except Exception:
                    pass
            if job is not None:
                job.close()
            raise RuntimeError("could not start task in an owned process tree") from None

        chunks: list[bytes] = []
        kept = 0
        truncated = False

        def drain() -> None:
            nonlocal kept, truncated
            assert proc.stdout is not None
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    return
                if kept < self._max_output:
                    take = chunk[: self._max_output - kept]
                    chunks.append(take)
                    kept += len(take)
                    if len(take) < len(chunk):
                        truncated = True
                else:
                    truncated = True

        reader = threading.Thread(target=drain, name=f"awp-output-{task_id}", daemon=True)
        reader.start()
        started = time.monotonic()
        timed_out, canceled = self._wait_for_completion(proc, self._timeout, cancel_event)
        cleanup_error = None
        try:
            if os.name == "nt":
                self._finish_windows_tree(proc, job)
            else:
                self._finish_posix_tree(proc)
        except RuntimeError as exc:
            cleanup_error = exc
        reader.join(timeout=_TREE_GRACE_SECONDS)
        if reader.is_alive() and proc.stdout is not None:
            proc.stdout.close()
            reader.join(timeout=_PROCESS_POLL_SECONDS * 2)
        if reader.is_alive() and cleanup_error is None:
            cleanup_error = RuntimeError("owned task output pipe did not close")
        if cleanup_error is not None:
            raise cleanup_error

        elapsed = time.monotonic() - started
        output = b"".join(chunks).decode("utf-8", errors="replace")
        status = "success" if proc.returncode == 0 and not timed_out and not canceled else "error"
        return {
            "status": status,
            "exit_code": proc.returncode,
            "elapsed": elapsed,
            "log_tail": output,
            "output": {
                "stdout": output,
                "exit_code": proc.returncode,
                "timed_out": timed_out,
                "canceled": canceled,
                "truncated": truncated,
            },
        }

    def cleanup(self, task_id: str) -> None:
        if not _SAFE_TASK_ID.fullmatch(task_id):
            return
        with self._task_dirs_lock:
            record = self._owned_runs.get(task_id)
            if record is None or self._keep:
                return
            if _delete_tracked_run(self._tasks_root, record):
                self._owned_runs.pop(task_id, None)

    def cleanup_oldest(self, keep: int = 5, exclude: set[str] | None = None) -> int:
        exclude = set(exclude or ())
        with self._task_dirs_lock:
            eligible = [
                record
                for task_id, record in self._owned_runs.items()
                if task_id not in exclude
            ]
            eligible.sort(key=lambda record: (record["created"], record["path"].name))
            keep_count = max(0, int(keep))
            victims = eligible[:-keep_count] if keep_count else eligible
            removed = 0
            for record in victims:
                if _delete_tracked_run(self._tasks_root, record):
                    self._owned_runs.pop(record["task_id"], None)
                    removed += 1
            return removed


def _write_status(work_dir: str, status: str, started: float, completed: int, last_error="") -> None:
    root = prepare_app_root(work_dir)
    data = {
        "status": str(status)[:32],
        "pid": os.getpid(),
        "uptime_seconds": round(max(0.0, time.time() - started), 1),
        "completed_tasks": max(0, int(completed)),
        "last_heartbeat": datetime.now(timezone.utc).isoformat(),
        "last_error": str(last_error)[:256],
    }
    encoded = (
        json.dumps(data, allow_nan=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    atomic_write(
        root,
        "worker.status.json",
        encoded,
        max_bytes=_STATUS_MAX_BYTES,
    )


def _safe_task_label(value: object) -> str:
    text = str(value or "")
    return text if _SAFE_TASK_ID.fullmatch(text) else "invalid-task"


def _error_kind(exc: BaseException) -> str:
    name = type(exc).__name__
    return name if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name) else "Error"


class Agent:
    def __init__(self, cfg: dict):
        self._cfg = cfg
        self._cloud = CloudClient(cfg)
        self._runner = CommandRunner(cfg)
        self._max_concurrent = int(cfg.get("max_concurrent", 2))
        self._poll_interval = int(cfg.get("poll_interval", 2))
        self._running = {}
        self._started = time.time()
        self._completed = 0
        self._last_error = ""

    def start(self) -> None:
        work_dir = self._cfg["work_dir"]
        with _InstanceLock(Path(work_dir)):
            _setup_logging(self._cfg.get("log_level", "INFO"), work_dir)
            _write_status(work_dir, "starting", self._started, 0)
            if not self._cloud.token:
                token = self._cloud.register()
                if not token:
                    raise SystemExit("agent registration did not return a token")
                save_token(token, work_dir)

            pool = ThreadPoolExecutor(
                max_workers=self._max_concurrent,
                thread_name_prefix="awp-task",
            )
            try:
                while not _shutdown.is_set():
                    self._tick(pool)
                    _shutdown.wait(self._poll_interval)
            finally:
                _write_status(
                    work_dir,
                    "shutting_down",
                    self._started,
                    self._completed,
                    self._last_error,
                )
                pool.shutdown(wait=True)
                try:
                    self._cloud.heartbeat(status="offline")
                except Exception:
                    pass
                _write_status(
                    work_dir,
                    "stopped",
                    self._started,
                    self._completed,
                    self._last_error,
                )

    def _tick(self, pool: ThreadPoolExecutor) -> None:
        for task_id in [tid for tid, future in self._running.items() if future.done()]:
            future = self._running.pop(task_id)
            failure = future.exception()
            if failure is not None:
                self._last_error = f"{_safe_task_label(task_id)}:{_error_kind(failure)}"
            else:
                self._completed += 1
        status = "busy" if self._running else "idle"
        try:
            self._cloud.heartbeat(status=status, running_tasks=list(self._running))
        except Exception as exc:
            logger.warning("Heartbeat failed: %s", _error_kind(exc))
        _write_status(
            self._cfg["work_dir"],
            status,
            self._started,
            self._completed,
            self._last_error,
        )
        # Network failures are handled as replay state.  Any exception escaping
        # here is a local ownership/integrity failure and must stop the worker.
        self._cloud.flush_offline()

        free_mb = shutil.disk_usage(self._cfg["work_dir"]).free / (1024 * 1024)
        if free_mb < _MIN_DISK_FREE_MB:
            self._runner.cleanup_oldest(keep=3, exclude=set(self._running))
            if shutil.disk_usage(self._cfg["work_dir"]).free / (1024 * 1024) < _MIN_DISK_FREE_MB:
                return
        free_slots = self._max_concurrent - len(self._running)
        if free_slots <= 0:
            return
        try:
            tasks = self._cloud.poll_tasks()
        except Exception as exc:
            logger.warning("Task poll failed: %s", _error_kind(exc))
            return
        for task in tasks:
            if free_slots <= 0:
                break
            task_id = _safe_task_label(task.get("task_id"))
            if task_id == "invalid-task" or task_id in self._running:
                logger.warning("Skipped an invalid or duplicate task")
                continue
            self._running[task_id] = pool.submit(self._execute_task, task)
            free_slots -= 1

    def _execute_task(self, task: dict) -> None:
        task_id = _safe_task_label(task.get("task_id"))
        try:
            result = self._runner.run(task, cancel_event=_shutdown)
            self._cloud.report_result(task_id, result)
        except Exception as exc:
            kind = _error_kind(exc)
            self._last_error = f"{task_id}:{kind}"
            logger.warning("Task %s failed: %s", task_id, kind)
            try:
                self._cloud.report_result(task_id, {
                    "status": "error",
                    "elapsed": 0,
                    "log_tail": f"worker exception: {kind}",
                    "output": {"exit_code": -1},
                })
            except Exception as report_error:
                logger.warning(
                    "Could not report task failure: %s",
                    _error_kind(report_error),
                )
        finally:
            self._runner.cleanup(task_id)


def _handle_signal(signum, _frame):
    logger.info("Received signal %d; draining workers", signum)
    _shutdown.set()


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent Workflow Platform worker")
    parser.add_argument("-c", "--config", default=None)
    args = parser.parse_args()
    try:
        cfg = load_config(args.config)
        signal.signal(signal.SIGINT, _handle_signal)
        signal.signal(signal.SIGTERM, _handle_signal)
        Agent(cfg).start()
    except SystemExit:
        raise
    except Exception as exc:
        logger.error("Worker stopped: %s", _error_kind(exc))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()