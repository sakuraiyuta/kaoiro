---
title: "Codex app-server Host composition evidence"
status: recorded
last_updated: 2026-09-18
---

# Codex app-server Host composition evidence

Historical excerpts from [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md). Each increment
retains its original scope and tense; “now”, “above” and “remaining” describe that
record, not a new claim of present implementation or release.

The artifact, binary/schema hashes, reference SDK and initial procedure cited as
“above” are in the [compatibility record](stage1-compatibility.md).

Scratch paths and hashes below identify the recorded experiments, not a promise
that temporary files remain available. Measurement dates are retained per record;
`last_updated` refers to the source text, not a new measurement.

### Increment (5c-1): internal Host execution runtime

The Host connection is split into an independently reviewed runtime and later
Host selection/queue wiring. This first unit owns one `AppServerSession`, one
thread start/resume, and the preparation/observation lifecycle. It adds no
backend selection to CodexHost, CLI, config, environment, runner, or launch.
Existing exec execution and Host callbacks are unchanged.

The runtime's synchronization hook will receive the Host's full admission gate,
including the current ServerLink permission-sync wait. If the hook returns with
a blocked gate, the runtime rejects with `permission_gate_blocked` and retains
the session for explicit reapplication rather than repeatedly preparing.
Preparation waits before opening and after effort resolution; a final synchronous comparison covers
permission and pending model/effort/reset. Superseded preparation retains its
input/token and has no dispatch callback. The first actual dispatch alone
consumes new-thread provenance. Completion observes exact-turn policy and calls
the synchronous assessment sink before changing the successful settings
baseline. A separate terminal callback lets the future Host end its watchdog
boundary without waiting for rollout observation. Result/state publication and
external lifecycle settlement remain the Host's responsibility.

An interrupted turn does not commit a new baseline, including a completed
terminal already in flight when interrupt was requested. The terminal boundary
captures abandonment before callbacks and asynchronous policy observation; an
interrupt after that boundary returns false without changing the baseline.
Failed/interrupted attempts preserve the baseline and cause explicit next-turn rollback; default
intent is resolved again. Interrupt is host-token fenced and acknowledgement
does not retire the active operation. Overlapping run calls are rejected; the
Host queue will be wired in (5c-2), not replicated inside this runtime.
Connection/stream failure closes admission without creating another session or
falling back to exec. Close during asynchronous construction also disposes the
late-created session.

A production-default runtime test uses the fixed CLI and isolated loopback
provider for start/resume, terminal policy observation, next-turn network
changes, explicit effort preservation, failed model-switch rollback, interrupt
without baseline update, and the next successful turn. Special timing of
synchronization/settings changes, missing baseline, callback ordering, EOF,
late interrupt acknowledgement and construction/close races use fixtures.
The existing analytics/plugins-off startup caveats still apply. IA steering,
Host queue/watchdog composition, history replay, normal launch and ADR status
remain outside this unit.


### Increment (5c-2): internal Host selection and serial execution

`CodexHostOptions.backend` is the sole internal selection point, defaulting to
exec. CLI, config, environment, runner, protocol and normal launch selection are
unchanged. The existing Host queue awaits each app-server runtime completion;
its adapter/log/tasklist projection uses the existing state and relay helpers,
including the already-normalized tasklist's omitted counts. Result/settlement
are emitted once, and finalization follows temporary-image cleanup. The default
exec factory, thread options and callbacks remain independently pinned.

The runtime hook now receives the complete Host permission-sync/blocked gate,
both before thread opening and after asynchronous settings preparation. Gate
timeout/cancellation reject with `AppServerAdmissionError`; other hook rejection
is a connection failure and closes the session. Runtime's explicit blocked guard
remains defense against a hook that incorrectly returns. Changed permission or
pending model/effort/reset is re-prepared without restarting external lifecycle.
Config effort is explicit on the first dispatch, operator effort wins, and
resume display hints do not become explicit settings pins.

The Host token and turn scope are captured before asynchronous interrupt cleanup.
Unsent preparation is cancelled by lifecycle generation; queued text survives.
Terminal consumption closes the scope and watchdog boundary before rollout
observation. Settings authority is the runtime's completion and baseline, not
Host-local interruption bookkeeping. The known transport-retired/runtime-not-yet-
consumed microtask window can still mark an attempt abandoned despite a false
interrupt return, causing one explicit rollback; this increment does not add a
synchronous Session activity query. An `interrupted` terminal emits a boundary,
but `onTurnEnd` omits terminal, reports `error.reason = "interrupted"` and only
actual abandonment. It cannot authorize a reserved session reset.

Once-only abnormal disconnection propagation reaches Host even while idle,
closes admission and does not replace the child or implicitly select exec. Idle
failure reports error without fabricating a result; active failure uses the
existing turn settlement and retires queued work. Intentional close is separate.
Tool scope abortion and immediate shutdown remain synchronous at the Host entry.

Verification uses the pinned CLI, default Session/bridge, real ServerLink and a
loopback Phoenix-wire test peer, not an actual Phoenix server. Two cases verify
config effort and an initial operator override at the provider, alongside sync,
rejoin, serial input, exact-turn policy observation before child shutdown,
materialized absolute image bytes/cleanup, failed-switch rollback, and a real MCP
handler interrupted before the next successful turn. No external model/auth is
used; analytics/plugins are disabled and startup update traffic remains possible.
Exact callback/race/failure ordering uses deterministic JSONL child fixtures.
Negative controls remove the Host synchronization wait or queue await separately;
queue assertions distinguish ordered starts, maximum one active operation, and
success of every input (concurrency guards may reject inputs instead of allowing
parallel execution). Full IA/watchdog composition, history replay and launch
selection remain later increments; ADR status is unchanged.


### Increment (5d): internal Host history replay

The asynchronous reader now feeds the unchanged synchronous `HistoryReplayer`
through a Codex-only coordinator. The CLI selects this path from the constructed
Host's internal backend, retaining exec rollout replay and exposing no new
launch selection. Host coalesces pending hydration into one job and runs it
between settled/cleaned-up turns, before the next queued turn. Resume opens the
single session for reading when needed. Fresh, unassigned sessions replay an
empty window without allocating a thread.

`full` and `tail` retain their internal coverage and both publish reset, ordered
log entries, existing sidecar IA replay, and complete. Complete means restoration
of the retained display window, consistent with the shared 200-row cap and
server projection contract; it does not claim archival completeness. Incomplete
history produces one closed-reason operational diagnostic and no replay cycle.
Admission remains open. A new modern replay id permits one retry; duplicate ids
and legacy reconnects do not. Legacy resume retains its initial attempt only.
Child failure still follows the existing connection-failure path.

The shared transport adds only a read-only join-generation fence. A completed
read must still match a connected, joined generation before publication, so an
old reset cannot be buffered and flushed into a replacement join. Other engines'
send behavior and the wire remain unchanged. During read through publication,
Codex retains up to `MAX_HISTORY` incoming user logs, without stopping console
output or Host.send. These rows follow replay completion, or incomplete
diagnosis without reset, and transfer to a superseding hydration job. Previously
logged but unexecuted instructions outside this window remain a known limitation
of transcript-only rebuilding; this increment does not redesign the input queue.

Evidence uses the production-default Host/session and fixed CLI through the real
CLI composition and ServerLink, with a local Responses provider and test-only
Phoenix-wire peer. It observes persisted resume, ordered full display, 200-row
tail, active-turn reconnect, and next-turn ordering. A separately delayed read
segment pins printing/admission versus deferred user-log relay. Deterministic
fixtures cover incomplete/retry, stale socket results, duplicate verdicts,
legacy behavior, bounded buffering, fresh empty replay, and read/close exclusion.
No actual Phoenix server, external account/model, or new protocol behavior is
claimed. The existing analytics/plugins-off startup caveats apply. Full IA and
watchdog supervision and normal launch parity remain later units; ADR status
is unchanged.


### Increment (5e): CLI, watchdog, IA and Supervisor composition

The internal CLI dependency object selects app-server explicitly; normal
`runCodexCli()` remains exec and no config/environment/flag/runner selector is
exposed. A clock-only seam permits deterministic watchdog boundary tests without
replacing watchdog settings or its interrupt/fail-stop callbacks. Stage 6 would
change the selector source at this composition point; public configuration and
runner release support still require their own acceptance.

The pinned CLI and default Host/Session/ToolHost/IA components completed an MCP
`list_agents`/`send_to_agent` synchronous-wait roundtrip through real ServerLink
and a Phoenix-format wire fixture. Same-peer arrivals coalesce behind their
active turn; other peers retain separate batches. Only actual dispatch advances
delivery acknowledgement. A consumed synchronous reply does not become a turn.
A second native-CLI case uses the injected clock to invoke the real watchdog
interrupt during that wait, then resumes queued work. The normal case does not
inject a clock or substitute any Host, Session, ToolHost or IA constructor.

JSONL child fixtures additionally exercise progress attribution, receipt versus
terminal, exact token fencing, old-turn/same-conversation leases, approved reset
boundaries and fail-stop. This composition exposed a pre-existing cancellation
ordering defect: Host calls queued `onTurnEnd` before `onWatchdogFailStop`, but
the former deleted the coordinator batch before the latter could retire its
unstarted deliveries. The cancellation branch now retires the exact batch
returned by `settle`. Exec and app-server both reproduced the missing seq 3 with
seq 1 active and seq 2 pending; the normal settlement branch and Host callback
order are unchanged. The repair is a separate commit from the acceptance seams.

Supervision is explicitly layered. Host creates no replacement child and has no
exec fallback. The existing runner Supervisor restarts unexpected wrapper exits
within its bounded budget, creating a new wrapper lifetime and omitting the
original prompt; deliberate stop does not restart. Real wrapper-process tests
cover that contract with a simulated RPC child and server link. They are not
native-CLI crash-injection evidence.

A landing-time image assertion had failed once under whole-suite fan-out and
passed subsequent isolated/full runs. A separate built-module probe showed
same-agent, cross-process image sweeping removes a materialized file; the native
CLI then sends a read-failure text instead of an image. Original failure inputs
were not retained, so this is a demonstrated mechanism, not an attribution of
that incident. Tests now use distinct agent IDs and emit diagnostic input/path
existence only on image assertion failure; product cleanup is unchanged.

Stage 6 requires an operator decision to expose an **explicit optional** backend
selection, retaining exec as both default and rollback target. This increment
does not claim deployed runner release selection, cross-backend resume rollback,
non-Linux support or CI stability from local tests. ADR status is unchanged.

## Wrapper test coverage and limits

The following coverage notes were retained from the package README at migration
baseline `81570847`. They do not extend the dated measurements above.

The Host integration test uses the production app-server session and real
`ServerLink` with a test Phoenix-wire peer (not a Phoenix server), plus the pinned
CLI and local Responses provider. It checks synchronization before dispatch,
rejoin before queued work resumes, terminal rollout policy observations, config
and operator effort priority, image bytes/cleanup, failed-switch rollback, and
real MCP handler abortion followed by another turn. Deterministic child fixtures
cover exact queue order/maximum active/all-input-success separately, cancellation,
callback exceptions, idle/active EOF, and reserved-reset rejection. This does not
claim public launch parity; CLI composition has separate coverage below.

The CLI history integration uses the pinned binary, default Host runtime/session,
real ServerLink, and a loopback Phoenix-wire fixture (not the actual server).
It checks persisted resume order, a 200-row tail, active-turn rejoin, and replay
before queued work. Only its final user-arrival timing segment delays a real
history read. Incomplete responses, exact duplicate/stale verdict ordering,
legacy compatibility, close/EOF, and buffer limits use deterministic fixtures.
Replay does not manufacture result, delivery acknowledgement, compaction, or
turn lifecycle events. Protocol and other engines' replay APIs are unchanged.

The pinned-CLI composition test uses default Host, Session, ToolHost, IA and
clock components for a normal MCP inter-agent roundtrip. Mid-turn messages stay
queued; acknowledgements advance at dispatch, and a reply consumed by a live
synchronous waiter does not enqueue another turn. A second real-CLI case drives
the watchdog clock during an MCP wait, interrupts the owning turn and processes
the queued inputs. These use a local model provider and a Phoenix-format wire
fixture, not an actual Phoenix server or a live remote peer.

Deterministic child fixtures cover watchdog start/progress/end, token fencing,
interrupt receipt before terminal, late same-conversation settlement, approved
reset cancellation, and fail-stop.

The runner test
uses real wrapper processes with a simulated app-server child and server link;
it does not measure the native CLI's crash behavior.

The image integration tests use unique agent IDs because temporary image sweeps
are keyed by agent ID across processes. Failed assertions preserve diagnostic
user content and materialized-path existence. This removes reproduced cross-test
interference; it does not establish the cause of the earlier isolated CI-style
fan-out failure. Cross-OS execution and production deployment are not established
by these local tests.
