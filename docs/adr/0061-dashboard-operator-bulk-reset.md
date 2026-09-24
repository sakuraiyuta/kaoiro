---
title: Dashboard operator bulk close + bulk session reset
status: accepted
date: 2026-09-24
opened: 2026-09-24
supersedes: []
superseded_by: null
related_specs: []
related_adrs: [36]
---

# ADR-0061 — Dashboard operator bulk close + bulk session reset

## Status

Accepted (2026-09-24, approved by マスター). Implementation is
[dashboard-bulk-reset](../plans/dashboard-bulk-reset.md) (feature-local
plan, no project-wide roadmap number).

## Context

The dashboard's operator-only `SettingsDrawer` already exposes two
per-item controls: `closeConversation(conversationId)` (wire command
`close_conversation`, `ConversationStates.close_by_operator/1`,
[conversations contract](../reference/inter-agent/conversations.md))
and `sendSessionReset(agentId, mode)` (wire command `session_reset`,
[ADR-0036](0036-session-lifecycle-commands.md)). Both require the
operator to act one conversation or one agent at a time. When several
conversations and agents are simultaneously stuck or noisy, an operator
wanting a clean slate has to repeat that single-target flow N times.

Before deciding the implementation, one premise needed checking: would
closing many conversations at once cascade into wasted model
inference across the participating agents? Reading
`wrapper/agent-common/src/inter_agent.ts` and
`server/lib/kaoiro_server_web/synth_envelope.ex` shows this does not
happen. `close_conversation` delivers a synthetic envelope
(`kind: "done"`, `turn_number: 0`) that `receiveInbound()` classifies as
`mode: "terminal"` and returns `inject: false` for — the comment there
states the reasoning directly: "injecting it into the SDK just to say
'nothing to do' burns a full model turn for no actionable content"
(issue #211 direction 1). This code path is shared by all three engine
wrappers (claude-code, codex, antigravity), and `close_conversation`
is idempotent (a second close on an already-closed cid returns an
error rather than re-notifying). No notification-suppression design
was therefore needed for the bulk case.

This ADR decides:

1. Whether bulk close/reset needs a new server-side primitive or can
   compose the existing per-item ones.
2. How a bulk operation handles a per-target failure.
3. What the operator sees before and after running it.
4. Where the control lives in the dashboard.

## Decision

### F1 — Client-side loop over the existing per-item controls; skip-and-continue; no retry on an ambiguous result

The dashboard implements "close all + reset all" entirely client-side:
it enumerates the currently active conversation IDs and calls
`closeConversation` on each, then enumerates currently *online*
(live wrapper connection) agents and calls `sendSessionReset(id,
"clear")` on each. No new server command is added; the existing
`close_conversation` / `session_reset` wire contracts are unchanged.

Directory-only (offline) agents are excluded from the reset pass —
`session_reset` is a push to a live wrapper channel and cannot reach
one regardless. Execution order between the close pass and the reset
pass has no correctness dependency (F1's context finding: close does
not wake the model; a busy/unreachable agent is already tolerated by
the skip policy below), so either order, or running both concurrently,
is acceptable.

Each target is processed independently:

- A per-target failure (a rejected `close_conversation`, or a
  `session_reset` rejection such as `agent_busy` /
  `unsupported_session_reset` / `invalid_mode`) is logged and skipped;
  it does not abort processing of the remaining targets.
- An **ambiguous** `session_reset` result — a push timeout, or a
  `session_reset_pending` rejection — is treated as "unknown," logged
  as such, and is **not** retried within the same bulk run. This
  follows the existing MUST clauses in
  [session-tools.md](../reference/inter-agent/session-tools.md): only a
  confirmed-retryable rejection (`agent_busy`) may be retried, and an
  unconfirmed/ambiguous result must not be assumed to mean "not
  executed" (a reset might already be in flight; retrying could fire
  it twice).

This is a tentative architecture, not a permanent constraint: if
implementation surfaces a concrete problem with the client-loop
approach (e.g. round-trip volume at a scale not seen today), revisit
F1 rather than treating it as closed.

### F2 — Confirmation modal stating target counts

Before executing, the dashboard shows a standard confirmation modal
naming the counts about to be affected ("Close N conversations and
reset M agents — proceed?") with OK/Cancel. No additional
scale-dependent warning threshold is added in this phase.

### F3 — Post-execution summary feedback

After the bulk run completes, the dashboard shows a simple summary
(e.g. a toast) of close/reset outcomes and skip counts, e.g. "closed
5/5, reset 4/6 (2 skipped)." A per-target breakdown of what was
skipped and why is not built in this phase; the existing
conversation-list / agent-list views already reflect the resulting
state.

### F4 — Placement: `SettingsDrawer` operator section

The control is added inside the dashboard's `SettingsDrawer`, in the
section already gated on `isOperator` + a live connection (the same
gate as the existing conversation-list and user-list controls). It is
not added to the primary kaoiro web client, and not exposed as a
persistent header button.

## Consequences

### Positive

- No new wire contract, protocol version bump, or server-side command
  is needed; `close_conversation` and `session_reset` keep their
  current single-item semantics unchanged.
- Consistent with the existing skip-and-continue precedent in
  `session-tools.md` for ambiguous reset results.
- Reuses the existing operator-only `SettingsDrawer` gate and layout
  precedent, so no new authorization surface is introduced.

### Negative

- N conversations + M agents means up to N+M sequential (or
  concurrently fired) wire round-trips from the dashboard; at a scale
  well beyond kaoiro's current agent/conversation counts this could
  become a bottleneck the client-loop approach does not address (see
  F1's tentative-architecture note).
- No per-target failure detail is surfaced in this phase; an operator
  who needs to know exactly which agent or conversation was skipped
  has to cross-reference the post-action conversation/agent lists
  manually.

### Neutral

- A scale-driven confirmation threshold and a server-side bulk endpoint
  remain candidate future work (see
  [dashboard-bulk-reset](../plans/dashboard-bulk-reset.md)'s "Phase 1 —
  Candidate future work" section) — not committed, revisited only if
  phase 0's client-loop approach proves insufficient in practice.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| New server-side bulk commands (`close_all_conversations` / `reset_all_sessions`) | No atomicity requirement exists — per-item skip-and-continue is already the desired semantics — so a new protocol surface would duplicate existing per-item logic for no benefit at current scale. |
| Confirmation modal + scale-dependent extra warning (e.g. for 5+ agents) | Added complexity not justified without evidence this control is used at a scale where the extra step earns its keep. |
| No confirmation (button press = immediate execution) | Too risky for a destructive, irreversible bulk action. |
| Detailed per-target failure/skip list in a modal or drawer | More useful for follow-up, but not justified as a first slice; the existing conversation/agent list views already reflect post-action state. |
| No post-execution feedback at all | Insufficient confirmation that a destructive bulk action actually completed. |
| Persistent header button (outside the drawer) | Faster access, but raises mis-click risk on a destructive action, which would force pairing it with F2's confirmation modal anyway; the drawer placement matches the existing operator-conversation-list / user-list precedent. |
| Retry `session_reset` on an ambiguous result (timeout / `session_reset_pending`) within the same bulk run | Contradicts `session-tools.md`'s MUST clause against retrying an unconfirmed result; a reset already in flight could be fired twice. |

## Implementation

[dashboard-bulk-reset](../plans/dashboard-bulk-reset.md) (feature-local
plan) implements this.
