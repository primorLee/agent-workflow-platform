#!/usr/bin/env python3
"""Create an online, integrity-checked SQLite backup with retention pruning."""
from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import time
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_backup(source: Path, destination_dir: Path, retention: int = 7) -> Path:
    source = source.resolve(strict=True)
    destination_dir.mkdir(parents=True, exist_ok=True)
    lock_path = destination_dir / ".sqlite-backup.lock"
    with lock_path.open("a+b") as lock_handle:
        if os.name == "nt":
            lock_handle.write(b"0")
            lock_handle.flush()
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        final_path = destination_dir / f"{source.stem}-{stamp}.db"
        temp_path = final_path.with_suffix(".db.tmp")
        if temp_path.exists():
            temp_path.unlink()
        src = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True, timeout=30)
        dst = sqlite3.connect(temp_path)
        try:
            src.backup(dst)
            result = dst.execute("PRAGMA integrity_check").fetchone()
            if not result or result[0] != "ok":
                raise RuntimeError(f"backup integrity_check failed: {result!r}")
        finally:
            dst.close()
            src.close()
        os.replace(temp_path, final_path)
        final_path.with_suffix(".db.sha256").write_text(sha256_file(final_path) + "\n", encoding="ascii")
        backups = sorted(destination_dir.glob(f"{source.stem}-*.db"), key=lambda item: item.stat().st_mtime, reverse=True)
        for stale in backups[max(1, retention):]:
            stale.unlink(missing_ok=True)
            stale.with_suffix(".db.sha256").unlink(missing_ok=True)
        return final_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--retention", type=int, default=7)
    args = parser.parse_args()
    backup = create_backup(args.source, args.destination, args.retention)
    print(backup)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())