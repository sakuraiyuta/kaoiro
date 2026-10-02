#!/usr/bin/env python3
"""Run a command in an isolated process group and reject unsafe signal targets.

Usage: scripts/antigravity-kill-trace-gate.py -- COMMAND [ARG ...]

The outer setsid keeps kill(0) in the tracee tree away from this runner,
strace, and the invoking shell. The inner setsid gives the command a process
group whose leader is itself traced. A negative group target is accepted only
when its group leader PID was observed in this strace run.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


PID_PREFIX = re.compile(r"^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)(.*)$")
PROCESS_CREATE = re.compile(r"^(clone3?|fork|vfork)\(.*\)\s+=\s+(\d+)(?:<[^>]*>)?(?:\s|$)")
PROCESS_CREATE_START = re.compile(r"^(clone3?|fork|vfork)\(")
PROCESS_CREATE_RESUME = re.compile(r"^<\.\.\.\s+(clone3?|fork|vfork)\s+resumed>(.*)\s+=\s+(.+?)\s*$")
PROCESS_CREATE_RESULT = re.compile(r"^(\d+)(?:<[^>]*>)?(?:\s|$)")
PROCESS_CREATE_FAILURE = re.compile(r"^(?:\?\s+ERESTART[A-Z0-9_]*|-1\s+[A-Z][A-Z0-9_]*)\b")
PIDFD_CLONE_RESULT = re.compile(r"\b(?:parent_tid|pidfd)=\[(\d+)\]")
PIDFD_OPEN = re.compile(r"^pidfd_open\(\s*(\d+)\s*,.*\)\s+=\s+(\d+)(?:<[^>]*>)?(?:\s|$)")
FD_CLOSE = re.compile(r"^close\(\s*(\d+)")
FD_DUP = re.compile(r"^dup\(\s*(\d+)\s*\)\s+=\s+(\d+)(?:<[^>]*>)?(?:\s|$)")
FD_DUP2 = re.compile(r"^dup2\(\s*(\d+)\s*,\s*(\d+)\s*\)\s+=\s+\d+(?:<[^>]*>)?(?:\s|$)")
FD_DUP3 = re.compile(r"^dup3\(\s*(\d+)\s*,\s*(\d+)\s*,.*\)\s+=\s+\d+(?:\s|$)")
FD_FCNTL_DUP = re.compile(r"^fcntl\(\s*(\d+)\s*,\s*F_DUPFD(?:_CLOEXEC)?\s*,.*\)\s+=\s+(\d+)(?:<[^>]*>)?(?:\s|$)")
SIGNAL_NAMES = ("kill", "tkill", "tgkill", "pidfd_send_signal", "rt_sigqueueinfo", "rt_tgsigqueueinfo")
# A stale fd-to-PID entry could bless a later signal after descriptor reuse.
TRACE_SYSCALLS = (
    *SIGNAL_NAMES,
    "pidfd_open",
    "close",
    "dup",
    "dup2",
    "dup3",
    "fcntl",
    "process",
)
SIGNAL_MENTION = re.compile(r"^\s*(?:" + "|".join(SIGNAL_NAMES) + r")\s*\(")
SIGNAL_RESUME = re.compile(r"^\s*<\.\.\.\s+(" + "|".join(SIGNAL_NAMES) + r")\s+resumed>")
KILL_TARGET = re.compile(r"^kill\(\s*(-?\d+)\s*,")
TKILL_TARGET = re.compile(r"^tkill\(\s*(-?\d+)\s*,")
TGKILL_TARGET = re.compile(r"^(?:tgkill|rt_tgsigqueueinfo)\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,")
PID_SIGNAL_TARGET = re.compile(r"^(?:rt_sigqueueinfo)\(\s*(-?\d+)\s*,")
PIDFD_SIGNAL_TARGET = re.compile(r"^pidfd_send_signal\(\s*(\d+)\s*,")
UNKNOWN_PID_NOTICE = re.compile(r"(?i)\bunknown\s+pid\s*[#:=]?\s*(\d+)\b")
PROCESS_PID_NOTICE = re.compile(r"(?i)\bprocess\s+(\d+)\s+(?:attached|detached)\b")


@dataclass(frozen=True)
class SignalCall:
    syscall: str
    targets: tuple[int, ...] | None
    line: str


@dataclass(frozen=True)
class TraceData:
    traced_pids: frozenset[int]
    created_pids: frozenset[int]
    signals: tuple[SignalCall, ...]


def parse_trace(path: Path) -> TraceData:
    traced: set[int] = set()
    created: set[int] = set()
    signals: list[SignalCall] = []
    pidfds: dict[tuple[int, int], int] = {}
    pending_signals: dict[tuple[int, str], SignalCall] = {}
    pending_creations: set[tuple[int, str]] = set()
    pending_pidfd_creations: set[tuple[int, str]] = set()
    malformed: list[str] = []

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = PID_PREFIX.match(line)
        if match is None:
            if SIGNAL_MENTION.search(line) or SIGNAL_RESUME.search(line):
                malformed.append(line)
            continue

        caller_pid = int(match.group(1) or match.group(2))
        body = match.group(3)
        traced.add(caller_pid)

        signal_resume = SIGNAL_RESUME.match(body)
        if signal_resume is not None:
            name = signal_resume.group(1)
            pending = pending_signals.pop((caller_pid, name), None)
            if pending is None:
                malformed.append(line)
            else:
                signals.append(pending)
            continue

        process_resume = PROCESS_CREATE_RESUME.match(body)
        if process_resume is not None:
            name = process_resume.group(1)
            key = (caller_pid, name)
            if key not in pending_creations:
                malformed.append(line)
            else:
                pending_creations.remove(key)
                result = process_resume.group(3)
                child_match = PROCESS_CREATE_RESULT.match(result)
                if child_match is None:
                    if PROCESS_CREATE_FAILURE.match(result):
                        pending_pidfd_creations.discard(key)
                        continue
                    malformed.append(line)
                    continue
                child_pid = int(child_match.group(1))
                if child_pid > 0:
                    created.add(child_pid)
                if key in pending_pidfd_creations:
                    pending_pidfd_creations.remove(key)
                    fd_match = PIDFD_CLONE_RESULT.search(process_resume.group(2))
                    if fd_match is None or child_pid <= 0:
                        malformed.append(line)
                    else:
                        pidfds[(caller_pid, int(fd_match.group(1)))] = child_pid
            continue

        if "<unfinished ...>" in body:
            signal_match = SIGNAL_MENTION.match(body)
            if signal_match is not None:
                parsed = parse_signal_call(caller_pid, body, line, pidfds)
                if parsed is None:
                    malformed.append(line)
                else:
                    pending_signals[(caller_pid, parsed.syscall)] = parsed
            process_match = PROCESS_CREATE_START.match(body)
            if process_match is not None:
                name = process_match.group(1)
                pending_creations.add((caller_pid, name))
                if name.startswith("clone") and "CLONE_PIDFD" in body:
                    pending_pidfd_creations.add((caller_pid, name))
            continue

        child_match = PROCESS_CREATE.match(body)
        if child_match is not None:
            child_pid = int(child_match.group(2))
            if child_pid > 0:
                created.add(child_pid)
            if child_match.group(1).startswith("clone") and "CLONE_PIDFD" in body:
                fd_match = PIDFD_CLONE_RESULT.search(body)
                if fd_match is None or child_pid <= 0:
                    malformed.append(line)
                else:
                    pidfds[(caller_pid, int(fd_match.group(1)))] = child_pid

        pidfd_match = PIDFD_OPEN.match(body)
        if pidfd_match is not None:
            pidfds[(caller_pid, int(pidfd_match.group(2)))] = int(pidfd_match.group(1))
        else:
            close_match = FD_CLOSE.match(body)
            if close_match is not None:
                pidfds.pop((caller_pid, int(close_match.group(1))), None)
            else:
                dup_match = FD_DUP.match(body) or FD_FCNTL_DUP.match(body)
                if dup_match is not None:
                    source_fd, duplicate_fd = map(int, dup_match.groups())
                    target = pidfds.get((caller_pid, source_fd))
                    if target is not None:
                        pidfds[(caller_pid, duplicate_fd)] = target
                else:
                    dup_match = FD_DUP2.match(body) or FD_DUP3.match(body)
                    if dup_match is not None:
                        source_fd, duplicate_fd = map(int, dup_match.groups())
                        target = pidfds.get((caller_pid, source_fd))
                        pidfds.pop((caller_pid, duplicate_fd), None)
                        if target is not None:
                            pidfds[(caller_pid, duplicate_fd)] = target

        if not SIGNAL_MENTION.match(body):
            continue

        parsed = parse_signal_call(caller_pid, body, line, pidfds)
        if parsed is None:
            malformed.append(line)
        else:
            signals.append(parsed)

    if pending_signals:
        malformed.append(pending_signals[next(iter(pending_signals))].line)
    if pending_creations:
        malformed.append(f"unfinished process-creation syscall: {next(iter(pending_creations))}")
    if malformed:
        raise ValueError("could not parse a signal syscall trace row: " + malformed[0])
    if not traced:
        raise ValueError("strace output contained no identifiable traced process IDs")
    return TraceData(frozenset(traced), frozenset(created), tuple(signals))


def parse_signal_call(
    caller_pid: int,
    body: str,
    line: str,
    pidfds: dict[tuple[int, int], int],
) -> SignalCall | None:
    if body.startswith("kill("):
        target_match = KILL_TARGET.match(body)
        return SignalCall("kill", (int(target_match.group(1)),) if target_match else None, line)
    if body.startswith("tkill("):
        target_match = TKILL_TARGET.match(body)
        return SignalCall("tkill", (int(target_match.group(1)),) if target_match else None, line)
    if body.startswith("tgkill("):
        target_match = TGKILL_TARGET.match(body)
        return SignalCall("tgkill", tuple(map(int, target_match.groups())) if target_match else None, line)
    if body.startswith("rt_tgsigqueueinfo("):
        target_match = TGKILL_TARGET.match(body)
        return SignalCall("rt_tgsigqueueinfo", tuple(map(int, target_match.groups())) if target_match else None, line)
    if body.startswith("rt_sigqueueinfo("):
        target_match = PID_SIGNAL_TARGET.match(body)
        return SignalCall("rt_sigqueueinfo", (int(target_match.group(1)),) if target_match else None, line)
    if body.startswith("pidfd_send_signal("):
        target_match = PIDFD_SIGNAL_TARGET.match(body)
        target_pid = pidfds.get((caller_pid, int(target_match.group(1)))) if target_match else None
        return SignalCall("pidfd_send_signal", (target_pid,) if target_pid is not None else None, line)
    return None


def unsafe_targets(observed: set[int] | frozenset[int], signals: list[SignalCall] | tuple[SignalCall, ...]) -> list[str]:
    failures: list[str] = []
    for call in signals:
        if call.targets is None:
            failures.append(f"unresolved {call.syscall} target: {call.line}")
            continue
        if call.syscall == "kill":
            target = call.targets[0]
            if target in (0, -1):
                failures.append(f"unconditionally forbidden target {target}: {call.line}")
            elif target == 1:
                failures.append(f"forbidden namespace init target 1: {call.line}")
            elif target > 1 and target not in observed:
                failures.append(f"PID {target} was not observed by strace: {call.line}")
            elif target < -1 and -target not in observed:
                failures.append(f"process-group leader PID {-target} was not observed by strace: {call.line}")
            continue
        for target in call.targets:
            if target <= 1:
                failures.append(f"forbidden {call.syscall} target {target}: {call.line}")
            elif target not in observed:
                failures.append(f"PID {target} was not observed by strace: {call.line}")
    return failures


def trace_coverage_failures(trace: TraceData, stderr: str) -> list[str]:
    failures = [
        f"created PID {pid} never appeared as a traced process"
        for pid in sorted(trace.created_pids - trace.traced_pids)
    ]
    for line in stderr.splitlines():
        unknown = UNKNOWN_PID_NOTICE.search(line)
        process_notice = PROCESS_PID_NOTICE.search(line)
        if "unknown pid" in line.lower() and unknown is None:
            failures.append(f"could not parse strace unknown-pid warning: {line}")
            continue
        match = unknown or process_notice
        if match is not None:
            pid = int(match.group(1))
            if pid not in trace.traced_pids:
                failures.append(f"strace warning PID {pid} never appeared as a traced process: {line}")
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

    scratch = Path(tempfile.mkdtemp(prefix="kaoiro-kill-trace-"))
    os.chmod(scratch, 0o700)
    trace_path = scratch / "strace.log"
    preserve_trace = False
    command = [
        "unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc",
        "setsid", "-w", "strace", "-f", "-e",
        "trace=" + ",".join(TRACE_SYSCALLS),
        "-o", str(trace_path), "--", "setsid", "-w", *argv,
    ]

    try:
        completed = subprocess.run(command, check=False, stderr=subprocess.PIPE, text=True)
        if completed.stderr:
            sys.stderr.write(completed.stderr)
        if not trace_path.is_file():
            print(f"trace gate: strace did not produce its trace (command exit {completed.returncode})", file=sys.stderr)
            return 1
        trace = parse_trace(trace_path)
        failures = unsafe_targets(trace.traced_pids, trace.signals)
        failures.extend(trace_coverage_failures(trace, completed.stderr))
        print(f"trace gate: traced_processes={len(trace.traced_pids)} signal_syscalls={len(trace.signals)}")
        for failure in failures:
            print(f"trace gate: REJECT {failure}", file=sys.stderr)
        if failures:
            preserve_trace = True
            print(f"trace gate: trace retained at {trace_path}", file=sys.stderr)
            return 1
        if completed.returncode != 0:
            preserve_trace = True
            print(f"trace gate: command failed with exit {completed.returncode}", file=sys.stderr)
            print(f"trace gate: trace retained at {trace_path}", file=sys.stderr)
            return completed.returncode if completed.returncode > 0 else 1
        print("trace gate: PASS; each signal target was an observed PID or process-group leader")
        return 0
    except (OSError, ValueError) as error:
        preserve_trace = True
        print(f"trace gate: FAIL CLOSED: {error}", file=sys.stderr)
        print(f"trace gate: trace retained at {trace_path}", file=sys.stderr)
        return 1
    finally:
        if not preserve_trace:
            shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
