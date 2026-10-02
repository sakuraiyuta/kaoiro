#!/usr/bin/env python3
"""Run one command in an isolated process group and reject unsafe kill(2) targets.

Usage: scripts/antigravity-kill-trace-gate.py -- COMMAND [ARG ...]

The outer setsid keeps a kill(0) in the tracee tree away from this runner,
strace, and the invoking shell. The inner setsid gives the command a process
group whose leader is itself traced. A negative group target is accepted only
when its group leader PID was observed by this strace run.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PID_PREFIX = re.compile(r"^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)(.*)$")
CLONE_RESULT = re.compile(r"^(?:clone3?|fork|vfork)\(.*\)\s+=\s+(\d+)(?:\s|$)")
KILL_TARGET = re.compile(r"^kill\(\s*(-?\d+)\s*,")


def parse_trace(path: Path) -> tuple[set[int], list[tuple[int, str]]]:
    observed: set[int] = set()
    kills: list[tuple[int, str]] = []
    malformed_kills: list[str] = []

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = PID_PREFIX.match(line)
        if match is None:
            if "kill(" in line:
                malformed_kills.append(line)
            continue
        pid = int(match.group(1) or match.group(2))
        body = match.group(3)
        observed.add(pid)

        clone = CLONE_RESULT.match(body)
        if clone is not None:
            child_pid = int(clone.group(1))
            if child_pid > 0:
                observed.add(child_pid)

        target = KILL_TARGET.match(body)
        if target is not None:
            kills.append((int(target.group(1)), line))

    if malformed_kills:
        raise ValueError("could not identify the traced process for a kill(2) line: " + malformed_kills[0])
    if not observed:
        raise ValueError("strace output contained no identifiable traced process IDs")
    return observed, kills


def unsafe_targets(observed: set[int], kills: list[tuple[int, str]]) -> list[str]:
    failures: list[str] = []
    for target, line in kills:
        if target in (0, -1):
            failures.append(f"unconditionally forbidden target {target}: {line}")
        elif target == 1:
            failures.append(f"forbidden namespace init target 1: {line}")
        elif target > 1 and target not in observed:
            failures.append(f"PID {target} was not observed by strace: {line}")
        elif target < -1 and -target not in observed:
            failures.append(f"process-group leader PID {-target} was not observed by strace: {line}")
    return failures


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("usage: antigravity-kill-trace-gate.py -- COMMAND [ARG ...]", file=sys.stderr)
        return 2

    missing = [name for name in ("unshare", "setsid", "strace") if shutil.which(name) is None]
    if missing:
        print("trace gate: required command unavailable: " + ", ".join(missing), file=sys.stderr)
        return 2

    scratch = Path(tempfile.mkdtemp(prefix="momo490-kill-trace-"))
    os.chmod(scratch, 0o700)
    trace = scratch / "strace.log"
    preserve_trace = False
    command = [
        "unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc",
        "setsid", "-w", "strace", "-f", "-e", "trace=kill,process", "-o", str(trace), "--",
        "setsid", "-w", *argv,
    ]

    try:
        completed = subprocess.run(command, check=False)
        if not trace.is_file():
            print(f"trace gate: strace did not produce its trace (command exit {completed.returncode})", file=sys.stderr)
            return 1
        observed, kills = parse_trace(trace)
        failures = unsafe_targets(observed, kills)
        print(f"trace gate: traced_processes={len(observed)} kill_syscalls={len(kills)}")
        for failure in failures:
            print(f"trace gate: REJECT {failure}", file=sys.stderr)
        if failures:
            preserve_trace = True
            print(f"trace gate: trace retained at {trace}", file=sys.stderr)
            return 1
        if completed.returncode != 0:
            preserve_trace = True
            print(f"trace gate: command failed with exit {completed.returncode}", file=sys.stderr)
            print(f"trace gate: trace retained at {trace}", file=sys.stderr)
            return completed.returncode if completed.returncode > 0 else 1
        print("trace gate: PASS; each kill target was an observed PID or process-group leader")
        return 0
    except (OSError, ValueError) as error:
        preserve_trace = True
        print(f"trace gate: FAIL CLOSED: {error}", file=sys.stderr)
        print(f"trace gate: trace retained at {trace}", file=sys.stderr)
        return 1
    finally:
        if not preserve_trace:
            shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
