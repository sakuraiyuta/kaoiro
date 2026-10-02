from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GATE_PATH = ROOT / "scripts" / "antigravity-kill-trace-gate.py"
SPEC = importlib.util.spec_from_file_location("antigravity_kill_trace_gate", GATE_PATH)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)


class TraceGateParserTests(unittest.TestCase):
    def parse(self, body: str) -> gate.TraceData:
        with tempfile.TemporaryDirectory(prefix="momo490-trace-fixture-") as root:
            path = Path(root) / "trace.log"
            path.write_text(body, encoding="utf-8")
            return gate.parse_trace(path)

    def test_parses_signal_syscalls_and_known_pidfd(self) -> None:
        trace = self.parse(
            """100 kill(101, SIGTERM) = 0
100 tkill(100, SIGURG) = 0
100 tgkill(100, 101, SIGTERM) = 0
100 rt_sigqueueinfo(101, SIGTERM, NULL) = 0
100 rt_tgsigqueueinfo(100, 101, SIGTERM, NULL) = 0
100 pidfd_open(101, 0) = 7
100 pidfd_send_signal(7, SIGTERM, NULL, 0) = 0
100 clone(child_stack=NULL, flags=SIGCHLD) = 101
101 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.traced_pids, frozenset({100, 101}))
        self.assertEqual(trace.created_pids, frozenset({101}))
        self.assertEqual([call.syscall for call in trace.signals], [
            "kill", "tkill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo", "pidfd_send_signal",
        ])
        self.assertEqual(trace.signals[-1].targets, (101,))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_trace_selector_covers_pidfd_descriptor_lifetime(self) -> None:
        self.assertTrue({"close", "dup", "dup2", "dup3", "fcntl"}.issubset(gate.TRACE_SYSCALLS))

    def test_tracks_pidfd_through_duplicate_and_close(self) -> None:
        trace = self.parse(
            """100 pidfd_open(101, 0) = 7
100 dup(7) = 8
100 close(7) = 0
100 fcntl(8, F_DUPFD_CLOEXEC, 10) = 10
100 dup2(10, 8) = 8
100 pidfd_send_signal(8, SIGTERM, NULL, 0) = 0
101 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.signals[0].targets, (101,))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_failed_close_invalidates_pidfd_mapping_conservatively(self) -> None:
        trace = self.parse(
            """100 pidfd_open(101, 0) = 7
100 close(7) = -1 EINTR (Interrupted system call)
100 pidfd_send_signal(7, SIGTERM, NULL, 0) = 0
"""
        )
        self.assertIsNone(trace.signals[0].targets)
        self.assertIn("unresolved pidfd_send_signal target", gate.unsafe_targets(trace.traced_pids, trace.signals)[0])

    def test_resolves_pidfd_returned_by_clone3(self) -> None:
        trace = self.parse(
            """4 clone3({flags=CLONE_PIDFD, pidfd=0x7ffc7492b86c, exit_signal=SIGCHLD, stack=NULL, stack_size=0} => {pidfd=[3]}, 88) = 5
4 pidfd_send_signal(3, SIGTERM, NULL, 0) = 0
5 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.created_pids, frozenset({5}))
        self.assertEqual(trace.signals[0].targets, (5,))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_resolves_pidfd_returned_by_unfinished_clone3(self) -> None:
        trace = self.parse(
            """4 clone3({flags=CLONE_PIDFD, pidfd=0x7ffc7492b86c, exit_signal=SIGCHLD, stack=NULL, stack_size=0}, 88 <unfinished ...>
4 <... clone3 resumed> => {pidfd=[3]}, 88) = 5
4 pidfd_send_signal(3, SIGTERM, NULL, 0) = 0
5 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.created_pids, frozenset({5}))
        self.assertEqual(trace.signals[0].targets, (5,))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_unmapped_pidfd_fails_closed(self) -> None:
        trace = self.parse("100 pidfd_send_signal(7, SIGTERM, NULL, 0) = 0\n")
        self.assertEqual(trace.signals[0].targets, None)
        self.assertIn("unresolved pidfd_send_signal target", gate.unsafe_targets(trace.traced_pids, trace.signals)[0])

    def test_resolves_pidfd_returned_by_clone(self) -> None:
        trace = self.parse(
            """100 clone(child_stack=NULL, flags=CLONE_PIDFD|SIGCHLD <unfinished ...>
100 <... clone resumed>, parent_tid=[7]) = 101
100 pidfd_send_signal(7, SIGTERM, NULL, 0) = 0
101 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.traced_pids, frozenset({100, 101}))
        self.assertEqual(trace.signals[0].targets, (101,))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_unparseable_clone_pidfd_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "signal syscall trace row"):
            self.parse(
                """100 clone(child_stack=NULL, flags=CLONE_PIDFD|SIGCHLD <unfinished ...>
100 <... clone resumed>, parent_tid=0x7ffd) = 101
"""
            )

    def test_pairs_normal_unfinished_signal_and_process_creation_rows(self) -> None:
        trace = self.parse(
            """100 tgkill(100, 101, SIGURG <unfinished ...>
100 <... tgkill resumed>) = 0
100 clone(child_stack=NULL, flags=CLONE_VM <unfinished ...>
100 <... clone resumed>, tls=0x0) = 101
101 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.traced_pids, frozenset({100, 101}))
        self.assertEqual(trace.created_pids, frozenset({101}))
        self.assertEqual(trace.signals[0].targets, (100, 101))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_completed_restarted_clone_is_not_left_pending(self) -> None:
        trace = self.parse(
            """1451 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x709e3da44a10 <unfinished ...>
1451 <... clone resumed>, child_tidptr=0x709e3da44a10) = ? ERESTARTNOINTR (To be restarted)
1451 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x709e3da44a10) = 1458
1458 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.created_pids, frozenset({1458}))
        self.assertEqual(gate.unsafe_targets(trace.traced_pids, trace.signals), [])

    def test_completed_failed_fork_resume_does_not_create_a_pid(self) -> None:
        trace = self.parse(
            """100 fork( <unfinished ...>
100 <... fork resumed>) = -1 EAGAIN (Resource temporarily unavailable)
100 fork() = 101
101 exit_group(0) = ?
"""
        )
        self.assertEqual(trace.created_pids, frozenset({101}))

    def test_failed_process_creation_resumes_cover_all_creation_syscalls(self) -> None:
        for name in ("clone", "clone3", "fork", "vfork"):
            with self.subTest(syscall=name):
                trace = self.parse(
                    f"""100 {name}(<unfinished ...>
100 <... {name} resumed>) = -1 EINTR (Interrupted system call)
"""
                )
                self.assertEqual(trace.created_pids, frozenset())
                self.assertEqual(trace.traced_pids, frozenset({100}))

    def test_rejects_each_forbidden_kill_target(self) -> None:
        cases = [
            (0, "unconditionally forbidden target 0"),
            (-1, "unconditionally forbidden target -1"),
            (1, "forbidden namespace init target 1"),
            (999, "PID 999 was not observed"),
            (-999, "process-group leader PID 999 was not observed"),
        ]
        for target, expected in cases:
            with self.subTest(target=target):
                call = gate.SignalCall("kill", (target,), f"100 kill({target}, SIGTERM) = 0")
                failures = gate.unsafe_targets({100}, [call])
                self.assertTrue(any(expected in failure for failure in failures), failures)

    def test_accepts_observed_pid_and_process_group(self) -> None:
        calls = [
            gate.SignalCall("kill", (100,), "100 kill(100, SIGTERM) = 0"),
            gate.SignalCall("kill", (-101,), "100 kill(-101, SIGTERM) = 0"),
        ]
        self.assertEqual(gate.unsafe_targets({100, 101}, calls), [])

    def test_rejects_unfinished_and_unparseable_signal_rows(self) -> None:
        malformed_rows = [
            "100 kill(101, SIGTERM <unfinished ...>\n",
            "100 <... kill resumed>) = 0\n",
            "kill(101, SIGTERM) = 0\n",
        ]
        for row in malformed_rows:
            with self.subTest(row=row):
                with self.assertRaisesRegex(ValueError, "signal syscall trace row"):
                    self.parse(row)

    def test_checks_child_creation_and_strace_pid_warnings_against_rows(self) -> None:
        trace = gate.TraceData(frozenset({100}), frozenset({101}), ())
        failures = gate.trace_coverage_failures(trace, "strace: Process 102 detached\nstrace: unknown pid 103\n")
        self.assertEqual(len(failures), 3)
        self.assertTrue(any("created PID 101" in failure for failure in failures))
        self.assertTrue(any("warning PID 102" in failure for failure in failures))
        self.assertTrue(any("warning PID 103" in failure for failure in failures))

    def test_rejects_unknown_pid_warning_without_a_parsable_pid(self) -> None:
        trace = gate.TraceData(frozenset({100}), frozenset(), ())
        failures = gate.trace_coverage_failures(trace, "strace: unknown pid was dropped\n")
        self.assertEqual(len(failures), 1)
        self.assertIn("could not parse", failures[0])


class TraceGateLiveControlTests(unittest.TestCase):
    def test_kill_zero_is_rejected_inside_the_isolated_process_group(self) -> None:
        command = [
            str(GATE_PATH), "--", sys.executable, "-c",
            "import os, signal; os.kill(0, signal.SIGTERM)",
        ]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        try:
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("REJECT unconditionally forbidden target 0", result.stderr)
        finally:
            match = re.search(r"trace retained at (.+/strace\.log)", result.stderr)
            if match is not None:
                shutil.rmtree(Path(match.group(1)).parent, ignore_errors=True)

    def test_nonexistent_pid_signal_zero_is_rejected_by_live_trace(self) -> None:
        missing_pid = 1 << 30
        command = [
            str(GATE_PATH), "--", sys.executable, "-c",
            f"import os; os.kill({missing_pid}, 0)",
        ]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        try:
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn(f"REJECT PID {missing_pid} was not observed by strace", result.stderr)
        finally:
            match = re.search(r"trace retained at (.+/strace\.log)", result.stderr)
            if match is not None:
                shutil.rmtree(Path(match.group(1)).parent, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
