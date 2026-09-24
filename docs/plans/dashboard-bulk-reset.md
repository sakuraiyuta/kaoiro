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
