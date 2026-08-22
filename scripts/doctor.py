#!/usr/bin/env python3
"""Check local prerequisites without installing or changing anything."""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
VersionCheck = Callable[[str], tuple[bool, str]]


@dataclass(frozen=True)
class Check:
    name: str
    command: tuple[str, ...]
    required_for: frozenset[str]
    version_check: VersionCheck | None = None


def parse_version(output: str) -> tuple[int, int, int] | None:
    match = re.search(r"(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?", output)
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def minimum_version(required: tuple[int, int, int]) -> VersionCheck:
    def check(output: str) -> tuple[bool, str]:
        found = parse_version(output)
        if found is None:
            return False, f"could not parse version; need >= {'.'.join(map(str, required))}"
        return found >= required, f"need >= {'.'.join(map(str, required))}"

    return check


def desktop_node_version(output: str) -> tuple[bool, str]:
    found = parse_version(output)
    if found is None:
        return False, "could not parse version; need Node >=22.12.0"
    ok = found >= (22, 12, 0)
    return ok, "need Node >=22.12.0"


def go_minimum() -> tuple[int, int, int]:
    text = (ROOT / "services" / "vm-agent" / "go.mod").read_text(encoding="utf-8")
    match = re.search(r"(?m)^go\s+(\d+)\.(\d+)(?:\.(\d+))?\s*$", text)
    if not match:
        return (1, 25, 13)
    return tuple(int(part or 0) for part in match.groups())


PYTHON_COMPONENTS = {"static", "control-plane", "worker-agent", "workflows"}
NODE_COMPONENTS = {"desktop", "admin", "mobile"}
CHECKS = (
    Check(
        "Python",
        (sys.executable, "--version"),
        frozenset(PYTHON_COMPONENTS),
        minimum_version((3, 12, 0)),
    ),
    Check("Node.js", ("node", "--version"), frozenset(NODE_COMPONENTS), desktop_node_version),
    Check("npm", ("npm", "--version"), frozenset(NODE_COMPONENTS)),
    Check("Go", ("go", "version"), frozenset({"vm-agent"}), minimum_version(go_minimum())),
    Check("Git", ("git", "--version"), frozenset({"all"})),
    Check("Bash", ("bash", "--version"), frozenset({"operations"})),
    Check("Docker", ("docker", "--version"), frozenset()),
)

COMPONENTS = {
    "all": {"all", "static", "control-plane", "worker-agent", "workflows", "desktop", "admin", "mobile", "vm-agent", "operations"},
    "core": {"all", "static", "control-plane", "worker-agent", "workflows", "desktop"},
    "static": {"all", "static"},
    "control-plane": {"all", "control-plane"},
    "worker-agent": {"all", "worker-agent"},
    "desktop": {"all", "desktop"},
    "admin": {"all", "admin"},
    "mobile": {"all", "mobile"},
    "vm-agent": {"all", "vm-agent"},
    "workflows": {"all", "workflows"},
    "operations": {"all", "operations"},
}

REQUIRED_PATHS = {
    "static": (ROOT / "README.md", ROOT / "scripts" / "validate.py"),
    "desktop": (ROOT / "apps" / "desktop" / "package.json",),
    "admin": (ROOT / "apps" / "admin" / "package.json",),
    "mobile": (ROOT / "apps" / "mobile" / "package.json",),
    "control-plane": (ROOT / "services" / "control-plane" / "requirements.txt",),
    "worker-agent": (ROOT / "services" / "worker-agent" / "requirements.txt",),
    "vm-agent": (ROOT / "services" / "vm-agent" / "go.mod",),
    "workflows": (ROOT / "workflows" / "validation" / "validate_workflows.py",),
    "operations": (ROOT / "deploy", ROOT / "ops"),
}


def find_windows_git_bash() -> str | None:
    """Find Git Bash from the Git executable first, then standard installs."""
    candidates: list[Path] = []
    git = shutil.which("git")
    if git:
        git_path = Path(git).resolve()
        git_root = git_path.parent.parent
        candidates.extend(
            (
                git_root / "bin" / "bash.exe",
                git_root / "usr" / "bin" / "bash.exe",
            )
        )
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        value = os.environ.get(variable)
        if value:
            candidates.append(Path(value) / "Git" / "bin" / "bash.exe")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Programs" / "Git" / "bin" / "bash.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def run_version(check: Check) -> tuple[bool, str]:
    executable = check.command[0]
    resolved = executable if Path(executable).is_file() else shutil.which(executable)
    if not resolved and executable == "bash" and os.name == "nt":
        resolved = find_windows_git_bash()
    if not resolved:
        return False, "not found"
    try:
        completed = subprocess.run(
            (str(resolved), *check.command[1:]),
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    output_lines = (completed.stdout or completed.stderr).strip().splitlines()
    detail = output_lines[0] if output_lines else f"exit {completed.returncode}"
    if completed.returncode != 0:
        return False, detail
    if check.version_check:
        ok, requirement = check.version_check(detail)
        if not ok:
            return False, f"{detail}; {requirement}"
    return True, detail


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=sorted(COMPONENTS), default="core")
    args = parser.parse_args()
    selected = COMPONENTS[args.component]

    print(f"Platform: {platform.system()} {platform.machine()}")
    failed = False
    for check in CHECKS:
        required = bool(check.required_for & selected)
        ok, detail = run_version(check)
        label = "PASS" if ok else ("FAIL" if required else "OPTIONAL")
        print(f"{label:8} {check.name}: {detail}")
        failed = failed or (required and not ok)

    for component in sorted(selected - {"all"}):
        for path in REQUIRED_PATHS.get(component, ()):
            ok = path.exists()
            print(f"{'PASS' if ok else 'FAIL':8} {component}: {path.relative_to(ROOT)}")
            failed = failed or not ok

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())