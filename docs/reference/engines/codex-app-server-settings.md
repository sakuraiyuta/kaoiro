---
title: "Codex app-server settings and permission"
status: implemented
last_updated: 2026-09-18
---

# Codex app-server settings and permission

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [evidence record](../../evidence/codex-app-server/settings-and-permission.md).

The internal session accepts per-turn model, effort, cwd, and sandbox/network
settings. Approval remains `never` with reviewer `user`. A synchronous
`onDispatch` callback runs after default resolution, immediately before
`turn/start`; throwing prevents submission. Its host token and client message
id remain separate from the eventual app-server turn id and RPC request id.
`interrupt(hostTurnToken)` targets only that active turn, defers until its start
response supplies an id, and skips an already buffered terminal. An interrupt
RPC acknowledgement does not release turn admission; the terminal still does.

`resetEffort` requires a target model and cannot accompany an explicit effort.
The pinned CLI retains thread effort on null/omission. The session instead reads
`config/read(cwd)` immediately before submission and uses its explicit effort,
or the target model's `model/list.defaultReasoningEffort`. An unavailable default
rejects with `default_effort_unavailable` before dispatch; the prior effort is
never silently retained. Configuration changes after this read do not change
the submitted value, whereas a newly spawned exec samples at process startup.
App-server does not support `--profile`; current Host/SDK/session launch does not
expose that option. Exec behavior is unchanged. The internal Host backend wires
switch-error reporting and pending/rollback for explicit app-server launches.

The internal Host backend uses the shared permission/settings helpers.
`beforeDispatch` waits for permission synchronization after default-effort
resolution; the synchronous `onDispatch` callback then validates the captured
selection and receives an immutable concrete model/effort receipt. A changed
selection or blocked gate raises `permission_superseded` before `turn/start`.
The runtime prepares the same unstarted queued turn again with a new snapshot. Close/EOF releases a pending synchronization wait.

The permission attempt captures a separate execution id and a rollout boundary.
Only the first dispatch of a known newly started thread may use a fresh boundary:
`thread/start` can return before its rollout exists. A missing resume baseline is
not trusted. Completion requires matching thread, host token, current submission
(revision, requested axes, execution id), and the terminal's app-server turn id.
A newer pending selection does not invalidate the current execution. Missing or
contradictory evidence remains unknown; RPC acceptance never means applied.
Assessment, diagnostics and observation fields share the existing exec rules;
exec's rollout reader still permits omission of the expected turn id.

Initial settings come from the thread start/resume response. Explicit effort
survives compatible model changes. Only reset intent or a model change with
default intent resolves a new default. Successful reset uses the resolved
receipt, not the display catalog's default. Rollback explicitly resends the
previous successful model/effort; default intent resolves again. Unknown
baseline/default fails with `default_effort_unavailable`, without exposing raw
RPC errors. Exec settings behavior is unchanged.

## Runtime admission

The owner of the hook below is [AppServerHostRuntime](../../architecture/codex-backends.md).

Its synchronization hook must await both the current server
permission-sync barrier and the Host's blocked-permission gate. If the hook
returns while the gate is still blocked, the runtime rejects with
`permission_gate_blocked` without dispatching or replacing the session. Admission
rejections must be `AppServerAdmissionError` (`permission_gate_blocked` or
`interrupted`); other hook rejections are connection failures and close the session.
The Host translates its gate timeout into this admission type. The hook is awaited before opening and again after asynchronous settings resolution. The final
synchronous dispatch check compares permission and pending model/effort/reset
selection. Superseded preparation repeats without dispatch callbacks; fresh
thread provenance is consumed only at the first actual dispatch.

The runtime separates terminal-boundary notification from completion. It reports
the boundary, observes policy, synchronously calls the permission-assessment
sink, and only then updates the settings baseline and returns the terminal.
The sink owns the existing permission state/audit transitions. Progress is
forwarded, but the projection's terminal adapter state is withheld for the Host
to publish with the completion. Only a completed, non-abandoned turn updates
the baseline. Failure or interruption preserves it and requests explicit
rollback on the next turn, including a late completed terminal after interrupt.
Abandonment is captured before the terminal callback; interrupts during subsequent
policy observation return false and cannot undo that completed settings change.
Interrupt acceptance does not release admission; the token's terminal still
owns completion. Pre-dispatch interrupt/close releases synchronization waits.
Connection or unexpected stream failure closes the session and admission;
there is no second child or implicit exec fallback. Normal terminal failure
and closed admission/settings errors remain distinct from connection failure.

The Host dispatch callback starts the turn scope and existing delivery/lifecycle
callbacks only after synchronization and settings preparation. Queued inputs
retain their order across interruption. Completion publishes one result and one
settlement, with finalization after temporary-image cleanup. App-server
`interrupted` still emits the turn boundary but omits `onTurnEnd.terminal`, uses
`error.reason = "interrupted"`, and includes only an actual Host abandonment.
It is not fabricated as `turn.failed`: reserved session resets require an
authoritative terminal and do not advance on this interruption.

Settings commit follows the runtime completion's `settingsCommitted` and
`baseline`, never a Host-local interrupt record. A known narrow race remains:
between transport retirement and runtime terminal consumption, an interrupt can
return false while marking the runtime attempt abandoned. That completed turn
then preserves the old baseline and explicitly rolls back on the next turn.
After runtime terminal consumption, interrupts return false without that effect.
