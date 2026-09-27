---
title: Dashboard operator bulk reset
description: SettingsDrawer control to bulk-close all conversations and bulk-clear all agent sessions
status: planned
phase: 0
depends_on: []
last_updated: 2026-09-24
---

# Dashboard operator bulk reset

Feature-local plan (no project-wide roadmap number — see
[plans/README.md](README.md#feature-local-plans)). Implements
[ADR-0061](../adr/0061-dashboard-operator-bulk-reset.md).

## Phase 0 — Bulk close + bulk clear from SettingsDrawer

### Goal

An operator can, in one confirmed action from the dashboard's
`SettingsDrawer`, close every active inter-agent conversation and reset
(clear) every online agent's session.

### Acceptance Criteria

- [ ] The `SettingsDrawer` operator section (gated the same way as the
      existing conversation-list / user-list controls: `isOperator` +
      a live connection) gains a bulk-reset action.
- [ ] Triggering it shows a confirmation modal naming the target
      counts ("Close N conversations and reset M agents — proceed?").
- [ ] On confirm, the dashboard calls the existing `closeConversation`
      for every currently active conversation ID, and
      `sendSessionReset(id, "clear")` for every currently online agent.
      No new server command is introduced.
- [ ] A per-target failure is logged and skipped; it does not stop
      processing of the remaining targets (applies to both the close
      pass and the reset pass).
- [ ] A `session_reset` result that is ambiguous (push timeout, or
      `session_reset_pending`) is treated as unknown, logged as such,
      and is not retried within the same run.
- [ ] Offline (directory-only) agents are excluded from the reset pass.
- [ ] After the run completes, a summary is shown (e.g. a toast) with
      success/skip counts for both the close pass and the reset pass.

### Implementation design

Evidence checked at base `7ff1875b`:

- `App.svelte` maintains live agent envelopes in `agents`, marks the join
  snapshot with `awaitingSnapshot` / `snapshotIncomplete`, and already has a
  transient `showNotice()` channel. Directory entries are separate and include
  offline agents, so they are not a reset target source.
- `SettingsDrawer.svelte` already loads conversations through
  `connection.listConversations()`, whose result distinguishes open/closed and
  can be incomplete. Its single-close flow captures connection generation and
  avoids applying a stale completion after the connection changes.
- `protocol.ts` declares `sendSessionReset()` as `Promise<void>`: resolve means
  server acceptance, not completion. Its `pushAsync()` rejects on server error
  and push timeout. In particular `session_reset_pending` and timeout do not
  establish whether the reset ran, so the bulk run records them as unknown and
  does not retry them.
- `agents_channel.ex` applies `require_operator/3` to both `session_reset` and
  `close_conversation`; the existing server authorization remains the second
  gate.

Use the operator's `listConversations()` result as the conversation snapshot
(only `status === "open"`), and the current live `agents` map as the online
snapshot (only entries whose state is not `disconnected`). Never derive online
targets from `directory`. Do not offer confirmation until the conversation
list is loaded and complete and the live-agent snapshot is ready and complete;
an incomplete source cannot provide a truthful "all" count. Opening the modal
freezes both target ID lists and displays those exact counts. New targets that
appear afterward are not added. Before each call, recheck the operator/live
connection generation; for reset, also skip an agent that is no longer live.
Targets that disappeared or were already closed are recorded as skipped.

Run the close pass and then the reset pass sequentially, catching and logging
each target independently so a failure never blocks later targets. A resolved
close counts as closed. A resolved `sendSessionReset(id, "clear")` counts as
accepted (not completed); definite rejections count as skipped, while timeout
and `session_reset_pending` count as unknown and are never retried in this run.
If operator authority or connection identity changes, stop scheduling calls
immediately, do not apply stale results to the new connection, and suppress the
old run's summary. Keep a run lock in `App.svelte` so closing/reopening the
drawer cannot start a second run while the first one's promise is still
settling; disable the action and confirmation while locked.

Render the action only when both `isOperator` and `status === "connected"`
with a live connection are present, and also require complete snapshots before
enabling it. This is the UI gate; the existing server operator checks remain
authoritative. Reuse `App.svelte`'s `showNotice()` for the aggregate summary,
passed to the drawer as a callback, and report closed/skipped plus
accepted/skipped/unknown counts. Sequential processing is chosen over
parallelism to make per-target failure isolation, generation checks, and the
summary deterministic; neither close nor reset has an ordering dependency in
ADR-0061 F1.

### Verification plan

Add tests for all seven acceptance criteria, including production-default
`App.svelte` composition with no injected operator/connection substitutes.
Cover the confirmation snapshot counts and frozen IDs; exact close/reset calls;
continued processing after one close or reset failure; timeout and
`session_reset_pending` classified as unknown with exactly one attempt;
directory-only/offline exclusion; and the summary callback's counts. Also
exercise identity change and operator loss during a deferred call, complete
snapshot gating, and the shared run lock across drawer close/reopen.

Negative controls / mutations: remove the combined operator + connected render
gate and prove a viewer or disconnected composition exposes no action; include
an offline directory-only agent and prove it is never called; make one target
reject and prove subsequent targets still run; mutate ambiguous-result handling
to retry and prove the one-attempt assertion fails; remove the generation check
and run-lock guard and prove their race tests fail. Existing server tests that
viewer calls to both `close_conversation` and `session_reset` are forbidden
remain the authorization negative controls; no server code or wire command is
planned.

Update the task table and plan status after implementation. Update
`docs/reference/ui/responsive-reachability.md` to record the bulk control's
operator + connected gate and SettingsDrawer location. The dashboard build
clears and recreates `server/priv/static/assets`, which are served by the
server, so after the dashboard build run the server static-serving test against
those generated assets; no broader server change is anticipated.

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0-1 | Add the bulk-reset action + confirmation modal to `SettingsDrawer` | ⏳ | Reuses existing operator-gate pattern |
| 0-2 | Client-side orchestration: loop over active conversations / online agents, skip-and-continue, no retry on ambiguous reset result | ⏳ | No new wire command |
| 0-3 | Post-run summary feedback (success/skip counts) | ⏳ | |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

### Followups (in-phase but unfinished)

(empty — none yet; phase 0 has not started)

### Open Questions Blocking This Phase

(none)

## Phase 1 — Candidate future work (not committed)

Not scheduled. Revisit only if phase 0's client-loop approach
(ADR-0061 F1) proves insufficient in practice, or if operator feedback
shows phase 0's feedback/confirmation UX (F2/F3) is too coarse.

- Per-target failure/skip detail view (which conversation/agent was
  skipped and why), instead of phase 0's aggregate counts.
- A scale-driven confirmation warning (e.g. an extra threshold notice
  above N agents).
- A server-side bulk endpoint, if phase 0's per-target client loop
  turns out not to scale for this project's usage.

## See Also

- Decision record: [ADR-0061](../adr/0061-dashboard-operator-bulk-reset.md)
- Existing per-item controls this composes:
  [conversations contract](../reference/inter-agent/conversations.md),
  [session-tools.md](../reference/inter-agent/session-tools.md),
  [ADR-0036](../adr/0036-session-lifecycle-commands.md)
