#!/usr/bin/env python3
"""Generate deterministic desktop icon assets from a caller-selected image."""

from __future__ import annotations

import argparse
import os
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Sequence

_DESKTOP_DIR = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _DESKTOP_DIR / "resources" / "icon-source.png"
_DEFAULT_OUTPUT_DIR = _DESKTOP_DIR / "resources"
_PNG_SIZES = (1024, 512, 256)
_ICO_SIZES = ((256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate PNG and Windows ICO assets for the desktop app.",
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=_DEFAULT_INPUT,
        help=(
            "source PNG/JPEG/WebP image "
            "(default: apps/desktop/resources/icon-source.png)"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=_DEFAULT_OUTPUT_DIR,
        help=(
            "destination inside apps/desktop "
            "(default: apps/desktop/resources)"
        ),
    )
    parser.add_argument(
        "--crop",
        nargs=4,
        type=int,
        metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
        help="optional square crop in source pixels; defaults to a centered square",
    )
    return parser


def _resolve_paths(
    parser: argparse.ArgumentParser,
    source_arg: Path,
    output_arg: Path,
) -> tuple[Path, Path]:
    source = source_arg.expanduser().resolve()
    if not source.is_file():
        parser.error(f"input image does not exist or is not a file: {source_arg}")

    output_dir = output_arg.expanduser().resolve()
    try:
        output_dir.relative_to(_DESKTOP_DIR.resolve())
    except ValueError:
        parser.error("--output-dir must remain inside apps/desktop")

    destinations = {
        output_dir / "icon.png",
        output_dir / "icon-512.png",
        output_dir / "icon-256.png",
        output_dir / "icon.ico",
    }
    if source in destinations:
        parser.error("input image must not be one of the generated output files")
    return source, output_dir


def _crop_box(
    parser: argparse.ArgumentParser,
    width: int,
    height: int,
    values: Sequence[int] | None,
) -> tuple[int, int, int, int]:
    if values is None:
        side = min(width, height)
        left = (width - side) // 2
        top = (height - side) // 2
        return left, top, left + side, top + side

    left, top, right, bottom = values
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        parser.error("--crop must describe a positive rectangle inside the source image")
    if right - left != bottom - top:
        parser.error("--crop must be square so generated icons are not distorted")
    return left, top, right, bottom


def _encode_assets(master: object, image_module: object) -> dict[str, bytes]:
    payloads: dict[str, bytes] = {}
    resampling = image_module.Resampling.LANCZOS
    for size in _PNG_SIZES:
        rendered = master if size == 1024 else master.resize((size, size), resampling)
        buffer = BytesIO()
        rendered.save(buffer, format="PNG")
        filename = "icon.png" if size == 1024 else f"icon-{size}.png"
        payloads[filename] = buffer.getvalue()

    buffer = BytesIO()
    master.save(buffer, format="ICO", sizes=_ICO_SIZES)
    payloads["icon.ico"] = buffer.getvalue()
    return payloads


def _atomic_write(path: Path, payload: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    source, output_dir = _resolve_paths(parser, args.input, args.output_dir)

    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError:
        parser.error("Pillow is required; install the desktop image tooling first")

    try:
        with Image.open(source) as candidate:
            candidate.verify()
        with Image.open(source) as candidate:
            image = candidate.convert("RGBA")
            image.load()
    except (OSError, UnidentifiedImageError) as exc:
        parser.error(f"input is not a readable image: {exc}")

    crop = _crop_box(parser, image.width, image.height, args.crop)
    master = image.crop(crop).resize((1024, 1024), Image.Resampling.LANCZOS)

    # Render every payload before touching the destination, then replace each
    # file atomically so a failed encode never leaves a truncated icon.
    payloads = _encode_assets(master, Image)
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename, payload in payloads.items():
        _atomic_write(output_dir / filename, payload)
        print(f"wrote {filename}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())