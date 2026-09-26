---
title: App-server lifecycle stability
status: in_progress
last_updated: 2026-09-26
---

# Issue #362: app-server lifecycle stability

Status: implementation reviewed, pending landing, 2026-09-26. Baseline: `develop` at `373792da`.
Implementation review owner: Kohaku, dispatched by Kuroe.

## Evidence and attribution

The issue body and all ten comments were read through the GitHub REST API. The
CI job log for run `36173378573` (job `108198053894`) confirms that the
`watchdog interrupt=false` case timed out at the first wait for outbound
`WAITING`, before its later acknowledgement assertions. Run `36172105851`
(job `108193896081`) failed at the same wait. Both runs include issue #408's
`a27ae994`. The CI logs alone do not identify the stalled stage; the controlled
experiment below reproduces the same failed assertion with stage evidence.

| Occurrence | Current explanation | State on `develop` |
| --- | --- | --- |
| 1: `host_app_server.integration`, missing image URL | Original failure remains unattributed. A separate same-host materialize/sweep race was reproduced on 2026-09-18; it is a possible mechanism, not proof for this occurrence. | Stage 5e gave each test run a unique agent ID and diagnostics. The same-host race is still present; see below. |
| 2: `host_app_server.test`, interrupt spy 0 | Explained and fixed at `bfd15418`: the test interrupted before preparation was known to start. The fixed test waits for the permission-sync boundary; its negative control reproduced the failure. | Landed. |
| 3: `cli_app_server_lifecycle.test`, watchdog acknowledgement `[]` | A paused-wire control in unlanded `fd473e4a` forces the local-dispatch/wire-receipt gap. The CI failure matches the assertion, but no CI trace attributes it to that gap. | Still vulnerable because `fd473e4a` has not landed. |
| 4: `cli_app_server_history.integration`, one result envelope instead of two | A paused-wire control in `fd473e4a` forces the local-finalization/wire-receipt gap. The CI failure matches the assertion, but no CI trace attributes it to that gap. | Still vulnerable because `fd473e4a` has not landed. |
| 5: repeat of occurrence 3 on CI | Same assertion and shape; the paused-wire control supports the mechanism, without tracing this CI attempt. | Same as occurrence 3. |
| 6: Kohaku's full codex suite, `watchdog interrupt=false` | This **integration** test uses `runCodexCli` without `createHost` injection. Fresh idle starts issue #408's short-lived account app-server; the first turn opens a second, main app-server using the same `CODEX_HOME`. The separate unit fixture's empty resolver does not apply. The original failure has no stage trace, but the controlled reproduction below shows the same assertion failing when main app-server SQLite initialization fails during overlap. | Active CI-class failure; `fd473e4a` does not change this first wait. |
| Later CI repeats: runs `36172105851` and `36173378573` | Both contain issue #408 and fail at the first outbound wait. Concurrent app-server startup is the leading hypothesis, supported by the controlled reproduction, but the CI logs themselves lack child-stage diagnostics. | These are the active CI blocker. |

The image race remains in the current source. `CodexHost.send` awaits
`materializeLocalImages` (`host.ts:978-980`) independently of the startup
`sweepOrphanLocalImages` call in `run` (`host.ts:1434-1438`). The materializer
registers its directory only after `await mkdtemp` (`upload.ts:149-150`), so a
sweep can list and remove that directory before registration. The 2026-09-18
issue comment records a real-filesystem reproduction and a failing negative
control. The current source has no serialization between these two calls.
This establishes that the product race is not fixed; it does not attribute the
latest `WAITING` timeout to images, since that fixture has no image input.

Local baseline checks in a detached worktree at `373792da`: the full codex
suite passed once normally (806/806, exit 0), once restricted to one CPU
(806/806, exit 0), and the CI-equivalent full wrapper fan-out passed once on
two CPUs (core 267, agent-common 371, Claude Code 514, Antigravity 386 with
two skipped, Codex 806; exit 0). These passes do not erase the CI failures.

### Controlled startup-probe experiment

The integration test was instrumented in a disposable worktree at `373792da`
(`worktrees/fuji-362-probe-exp`, test-file SHA-256
`4defd91edf945ff6029d279e54f8317c703ddfd29684d60ef6c6e36bb40c9a11`).
It records `AppServerRpc` request outcomes, the provider's first HTTP request,
the loopback peer's `WAITING` receipt and the main session's `stderrTail`.
The off mode uses `createHost` only to inject an empty
`startupRateLimitResolver` when `FUJI362_PROBE_OFF=1`; the same `CodexHost`
constructor and all other options, the main app-server, model, provider and
assertions remain real. An initial targeted run passed in each mode. For the
full fan-out, alternate the two commands below five times per mode, numbered
1 through 5; the logs are `/tmp/fuji362-fanout-{on,off}-{1..5}.log`.

```sh
taskset -c 0-3 env FUJI362_PROBE_OFF=0 pnpm -C wrapper test
taskset -c 0-3 env FUJI362_PROBE_OFF=1 pnpm -C wrapper test
```

Times below are milliseconds from test start for the `interrupt=false` case.
The last line gives min / median / max among successful runs only.

| Mode | Exit codes, runs 1–5 | Main `initialize` | `thread/start` | First provider request | `WAITING` received |
| --- | --- | --- | --- | --- | --- |
| Probe on | 1, 0, 0, 0, 0 | fail, 595, 557, 552, 584 | absent, 835, 800, 799, 811 | absent, 998, 944, 940, 964 | absent, 1042, 994, 990, 1017 |
| Probe off | 0, 0, 0, 0, 0 | 618, 627, 571, 600, 622 | 858, 873, 826, 845, 854 | 1028, 1031, 988, 1004, 1004 | 1076, 1069, 1031, 1045, 1045 |
| Probe on, successful distribution | — | 552 / 584 / 595 | 799 / 811 / 835 | 940 / 964 / 998 | 990 / 1017 / 1042 |
| Probe off distribution | — | 571 / 618 / 627 | 826 / 854 / 873 | 988 / 1004 / 1031 | 1031 / 1045 / 1076 |

The failed probe-on run started two RPC children. The main child's
`initialize` failed at 259 ms with `App-server stdout ended`; its stderr says
`failed to initialize sqlite state runtime under` the test's shared
`CODEX_HOME`. The probe child was then closed during failure cleanup. No
`thread/start`, provider request or `WAITING` occurred. Probe-off runs started
one child and all completed. In the four successful probe-on runs, the probe
child instead ended during `initialize` while the main child continued. Thus
the observed failure is a startup collision,
not a normal sequence that merely exceeds the 35-second wait. Five runs per
mode give a small failure-rate sample; the direct child error and paired
on/off result support the mechanism, but the original CI attempts lack the
same stderr capture and are not individually attributed.

## Options and decision

1. Land `fd473e4a` alone. It replaces incidental sleeps and local-event
assumptions with waits at receiving boundaries. It cannot address the first
`WAITING` timeout, and leaves the image race open.
2. Increase timeouts or remove the real CLI composition. This would hide a
missing event or lower coverage and conflicts with the issue's acceptance
criteria.
3. Reuse the event-boundary changes from `fd473e4a`, serialize the image
   operations, and prevent concurrent startup-probe and main app-server child
   initialization within one Host, for either backend. This is the selected approach. Keep
   failure-stage diagnostics so a distinct later failure remains diagnosable.
4. If all child stages succeed but fan-out pushes the total past the test's
   budget, move real-CLI integration files into a separate Vitest project with
   `fileParallelism: false` while leaving their assertions and timeouts intact.
   Use this only if stage timings support it; the current reproduction does not.

Start a fresh `issue-362-*` branch from current `develop`. Cherry-pick
`fd473e4a` without rewriting it, then resolve the one known conflict in
`test/fixtures/cli_app_server.ts` against the current fixture. Review the
resulting diff rather than assuming the old commit applies unchanged. Keep
the two old worktrees untouched until the new branch is verified, then remove
the worktrees created for this issue.

For the image path, add one per-Host promise chain shared by the entire startup
sweep and the materialize-to-active-set-registration segment of `send`.
Operations enter it in invocation order. A rejected operation propagates its
error to its own caller, while a settled continuation keeps the chain usable.
Do not block `run` itself before it can accept an instruction: `send` before
`run` must remain valid. Do not broaden serialization to turn execution,
interrupt, or unrelated uploads. Preserve current cleanup and cancellation.

For the startup collision, retain the short-lived probe for a fresh idle Host
so zero-turn account snapshots remain available. Track its in-flight promise
in `CodexHost`. At the app-server session creation boundary in
`#createAppServerRuntime`, and before the exec backend's `runStreamed`, if that
probe is still active, abort it and await its transport `close()` before
creating the main child. If it finished, do not delay the turn. The app-server's
native post-thread read then owns the later snapshot. This serializes two
children only within the same Host and `CODEX_HOME`; it does not impose a
process-wide lock or require an account snapshot before the first turn. Closing
or interrupting while the probe is held must settle the wait. The transport
closes stdin and escalates to SIGKILL after five seconds if the child ignores
EOF, so a main session can start up to five seconds later in that case. An
immediate turn may abort the probe before it yields a zero-turn rate-limit
snapshot.

The Host gate cannot coordinate separate wrappers that concurrently initialize
the same empty `CODEX_HOME`, such as a bulk spawn after a Codex update changes
the `state_N.sqlite` version. The deployment runbook must instruct operators
to start one Codex agent first after such an update, let its state initialize,
then bulk spawn. Runner-wide serialization is a separate issue owned by the
director.

Independent exec-path checks used Codex 0.156.1 with the same experimental
worktree. In three alternating full-wrapper fan-out runs per mode on four
cores, the probe and exec startup overlapped in all probe-on runs, and the
probe's app-server initialization failed in two of three. The exec turn
succeeded in all three on and all three off runs. Kohaku additionally measured
0/60 exec child failures across empty and initialized homes under one-core
contention. These results do not establish a permanent exec guarantee across
Codex versions; both backends use the same Host gate.

Retain failure-only test diagnostics for main and probe RPC child request
outcomes, including main `initialize` and `thread/start`, the first provider
request, `WAITING` send/receipt and elapsed milliseconds. Capture
`AppServerSession.stderrTail` and the thread-open result/error on failure.
The current integration test's 35-second `WAITING` wait equals the production
bridge thread-open deadline of 35 seconds; add a test comment explaining why
the two must be distinguished by stage evidence rather than by timeout alone.
The per-Host gate does not coordinate separate wrapper processes sharing a
`CODEX_HOME`; record that remaining boundary explicitly if no further shared
filesystem mechanism is introduced.

## Verification

- Re-run the targeted occurrence-3/4 tests after cherry-pick. Use their
  paused-wire controls to show that local dispatch/finalization may happen
  before acknowledgement/result receipt. Remove each new receiving-boundary
  wait temporarily: its corresponding assertion must fail, then restore it.
- Reproduce the same-host image race with the real materializer, sweep and
  filesystem on the current baseline. On the changed Host, force both orders:
  materialize-first and sweep-first, with each operation held at its boundary.
  Verify the image bytes remain readable in both exec and app-server
  compositions, including `send` before `run`, close/interrupt while held,
  and a subsequent operation after a rejected materialization. Remove the
  chain temporarily and verify the image-preservation assertion fails.
- Re-run the outbound case with stage diagnostics: targeted real CLI and full
  wrapper fan-out, including CPU affinity to four cores and repeated on/off
  probe comparisons. Hold the probe's transport in a deterministic fixture:
  main app-server creation and exec `runStreamed` must wait for probe closure;
  removing each gate must make its corresponding assertion fail. Release the probe and keep all original
  assertions. Verify fresh idle with no turn still publishes a successful
  snapshot; a native post-thread read must take precedence if the turn begins.
- Build and typecheck affected wrapper packages, run the full wrapper suite
  multiple times, record each exit code and any unhandled errors, then verify
  runner `pnpm typecheck` and `pnpm test` because `fd473e4a` changes a runner
  test. Verify the branch's wrapper CI job. The director will verify `develop`
  after landing.

Update this evidence record with exact commands and results. Update
`docs/reference/engines/codex-app-server-session.md` to state the image
lifecycle guarantee for both backends after the product fix, including that a
startup sweep's wait scales with the number of matching `/tmp` entries. Record
unresolved occurrence attribution and CI results on issue #362. No assertion weakening,
timeout widening, or unrelated runtime changes are in scope.

## Implementation measurements

The new Host gate aborts and awaits the in-flight startup probe before the
app-server session factory or exec `runStreamed`. A controlled fake transport
holds `close()` while the main child boundary is observed. Both backend tests
pass. Removing only the `await probe` statement made both tests fail because
the main child boundary fired before close completed; restoring it returned
both tests to green. The Host image chain covers the sweep and materialization
through active-set registration. Two real-filesystem order tests pass, one with
`send` before `run` and one with the sweep first. Calling the operation without
the chain made both tests fail; restoration returned them to green. A third
test confirms a rejected materialization does not poison the chain.

The temporary measurement variant of
`cli_app_server_lifecycle.integration.test.ts` injected an empty startup
resolver only when `FUJI362_PROBE_OFF=1` and printed stage records. Its
pre-instrumentation SHA-256 was
`4360e4b496aff6e03e123a303028cb4717a9be4c7d15afb3fdad6600fbc8c054`;
the same hash was verified after restoring the test. Alternating commands ran
the complete wrapper suite five times per mode, limited to four CPUs:

```sh
taskset -c 0-3 env FUJI362_PROBE_OFF=0 pnpm -C wrapper test
taskset -c 0-3 env FUJI362_PROBE_OFF=1 pnpm -C wrapper test
```

The full logs are `/tmp/fuji362-post-{on,off}-{1..5}.log`. Times below are
milliseconds from the `watchdog interrupt=false` test start. Columns are main
child `initialize` completion, `thread/start` completion, first provider
request, and `WAITING` receipt, respectively.

| Mode | Full-suite exit codes | Stage times by run (1–5) | Min / median / max by stage |
| --- | --- | --- | --- |
| Probe on | 0, 0, 0, 0, 0 | (1069, 1701, 2063, 2176); (1052, 1509, 1721, 1804); (1300, 1764, 1942, 1984); (1207, 1680, 1861, 1925); (1169, 1673, 1868, 1930) | (1052 / 1169 / 1300); (1509 / 1680 / 1764); (1721 / 1868 / 2063); (1804 / 1930 / 2176) |
| Probe off | 0, 0, 0, 0, 0 | (702, 1051, 1251, 1352); (803, 1217, 1444, 1496); (769, 1131, 1340, 1394); (805, 1167, 1408, 1507); (804, 1292, 1470, 1533) | (702 / 803 / 805); (1051 / 1167 / 1292); (1251 / 1408 / 1470); (1352 / 1496 / 1533) |

Every probe-on run shows the probe's `initialize` ending with
`App-server closed by client` before the main session is created. None shows
the main-child SQLite failure or an unhandled error. The latency difference
remains because the probe must close before the main child starts; the
previous failure difference was not reproduced. Five runs per mode do not
establish a zero failure rate, but the deterministic gate and its mutation
control establish the required child ordering within one Host.

The final test file (without the temporary `FUJI362_PROBE_OFF` injection) and
Host source were restored byte for byte after the negative controls. The Host
source SHA-256 is
`fce3a46158c333f5d4ea3555931d752317baeaef4f40fad35be2debb9ff01f38`.
The probe-gate negative log is `/tmp/fuji362-gate-negative.log` (exit 1,
both backend assertions failed); the image-chain negative log is
`/tmp/fuji362-image-negative.log` (exit 1, both order assertions failed).
The restored order tests pass (6/6). The receiving-boundary tests from
`fd473e4a` pass in the integrated Codex suite; the cherry-pick conflict in
`test/fixtures/cli_app_server.ts` retained the current empty startup resolver
and the earlier commit's wire-receipt callbacks.

Final gates on the restored implementation: wrapper `pnpm typecheck` exit 0,
`pnpm build` exit 0, and full `pnpm test` exit 0 on each of three consecutive
runs. The wrapper results per run were core 267, agent-common 371, Claude Code
514, Antigravity 386 with two skipped, and Codex 814. The runner `pnpm
typecheck` and `pnpm test` exited 0 (33 files, 740 tests). No suite reported
an unhandled error. The final full-wrapper logs are
`/tmp/fuji362-wrapper-final-{1..3}.log`; the runner log is
`/tmp/fuji362-runner-test-final.log`.

The failure-only diagnostic path was exercised by temporarily throwing a
`forced diagnostic control` error immediately after `WAITING` arrived. The
integration test exited 1 and printed `CODEX_LIFECYCLE_STAGES` with both RPC
children's `initialize` outcomes, the main `thread/start`, provider request,
`WAITING` receipt, `AppServerRpc.stderrTail`, and
`AppServerSession.stderrTail` (`/tmp/fuji362-diagnostics-negative.log`). The
test file was restored to the hash above and the targeted integration test
passed again (2/2, exit 0).
