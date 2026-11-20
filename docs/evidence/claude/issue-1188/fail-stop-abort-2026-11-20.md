---
title: Claude admission fail-stop abort
status: measured
last_updated: 2026-11-20
description: Measurements behind aborting the Claude CLI on an admission or receipt-timeout fail-stop — what keeps the CLI alive after its input closes, the abort's timing and losses, and the runner relaunch that follows.
---

# Claude admission fail-stop abort

[Issue #1188](https://github.com/sakuraiyuta/kaoiro/issues/1188): after an
admission fail-stop the Claude wrapper closed the CLI's input but did not
abort it, so a background task kept the CLI and the wrapper alive and the
runner never relaunched it. The change aborts the SDK in
`AgentHost#failStopAdmission` for every fail-stop except the turn watchdog's.
The resulting contract is in
[Claude fail-stop recovery](../../../reference/engines/claude-events.md#recovering-a-fail-stopped-claude-wrapper).

## Setup

- Base `c2844a45` on `develop`; `@anthropic-ai/claude-agent-sdk` 0.3.327 with
  its bundled CLI 2.1.327; Linux.
- Real `AgentHost` or a real wrapper process, real SDK `query()` and the real
  bundled CLI. Only the Anthropic API was a loopback fixture, so no model
  quota was used. The runner measurements started the real runner entry
  (`runner/dist/kaoiro.js runner`), which launched the real wrapper entry; both
  talked to loopback server channels.
- Fail-stop triggers. `/clear` sent to the host makes the CLI switch sessions
  under a live wrapper turn, and the host fails admission at the result with
  `notification result ownership ambiguous`. The server rejects `/clear` from
  operators, so this is only a test trigger. The second trigger is the
  `starved` scenario of `compact_resume_native.test.ts`, whose resume-receipt
  wait was cut to 200 ms (the production default is the watchdog's 30 min).
- Before the change existed, throwaway prototypes placed the same abort at
  the end of `#failStopAdmission` and added observation-only log lines; the
  base runs used the same build with the abort disabled. The prototypes are
  not kept in the repository. Each scenario ran 2 to 4 times in an isolated
  container.
- Times are relative to the fail-stop, or to the abort where stated.

## What keeps the CLI alive without the abort

| Scenario (runs) | Observation |
|---|---|
| Background Bash, 20 s (4) | The SDK closed the CLI's input within 1 ms. The CLI stayed until the Bash ended and exited at +20.04 to +20.15 s, code 0. |
| `/clear` over a background Bash, 60 s (2) | The CLI, the recorded shell and its `sleep` were still running at the end of the 15 s window. This is the issue's symptom. |
| Background subagent (2) | The SDK did not close the input; the subagent's and the notification turn's tools ran, and the CLI exited at +8.19 to +8.20 s. The SDK's wait is `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (600000 by default in its bundle, re-armed on non-idle states, unlimited at 0). |
| After the input closed (Bash 7, Read 2, Write 2) | New calls were refused with "The user doesn't want to take this action right now"; text and commands already running continued. |
| `starved` wrapper process (4) | Still running 20 s after `error`; a persistent Monitor task holds the CLI. |

## Abort

| Scenario (runs) | Observation |
|---|---|
| No background task (`/clear`, 2; earlier variants, 8) | The CLI exited 28 to 49 ms after the abort with code 0 and no kill. |
| Background Bash (`/clear`, 2) | `SIGTERM` at +2.00 s after the abort; the CLI exited at +2.13 to +2.15 s with code 143. The recorded shell and `sleep` were gone by +2.28 s. |
| Background subagent (`/clear`, 2) | `SIGTERM` at +2.00 s; exit at +2.03 to +2.31 s, code 143; the subagent's tools did not run. |
| CLI stopped with `SIGSTOP` before the `SIGTERM` (2) | The wrapper's `SIGKILL` attempt at +4.00 s; the CLI died at +4.02 to +4.03 s; `host.run()` had resolved at +2.00 s. The background shell and `sleep` survived. |
| Turn in flight at the fail-stop (2) | Its result arrived at +1.97 s, before the `SIGTERM`. Nothing guarantees this. |
| CLI exiting 1 after the abort (2 per path) | The SDK rejected with `AbortError`; the host resolved and `runClaudeCli` reported `stop`, with no stderr-tail warning. Without the abort the same crash rejected and was reported as `crash`. |
| Resume of a session ended by the abort or by the SDK's wait limit (6) | The first model request of the next input carried `<status>stopped</status>` for the Bash command or subagent; the host did not fail-stop. Monitor tasks were not measured. |
| `starved` wrapper process (4) | Exit code 0 at +2.32 to +2.34 s after `error`. |

## Runner relaunch

The real runner received one `spawn`, launched the wrapper, and relaunched it
after the exit. "Input result" is the result of an operator input sent 1.5 s
after the new wrapper's first state.

| Scenario (runs) | Wrapper exit | Checkpoint read by the runner | Relaunch | New wrapper connected | Input result |
|---|---|---|---|---|---|
| `/clear` over a background Bash, 120 s, abort (2) | +2.329 to +2.330 s, code 0 | `unbound`, candidate = the session after `/clear` | +2.337 to +2.340 s, candidate resume, restarts 0 → 1 | +2.871 to +2.912 s | +4.943 to +4.965 s |
| `starved`, abort (2) | +2.329 to +2.330 s, code 0 | `live`, the same session | +2.337 s, strict resume, restarts 0 → 1 | +2.861 to +2.876 s | +4.806 to +4.832 s; the request carried the compacted history of that session |
| Both scenarios without the abort (2 each) | none in a 30 s window | — | none | — | — |

Without the abort the background shell, `sleep` or Monitor process was still
running at the end of the window; with it, each was gone. Across the full
runner and wrapper output of all 8 runs, `recovery refused`,
`exceeded restart cap`, `relaunch failed`, `recovery session already owned`
and `wrapper recovery stopped` occur 0 times; `runner: registered` occurs once
per run.

## Committed tests

`wrapper/claude-code/test/admission_fail_stop_abort_native.test.ts` re-measures
the `/clear` cases with the real CLI on every CI run: the CLI ends without a
background task, the CLI and its background Bash end, and a resumed session
receives the `stopped` notification. `compact_resume_native.test.ts` asserts
that the `starved` wrapper process exits with code 0 in both ownership modes.
The 6 s limit in these tests turns a hang red; it is not a latency claim.
In the first CI run on commit `9acbeb30`
([run 44691508512](https://github.com/sakuraiyuta/kaoiro/actions/runs/44691508512),
`wrapper` job), the new native file took 12,447 ms for its 3 tests and the
whole `compact_resume_native.test.ts` file 176,723 ms for its 15 tests; the
share added by the `starved` assertion was not measured separately.
Unit tests in `foreign_root_occupancy.test.ts` and `host.test.ts` pin which
fail-stops abort and the `AbortError` handling.

## Limits

- The prompt-ambiguity entry of the result path was not reproduced with the
  real CLI; it reaches the same `#failStopLive` as the `/clear` case.
- The receipt-timeout fail-stop of a pushed input was not reproduced with the
  real CLI; it reaches `#failStopAdmission` through a different path, which
  the unit test pins.
- The server was a loopback fixture, and the production resume-receipt wait
  was not exercised.
- The runner's refusal conditions, its restart cap and the fallback from a
  failed candidate resume to a fresh session were read in the source, not
  exercised.
- After a `SIGKILL`, the wrapper's exit and the relaunch were not measured.
  Descendants in other process groups were not observed.
- The CLI's own limit on background commands was not measured.
