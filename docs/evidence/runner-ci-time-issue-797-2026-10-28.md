---
title: Runner CI time and the fixture's fake service manager
description: Where the runner job's time went after issue 709 N2/N3, the shell front that removed most of it, and how its equality with the Node script was checked.
status: accepted
last_updated: 2026-10-28
related: [runner-development, test-isolation]
---

# Runner CI time and the fixture's fake service manager

Measured on 2026-10-28 for
[issue #797](https://github.com/sakuraiyuta/kaoiro/issues/797), on develop
`5a0d8949` (before) and on the branch of the change (after), in CI and in
disposable 3-CPU test containers (Node 22, Vitest 2.1.9, dependencies installed
with `pnpm install --frozen-lockfile`, wrapper and runner built first). The
change is `runner/test/codexStateSystemctlFront.sh`, written by
`runner/test/codexStateFixture.ts`, and `runner/test/codexStateFixtureSystemctl.test.ts`.

## Before and after

| | `runner` job | Vitest `Duration` | Sum of test times |
|---|---:|---:|---:|
| Before (CI run 40612206196) | 1268 s | 1212.59 s | 3296.92 s |
| After (draft PR CI run 40624512227) | 473 s | 432.07 s | 1220.86 s |

| File | Tests | Before | After |
|---|---:|---:|---:|
| `codexStateWorkflow.test.ts` | 214 | 1211.6 s | 431.1 s |
| `codexStateRecovery.test.ts` | 60 | 1122.9 s | 273.6 s |
| `codexStateRecoveryRestore.test.ts` | 24 | 325.4 s | 78.3 s |
| `codexStateRecoveryForward.test.ts` | 25 | 198.1 s | 60.9 s |
| `codexStateKeepSafety.test.ts` | 22 | 125.9 s | 82.3 s |
| `codexStateRecoveryRefusals.test.ts` | 47 | 124.6 s | 38.4 s |
| `codexStateFixtureSystemctl.test.ts` (new) | 5 | | 71.5 s |

Test counts of the six existing files are unchanged. Vitest 2.1.9 starts
`max(CPUs - 1, 1)` workers, so the 4-vCPU runner uses three: 3296.92 s of test
time over three workers is about 1100 s, which is why splitting files could not
have been enough and the work itself had to shrink.

## Where the time went

A process-level profile (all processes sampled every 4 ms; the sampling cost is
in both columns of the comparison) of one `kaoiro-runner-update.sh` forward run
and one restore run, on the unmodified fixture:

| Run | Processes | Fake `systemctl` starts | CPU ticks of those starts | Total CPU ticks |
|---|---:|---:|---:|---:|
| forward | 178 | 119 | 388 | 693 |
| restore | 199 | 143 | 480 | 832 |

The product asks the service manager one property at a time, and the fixture
answers each question with a Node script. The runs are CPU-bound. With a shell
front for the read-only queries a forward run took 1725 ms instead of 7085 ms
and a restore run 1757 ms instead of 8673 ms in the same profiler.

## How equality with the Node script was checked

All of the following ran in the disposable containers; none replaces the CI run.

1. **Differential test (committed).** The front and the script answer the argv
   recorded from a real forward and restore, and the forms the front's
   specification decides, in 14 states: 48 argument lists, 672 comparisons of
   exit status, stdout, first stderr line, `queries` and `activity-count`; 0
   differences. A second set of tests pins which calls the front answers itself
   and which it hands to the script before any side effect.
2. **Shadow run (not committed).** A build in which the front also ran the script
   on every call it answered and compared the output compared 47,668 answers
   across the Workflow, Recovery, KeepSafety, Forward, Restore and Refusals
   suites (206 + 103 + 111 tests run; all passed) with 0 differences. The
   Workflow file first ran as one chunk and hit the 20-minute container limit
   (exit 124); it was rerun in two chunks.
3. **Whole runner suite.** 73 files, 1799 tests, all passed (Vitest `Duration`
   576.93 s with two workers); the CI run above agrees.
4. **Product mutants.** Ten one-line changes to `runner/deploy` were run on the
   branch. Six (C1, C3, C4, C5, C6, C7: the `ActiveState`, `MainPID`,
   `ControlGroup`, `Transient` and `RootImage` checks) were killed; four (C2 `pid > 0`,
   C8 the `ExecStart` prefix check, N1 the `assertReplacementDaemonsAbsent` call in
   `guard`, N2 the daemon-lock `BUSY` check) were not killed on the branch (nor by the develop runs of the five files named
   below), so they are not evidence. For KeepSafety, Forward, Refusals, Restore and the
   recovery table (146 tests) all ten mutants and the unmutated tree were run on
   develop and on the branch: the failing tests and the first line of every
   failure message are identical. For the three mutants that fail Workflow tests
   (C3, C4, C5) the whole Workflow file was also run on develop: identical. The
   Recovery file was not run against mutants on develop, and the Workflow file
   was not run on develop for the other seven mutants.
5. **Negative controls.** Nine defects put into the front (a changed `KillMode`
   answer, no trailing-newline rule for `active`, accepting pid 0, matching
   `*show*` by substring, no `stop`/`start` delegation, echoing the caller's
   `HOME`, no pristine check, no stderr silence on `cmp`, always delegating) each
   failed at least one of the new tests. Without the pristine check, 5 of 30
   Workflow tests that rewrite the fake fail (none on the unmodified branch). A
   guard that was first written, `command -v cmp`, was not detected when
   removed, because a failed `cmp` already hands the call over; it was removed
   and the missing silence on stderr is what the test pins instead.

## Limits

- The CI figure is one run of the draft PR. The acceptance in the issue also
  needs the first two develop CI runs after landing.
- The new test takes about 70 s in CI.
- Tests that rewrite the fake still pay the Node start on every later call,
  by design; their number was not counted.
- Not shown: that no test depends on the elapsed time between fake calls, beyond
  the shadow run and the identical pass sets.
