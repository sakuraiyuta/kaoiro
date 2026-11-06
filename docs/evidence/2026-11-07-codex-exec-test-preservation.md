---
title: Codex exec retirement test preservation
description: Shared behavior retained on app-server before removing the wrapper exec backend.
status: accepted
last_updated: 2026-11-07
---

# Codex exec retirement test preservation

This is unit 1 of [issue #1008](https://github.com/sakuraiyuta/kaoiro/issues/1008).
Production source and both selectable backends remain unchanged in this unit.
The baseline is `65d46b2d9c92b841daf01e3949c12df141dbc65b`.

## Inventory boundary

A tracked-file query for `codexFactory|CodexClientLike` under
`wrapper/codex/test` finds 18 files. This includes a shared fixture and
existing app-server suites, so it is not a deletion list. On the baseline,
`host.test.ts` contains 124 static test declarations (118 direct declarations
and 6 `each` declarations), 5,231 physical lines and no literal app-server
backend selection. These are declaration counts, not expanded runtime cases.

Shared assertions must survive removal of the legacy test seam. An assertion
about an SDK option, iterator, stderr class or repair retry does not require
an identical app-server mechanism. Keep the outer ownership, authority,
ordering or error contract where the test also asserts one.

## Preserved contracts

Paths in this table are relative to `wrapper/codex/test`.

| Contract from the legacy tests | App-server coverage retained or transferred |
| --- | --- |
| FIFO, one active turn, all queued inputs complete | Existing `host_app_server.test.ts`: `keeps queue order, maximum active one, and every queued input successful` |
| Skip/rewrite obsolete queued IA input, preserve settings, no extra ready state | Existing four queued-input tests in `host_app_server.test.ts`; dispatch uses the actual Session/transport |
| Image cleanup must not discard newly queued turns or abort a successor | `host_drop_queued_temp_turns.test.ts`: all six declarations now use app-server Session/transport; owned queue and cleanup assertions remain |
| Permission/question coexistence, late clear cannot make an idle agent busy | `host_pending_permission.test.ts`: three active-turn cases now use an app-server MCP notification; idle negative case remains |
| Historical observation, rejection rollback, stale revision, mismatch, unknown, capability downgrade, rejoin/cancellation and audit deduplication | `permission_state_boundaries.test.ts`: all 13 declarations now use app-server turn requests and real rollout observations |
| Permission selection captured at dispatch; approval mismatch and audit semantics | Existing `app_server_permission.test.ts`, `app_server_permission.integration.test.ts`, `app_server_approval_runtime.test.ts`, `host_app_server_approval.test.ts`; pure `permission_state.test.ts` remains shared |
| Wait for server sync before child creation; cancel blocked admission; reapply explicitly | Existing `host_app_server.test.ts` and `app_server_host_runtime.test.ts` gate tests, plus transferred boundary tests |
| Active token fencing; late terminal cannot settle a watchdog-unknown turn; pending admission retires once | Existing `host_app_server.test.ts`: `keeps watchdog fail-stop closed without a late active result or settlement`; existing `cli_app_server_lifecycle.test.ts` fail-stop and watchdog tests |
| Post-terminal interrupt/close cannot undo a committed switch or authorize a reset | Existing `host_app_server.test.ts` boundary test; `app_server_host_runtime.test.ts` terminal callback/observation wait matrix; `session_reset_app_server_gate.test.ts` terminal ownership cases |
| Reset permission and strict approval, pending-call cancellation, no reset after abandonment | Existing `session_reset_app_server_gate.test.ts` through CLI, ToolHost, broker and coordinator |
| CLI handoff, exact-token acknowledgement, same-conversation lease replacement, waiter recovery and failure | Existing `cli_app_server_lifecycle.test.ts` and native `cli_app_server_lifecycle.integration.test.ts`; preserve exec-only handoff evidence until U3 |
| SIGTERM invokes CLI close and tears down real native child plus sandboxed descendant | `cli_sigterm_exec_real_process.integration.test.ts` now runs both backend selections, observing live owned child/descendant before the signal and their disappearance afterward |
| A separate wrapper exits naturally with code 0, no signal and no surviving owned child/descendant | `cli_sigterm_process_exit.integration.test.ts` now runs both backends; it observes the actual OS process exit, not just a returned promise |
| History is bounded to 200, preserves logs/display framing and cannot race next dispatch | Existing `app_server_history.test.ts`, `app_server_replay.test.ts`, `app_server_history.integration.test.ts`, `cli_app_server_history.integration.test.ts`; Host history scheduling/publication cases remain in `host_app_server.test.ts` |
| Rename revision monotonicity and persona identity through a turn | New `host_app_server.test.ts` rename case combines both legacy rename cases |
| Mid-turn model/effort changes stay pending; whoami agrees with effective status after success | New `host_app_server.test.ts` two-turn settings case; existing runtime pending-settings and reprepare cases |
| Rejected switch restores last-good, stamps one error, reuses the session | New `host_app_server.test.ts` rejected switch case; existing runtime rejected-RPC rollback and failed/interrupted baseline cases |
| Catalog reset, default effort intent and per-model defaults | Existing `app_server_settings.test.ts` and Host display-hint/reprepare tests; retain backend-independent catalog/minimum-version tests rather than duplicating them |
| Account model and limits are unknown until observed, late facts do not overwrite current state, duplicate snapshots do not emit extra state | Existing `app_server_telemetry.test.ts`, `app_server_host_runtime.test.ts` and `cli_app_server_lifecycle.test.ts`; rollout-tail parser tests remain shared while referenced |
| Task deduplication, result exactly once, failing sinks cannot change settlement | Existing Host projection and throwing-result-sink tests in `host_app_server.test.ts`; transport/projection suites preserve typed notifications |
| No-terminal stream/disconnect is loud, no second child or overlapping execution | Existing `app_server_host_runtime.test.ts` no-terminal and connection failure tests; Host disconnect matrix |
| Bridge startup fails closed and waits for readiness | Existing dual-backend `bridge_startup.integration.test.ts`; retain the app-server matrix when retiring exec |
| Image startup sweep and materialization order | Existing app-server cases in `image_startup_order.test.ts` and `startup_probe_order.test.ts`; preserve shared upload tests |

The table identifies coverage to use during deletion; it is not authorization
to delete a whole legacy describe group. Pure metadata/catalog tests can remain
without the SDK client seam. Exec-only SDK input handoff, ThreadOptions,
stream patching, rollout repair/retry and stderr topology tests retire with
their production mechanism in unit 3. Mixed tests require checking each shared
assertion against these target tests before removing it.

## Compatibility and native boundary

`agent_environment.integration.test.ts` keeps the native `codex exec` seed and
omitted/app-server resume cases. Native Codex exec still exists after retiring
the wrapper's exec backend. Only the explicit wrapper selector changes to a
refusal in unit 2. Historical rollback evidence is retained as historical;
this unit does not infer native account behavior from a local provider.

`MAX_HISTORY`, shared SDK event types, bridge, rollout readers and old protocol
receivers remain wherever referenced. Unit 3 closes its deletion inventory
with call-site review and typecheck, rather than treating lexical matches as
proof that code is exclusive. It also accounts for unreachable maintenance
`runPrepare` code.

## Verification boundary

The additions ceiling for this unit is 1,500 added lines against its baseline,
including refactoring and documentation, rather than net file growth. Queue,
permission, watchdog, shutdown and history each require an independent
mutation on the committed candidate, followed by restoration and a passing
check. Shutdown mutations must not alter process ownership or widen cleanup
targets. Candidate CI and measured counts are recorded against the final SHA
in the implementation handoff and PR; this inventory itself makes no test
execution claim.
