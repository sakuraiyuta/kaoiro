# cli_sigterm_process_exit: 143 under the tsx CLI relay (issue 550), 2026-10-08

Frozen record. Base `a466f77d` (origin/develop). Fix commit `0de9c43b` on
branch `issue-550-sigterm-readiness`. Host: 4 cores, shared with other agents.

## Question

The first test in `wrapper/claude-code/test/cli_sigterm_process_exit.test.ts`
failed with exit 143 (expected 0) in two full runs, while the wrapper had its
SIGTERM handler. Is the cause a SIGTERM that arrives before the handler, or
something else?

## Answer (by experiment, not by load)

The 143 comes from the tsx CLI that the test used as its spawn target, not
from the wrapper. tsx 4.22.4 (`dist/cli.mjs`, `relaySignals`) relays SIGTERM
to its child with a 30 ms window for the child's IPC signal report, twice; on
no report it sends SIGKILL and exits `128 + 15` whatever the child would have
exited with. The child-side hidden handler (`dist/preflight.mjs`) also exits
`128 + 15` when the app has no SIGTERM listener.

The readiness wait for the fixture pid already implies the wrapper's handler
is installed (`src/cli.ts` installs `onSigterm` before `host.run()`; the SDK
spawns the fixture inside `run()`). It stays, because a SIGTERM before the
handler exits without code 0 (control N2 below).

## Method and results

### Minimal child: delay after SIGTERM (N1 table)

Child (`/tmp`, outside the repo): installs a SIGTERM handler that lets the
loop empty, writes `ready`, then blocks its loop for `BUSY_MS`. The driver
waits for `ready` and then sends SIGTERM to the spawned PID. The block starts
at `ready`, a few ms before the SIGTERM is sent, so the delay after the
signal is `BUSY_MS` minus that latency. Each row is 10 runs of one spawn
mode, counting the exit code.

| BUSY_MS | tsx CLI | node direct |
|---|---|---|
| 0 | code 0 ×10 | code 0 ×10 |
| 20 | code 0 ×10 | code 0 ×10 |
| 60 | code 0 ×10 | code 0 ×10 |
| 150 | code 143 ×10 | code 0 ×10 |

The boundary is therefore a delay of roughly 50 to 60 ms after the parent
receives SIGTERM, consistent with the two 30 ms windows. A separate SIGSTOP
reproduction by a reviewer gave 143 at 60 ms, measured from the signal
instead of from `ready`; the two methods differ in where the count starts.

### Injected pause on the target test (regression control)

The test SIGSTOPs the process that owns SIGTERM for 300 ms right after the
signal, then SIGCONTs it. The PID is the runner's own, published by the
runner script, and checked with `requirePositiveSafePid` before any signal.

| run | spawn | result |
|---|---|---|
| target file, fix (C0) | `node --import <tsx ESM loader>` | `Test Files 1 passed`, `Tests 3 passed (3)` |
| second test only (C2) | tsx CLI | `Tests 1 failed \| 2 skipped (3)`, `expected 143 to be +0` |
| first test only (C1) | tsx CLI | `Tests 1 failed \| 2 skipped (3)`, `expected 143 to be +0` |

Both controls were run on a temporary edit of the spawn line, and the file
was restored from the commit with `git checkout` after each.

### Early SIGTERM (readiness control N2)

SIGTERM sent after the join and before the persona prompt, in a temporary
edit of the first test:

| spawn | exit |
|---|---|
| tsx CLI | `143 null` |
| node direct | `null SIGTERM` |

Both are non-zero, so removing the readiness wait makes the test fail without
load.

### Suite

`setsid -w` around `pnpm exec vitest run` in `wrapper/claude-code`, on
`0de9c43b`: `Test Files 37 passed | 1 skipped (38)`,
`Tests 807 passed | 4 skipped (811)`, exit 0.

## Not measured

- The failure rate under the load that produced the sightings. Sixteen busy
  loops did not reproduce the failure in 8 runs of the target file, and 60
  runs of the minimal child under the same load gave code 0 for both spawns.
  The evidence for the fix is the injected pause, not a load run.
- The dev path. `runner/src/spawn.ts` (`KAOIRO_WRAPPER_DEV`, `tsx watch`,
  lines 65 to 77) runs the wrapper through the tsx CLI, so the same relay
  applies there: a loaded dev runner can see 143 on reset. This record does
  not change the dev path.

## Production path

`runner/src/spawn.ts:79` starts `process.execPath` on the built
`dist/cli.js`, with no tsx in the chain. The fixed test uses plain node with
the tsx ESM loader, so the signal goes straight to the process that owns the
handler.
