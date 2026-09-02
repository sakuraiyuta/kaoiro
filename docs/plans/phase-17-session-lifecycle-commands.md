---
title: Phase 17 — /new and /clear Session Lifecycle Commands
description: Treat /new and /clear as first-class controls rather than engine prompts, and implement fresh-session creation for the same agent, display preservation, resume capability, capability advertisement, and busy rejection.
status: done
phase: 17
depends_on: [phase-15-wrapper-ux-parity]
last_updated: 2026-07-24

---

# Phase 17 — /new and /clear Session Lifecycle Commands

## Goal

Implement [ADR-0036](../adr/0036-session-lifecycle-commands.md) so that the
agent can switch to a fresh SDK session while keeping the same agent/persona/cwd.
`/new` and `/clear` retain display logs and show a boundary. Keep old session
files and allow resume from the existing session picker.

Start implementation after phase-15 initial scope is complete. The master will
decide whether to implement phase-16 or phase-17 first based on the state when
phase-15 is complete. Do not place mutual depends_on entries.

## Acceptance Criteria

- [ ] An exact `/new` / `/clear` without attachments in the Composer becomes a
      `session_reset` control event rather than a normal instruction. Do not
      mistakenly intercept commands with arguments or multiple lines.
- [ ] Even if an old/external client sends an exact reserved command to
      `send_instruction`, the server rejects it with `reserved_session_command` and
      never passes it to the engine.
- [ ] The server validates operator-only, live agent, capability, state, and
      duplicate-pending conditions, and correlates acceptance and completion/failure
      by request ID.
- [ ] Reset kills + freshly relaunches the same agent entry; Claude uses a query
      without resume and Codex uses `startThread()`. Preserve persona/cwd/engine and
      use the same last effective snapshot as phase-15 D8 for model/effort/
      permission/sandbox/network, etc.
- [ ] Existing display logs remain after `/new`, and new-session logs are added after
      the session boundary marker.
- [ ] Both `/new` and `/clear` retain existing display logs and structured IA and
      append a boundary marker to the end of history. Only operator `clear_history`
      hides past-session display content; current-session content remains.
- [ ] Neither mode deletes old Claude JSONL/Codex rollouts; resume the old session
      from the session picker and rebuild the history projection.
- [ ] On reset, `SessionPointers` explicitly detaches only the session ID to nil
      while retaining cwd/engine. Update the latest pointer after the fresh session
      ID is reported. Do not add a pointer stack.
- [ ] Stamp `supports_session_reset` / `session_reset_modes` immediately after spawn;
      the UI does not branch by engine name. Modes are required and non-empty when
      supports=true. Fail closed for unstamped/false and true+unspecified/empty,
      and detect invalid combinations in stamp tests.
- [ ] Reset outside `idle|waiting_input` is immediately rejected with `agent_busy`.
      Do not auto-interrupt or queue. Resending after an explicit interrupt succeeds.
- [ ] Reject instruction/model/effort/duplicate reset while reset is pending, and
      ignore stale results by request ID/generation. Do not let delayed events from
      old rollouts or pending tool/question/permission correlations enter the new
      session.
- [ ] Display runner unavailable/spawn failure/timeout loudly and do not silently
      resume the old session. If fresh relaunch fails, explicitly atomically roll
      back to the old session without changing UI history, boundary, or pointer. Become
      disconnected only if rollback also fails.
- [ ] Measure when the rollout/thread ID becomes fixed for Codex fresh
      `startThread()`. With lazy assignment, allow `to_session_id=null` at the
      boundary after the fresh wrapper connects and finalize the pointer/marker with
      the same request ID when the first ID report arrives.
- [ ] Preserve the operator/viewer information boundary and do not expose old/new
      session IDs to viewers.
- [ ] Unit/integration/E2E tests for protocol, server, runner, both wrappers, and
      dashboard pass.

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 17-1 | Add session reset control/result/broadcast types and a closed error vocabulary to the protocol | ✅ | Operator-only; correlate by request ID |
| 17-2 | Add `supports_session_reset` / `session_reset_modes` to session capabilities | ✅ | ADR-0034 extension, stamp immediately after spawn, fail closed. In chunk α both adapters stamp false; flip to true + [\"new\",\"clear\"] when fresh relaunch implementation is complete (17-6) |
| 17-3 | Synchronously implement the equivalent of `SessionPointers.detach_session/1` | ✅ | session_id=nil, retain cwd/engine. Preserve record merge semantics. Also retain the snapshot in addition to cwd/engine (prevent false drift detection on fresh relaunch) |
| 17-4 | Add validation, pending lock, reserved-instruction rejection, and result handling to the server | ✅ | SSOT for lifecycle orchestration. A new SessionResets GenServer provides the TOCTOU core (single handle_call) and protects against async state-report lag (2 s cooldown + viewer exclusion); intercept + handle_out make session_reset_* operator-only gates; runner agent_id host binding uses exact matching (prevent nested-prefix spoofing) |
| 17-5 | Add same-agent fresh relaunch and old-session rollback to the runner supervisor | ✅ | Try without a resume ID; explicitly resume the old ID only on failure. Reapply the last effective snapshot from phase-15 D8. Incorporate two director musts: (1) rollback previous_session_id comes from the server (payload), not the runner's spawn-time value. (2) Follow F2's “connection confirmation” wording with a server-side two-phase flow (SessionResets `:spawning` → `:awaiting_connect` → `confirm_connection/2` at wrapper join). Include oldResumeSessionId in ChildEntry.pendingReset and transfer the F4 lock with the same atomic delete + add as handleSwitchSession (addresses review round-1 finding) |
| 17-6 | Integration-test fresh session start with Claude/Codex | ✅ | Claude query without resume / Codex startThread. Flip both adapters' supports_session_reset to `false → true + ["new","clear"]`. Apply toEqual assertions in both tests. Manually confirm integration measurements for ID-finalization timing, consecutive same-process creation, and event isolation (allow Codex lazy thread-ID allocation as to_session_id=null; finalize the pointer through SessionPointers.record in the first fresh-session envelope). Add the dashboard Composer intercept in δ (17-8); keep the adapter flip dark-launched in γ (no UI trigger path) |
| 17-7 | Add session-boundary append to AgentStates | ✅ | Under the #106 finalized specification, both modes append a marker to the end of existing history. Do not reset the display or purge IA. |
| 17-8 | Implement Composer exact-command interception and local slash-completion merge | ✅ | Check capability/modes; do not reset with attachments. Extract `shouldInterceptAsSessionReset` helper to protocol.ts (exact `/new` / `/clear` + no attachments + capability=on check, fail closed) and intercept in AgentDetail's send path. Merge kaoiro-local `/new` / `/clear` into the slash-completion pool only when capability=on (deduplicate engine-reported slashes; kaoiro-local comes first and interception wins even if the engine reports the same command) |
| 17-9 | Implement started/completed/failed/boundary UI and busy error | ✅ | Disable Composer operations during reset and display “Starting a new session.” Bind 3 handlers + `sessionResets` state (agent_id → mode) in App.svelte and pass resetMode to AgentDetail. When resetMode !== null, disable textarea + submit, swap the placeholder, and show a reset-progress banner; failed uses showNotice for a loud error (explicit closed-vocabulary reason). Branch on env.type === "session_boundary" in the transcript; operator sees shortened request_id + tooltip with IDs, viewer sees only mode in the divider |
| 17-10 | Add regression tests for old session picker/resume | ✅ | No pointer stack; host files are the SSOT. detach_session retains session_id=nil + cwd/engine/snapshot (γ 17-3); the first fresh-session envelope overwrites the new pointer through record; existing resume_session (ADR-0014 F2/F3/A4 continued) returns to the old session. Confirm DETS persistence across detach + reattach in session_pointers_test and SessionPointer matching for resume_session in agents_channel_test |
| 17-11 | Add race/failure tests | ✅ | Instruction race, double reset, old event, spawn failure, rollback success/failure, timeout. Add the **phase-17 version of the 15-8 Finding 1/2 hole**: two cases in wrapper_channel_test (“patch fires for an envelope with a pending stash; no-op without one,” order independence), and reject resume_session with session_reset_pending during reset pending in agents_channel_test (close the omission in ADR-0036 F2's enumeration via an addendum). Existing tests already cover double reset / instruction / model / effort / permission_mode / timeout / spawn_failed → rollback / rollback_failed |
| 17-12 | Update specs/operational docs and run all regression tests | ✅ | Update protocol/architecture/threat-model. Add `session_boundary` to protocol.md's type table and `session_reset` / `session_reset_started/completed/failed` / `reset_session` / `session_reset_result` to its directional table. Document `SessionResets` GenServer + `confirm_connection` two-phase + `AgentStates.pending_boundary_patch` in architecture.md. Add **six session_reset defense layers** to threat-model.md (operator-only / capability advertisement / exact-match host binding / reserved_session_command rejection / SessionResets pending lock / viewer information boundary). Add resume_session to ADR-0036 F2. Real-hardware acceptance for both engines is planned after phase-17 completion by the master + director |
| 17-13 | Update the IA display specification for `/clear` | ✅ | Under the #106 finalized specification, `/clear` retains display including IA. Only operator `clear_history` hides past IA. |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done, ⛔ blocked.

## Non-goals

- Physical deletion of old session files.
- A server-side previous-session stack or dedicated “back” button.
- Automatic interrupt/queue for a busy reset.
- Reimplementation of the engine-native slash-command parser.
- Implementation of the phase-16 model switch; adjust only the implementation order when starting.

## Open Questions Blocking This Phase

None. The architecture decision is finalized in ADR-0036. The implementation
order with phase-16 is resource scheduling, not a design blocker.

## Followups (after phase-17 completion, 2026-07-12)

- **Three empirical checks** (Codex thread ID finalization timing / consecutive
  same-process creation / old-event isolation): at γ 17-6 implementation these
  were coded as “implementation assumptions”; verify them in field acceptance
  after ε completion and add findings to the Implementation section of
  [ADR-0036](../adr/0036-session-lifecycle-commands.md) (addendum already made in γ)
- **Immediate broadcast of boundary_patched**: intentionally rejected by ruling 2
  (the server-side SoT reflects the to_session_id patch after Codex lazy allocation,
  but connected clients are not pushed immediately and see it on refetch). If
  dogfooding finds it inconvenient, consider a `boundary_patched` broadcast as a
  follow-up
- **Accepting reset from error state**: ADR-0036 F6 MVP accepts only idle /
  waiting_input; reset from error is rejected like any other non-idle state.
  Accepting reset from error is a future extension candidate after measuring old
  process / rollback semantics
- **Artificial spawn-failure test on the rollback path**: exclude it from the ε
  completion acceptance and handle it in a future follow-up

## Followup: Restore /clear F3 (2026-07-24, master instruction)

- **Background**: In the #106 fix round on 7/23 (commit f6ef0b0), ADR-0036 F3 was
  rewritten to “both /new and /clear preserve the display,” making /clear a
  command that removed nothing. This was a specification mix-up; the original F3
  (“/new preserves the display, /clear resets the display projection for that
  agent”) is correct. The master reconfirmed the specification on 2026-07-24.
- **Applied**: Restore ADR-0036 F3's wording (2026-07-24), add a
  `mode == "clear"` branch to `SessionResets.confirm_connection/2`
  (`ClearWatermarks.record/3` + `AgentStates.clear_history_with_boundary/2`),
  and add a `clear_watermark` field to the `session_reset_completed` broadcast
  payload. The client (App.svelte / protocol.ts) narrows the pane to one marker
  line and updates the watermark map for mode="clear" in
  `onSessionResetCompleted`.
- **Still true**: Operator `clear_history` (#48) retains its current API (purge
  other-session logs from the current session). Do not delete engine-side session
  files (JSONL/rollout). The other party's /clear IA pane is hidden by #106's
  per-pane ClearWatermarks, so do not delete the durable ledger (InterAgentHistory
  DETS).
- **Correction 2026-08-08:** The durable-ledger premise above was superseded by
  D3-4 of [ADR-0051](../adr/0051-history-restart-resilience.md). From then on,
  IA cutoffs use an ingress stamp and the wrapper host's sidecar. Keep the phase-17
  record through this point as the implementation record of that time.
- **Keep the corresponding task-table and Acceptance Criteria rows verbatim as
  historical records** (the acceptance criteria at the 2026-07-13 close passed
  under the interpretation at that time). The specification SSOT is consolidated
  in ADR-0036 F3 and the Session visibility semantics section of
  `docs/specs/protocol.md`.

## Field Acceptance Record (2026-07-12, performed by master + director → phase close)

- **/new / /clear happy paths: confirmed OK** (master-operated; momo and other
  Codex agents confirmed boundary markers / fresh-session start for both modes).
- **Finding during acceptance**: The “resume from another session…” action in the
  live agent's left pane failed during runner T3 revalidation (`supervisor.ts:457`
  `#sessionExists`) (reproduced in Codex; the restore path from the launch UI is
  normal) → filed as [#101](https://github.com/sakuraiyuta/kaoiro/issues/101)
  (bug / priority-medium), to be handled outside this phase.
- **Operational acceptance of rejection paths / viewer boundary**: address issues
  if they appear in production, by master decision (all paths are covered by unit
  tests).
- **Master decision: phase-17 is closed here. Handle subsequent fixes through a
  separate issue / plan.**

## See Also

- Decision: [ADR-0036](../adr/0036-session-lifecycle-commands.md)
- Related: [ADR-0014](../adr/0014-session-resume-and-restore.md) / [ADR-0034](../adr/0034-session-capabilities-advertisement.md)
- Previous prerequisite: [phase-15-wrapper-ux-parity](phase-15-wrapper-ux-parity.md)
