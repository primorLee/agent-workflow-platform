#!/usr/bin/env python3
"""Wait for a localhost HTTP readiness endpoint with a bounded deadline."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--json-field", help="optional JSON field that must be truthy")
    args = parser.parse_args()

    parsed = urllib.parse.urlsplit(args.url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        print("FAILED: readiness helper accepts only localhost HTTP URLs", file=sys.stderr)
        return 2

    deadline = time.monotonic() + max(0.1, args.timeout)
    last_error = "not attempted"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(args.url, timeout=3) as response:
                if response.status != 200:
                    last_error = f"HTTP {response.status}"
                else:
                    body = response.read()
                    if args.json_field:
                        document = json.loads(body)
                        if not document.get(args.json_field):
                            last_error = f"JSON field {args.json_field!r} is not truthy"
                        else:
                            print(f"ready: {args.url}")
                            return 0
                    else:
                        print(f"ready: {args.url}")
                        return 0
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            last_error = type(exc).__name__
        time.sleep(max(0.05, args.interval))

    print(f"FAILED: readiness deadline exceeded ({last_error})", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())