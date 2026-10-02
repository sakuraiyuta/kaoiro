#!/usr/bin/env python3
"""Run one command inside an isolated PID namespace and process group."""

from __future__ import annotations

import shutil
import subprocess
import sys


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("usage: run-antigravity-test-namespace.py -- COMMAND [ARG ...]", file=sys.stderr)
        return 2

    missing = [name for name in ("setsid", "unshare") if shutil.which(name) is None]
    if missing:
        print("namespace wrapper: required command unavailable: " + ", ".join(missing), file=sys.stderr)
        return 2

    command = [
        "setsid", "-w", "unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc",
        "setsid", "-w", *argv,
    ]
    try:
        completed = subprocess.run(command, check=False)
    except OSError as error:
        print(f"namespace wrapper: could not start isolated command: {error}", file=sys.stderr)
        return 2
    return completed.returncode if completed.returncode >= 0 else 128 - completed.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
