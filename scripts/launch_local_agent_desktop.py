#!/usr/bin/env python3
"""Launch the real-model Desktop with the local Compose managed-task bridge."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from submit_local_task import canonical_local_base, load_api_key

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"


def valid_model(raw: str) -> str:
    value = str(raw).strip()
    if not value or len(value) > 256:
        raise argparse.ArgumentTypeError("model must contain 1 to 256 characters")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise argparse.ArgumentTypeError("model contains unsupported characters")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        type=valid_model,
        default=os.environ.get("AWP_AGENT_MODEL"),
        required="AWP_AGENT_MODEL" not in os.environ,
        help="model id exposed by the configured OpenAI-compatible endpoint",
    )
    parser.add_argument("--url", default="http://127.0.0.1:8100", help=argparse.SUPPRESS)
    return parser


def build_environment(model: str, base: str, api_key: str) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "AWP_AGENT_MODEL": valid_model(model),
            "AWP_AGENT_MANAGED_TASKS_OPT_IN": "1",
            "AWP_CONTROL_PLANE_URL": canonical_local_base(base),
            "AWP_CONTROL_PLANE_API_KEY": api_key,
        }
    )
    return environment


def main(cli_args: list[str] | None = None) -> int:
    args = build_parser().parse_args(cli_args)
    try:
        api_key = load_api_key()
        environment = build_environment(args.model, args.url, api_key)
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError("npm is unavailable")
        result = subprocess.run(
            [npm, "--prefix", str(DESKTOP), "run", "openai-compatible:electron"],
            cwd=ROOT,
            env=environment,
            check=False,
        )
        return int(result.returncode)
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
        print(
            "FAILED: start the local Compose stack, install Desktop dependencies, "
            "and provide a valid model id",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
