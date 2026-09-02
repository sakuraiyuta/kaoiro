---
title: Revised response display and included dashboard scope
status: accepted
date: 2026-06-14
opened: 2026-06-11
supersedes: []
superseded_by: null
related_specs: [non-goals, protocol, threat-model, overview]
related_adrs: [7, 10, 11, 14, 16, 20, 21, 22, 27, 30, 36, 41, 52]
---

# ADR-0012 — Revised Response Display and Included Dashboard Scope

## Status

Accepted

## Context

Instructions could be sent in Phase 3, but the agent's response text was shown
nowhere (neither in the dashboard nor in the wrapper terminal). This became
apparent on the first day of operational verification (2026-06-11), leaving the
bidirectional functionality substantially less useful because "the instruction
arrives, but you cannot see what was answered" (the former open question
`response-display`).

[non-goals](../specs/non-goals.md) and
[ADR-0007](0007-client-separation-reference-dashboard.md) had fixed the included
dashboard at the minimum of "state list, expressions, approvals, and instruction
input", and response display was not included in that list. In light of the goal
that "the included component should be minimally useful on its own," not being
able to see an instruction's response meant the feature was half-finished, and
reconsidering the scope boundary was the essential issue.

On 2026-06-14, the UI direction was discussed with the user
(my-spec-elicitation). The appearance (dark theme, faces/standing pictures, and
monospace font) remained fixed while screen transitions, display items, and
functions were settled.

## Decision

- **(F1) Include response display in the scope**. Revise the included
  dashboard's positioning from "minimum" to an **information-rich operator
  console**. The boundary criterion is not the "number of functions" but
  whether it **requires a new public protocol surface / server persistence**.
  Richening that stays within public API consumption and no persistence is
  allowed ([non-goals](../specs/non-goals.md) updated).
- **(F3) The default screen is a tile list (bird's-eye view)**. Clicking an
  agent triggers an animated transition and displays **full-screen details**.
- **(F2/F6) Grid cards retain the current display items** (face, name, state,
  and agent_id) as rich cards. Do not put approval allow/deny on the card;
  signal it with an action-required badge (blinking), and perform allow/deny in
  the detail view.
  - **Update (2026-06-16)**: The card initially also had instruction input, but
    it was removed. Instructions are sent only from the detail screen; the
    bird's-eye grid has no editing UI.
- **(F5) Display responses as a chat-like `log` stream**. Relay `assistant`
  text sequentially; `tool_use`/`tool_result` (tool input/output) are collapsed
  by default and expanded on click.
- **(F8) Blind-spot indicator**. Full-screen details create a blind spot where
  attention needed from other agents can be missed, so always display
  "**N other agents need attention →**" (the color follows the most urgent
  state: error > waiting_permission), with a click returning to the list.
- **(F7) The server keeps in-memory ring-buffer history** and returns the
  snapshot (latest) + history on join (restored on reload and reconnect).
  **There is no disk persistence** (it disappears on restart). Persistence
  (resilience across redeployments) is deferred to issue #24 together with the
  specification. The **source of truth for history is the SDK JSONL on the
  wrapper host**; this ring buffer is a rebuildable projection (reconstruction
  through resume is described in [ADR-0014](0014-session-resume-and-restore.md)).
- **(F9) Deliver response logs (`log`/`result`, especially tool input/output)
  only to the operator role**. Viewers receive only the grid (face and state).
  The roles match the screen: viewer = bird's-eye view / operator = operations +
  details ([threat-model](../specs/threat-model.md)).

Protocol details (`log`/`result` payload, delivery control, and history
resynchronization) are in [protocol](../specs/protocol.md), and the
implementation plan is [plans/response-display](../plans/phase-3.5-response-display.md).

## Consequences

### Positive

- The instruction → response flow is complete within the included dashboard
  alone, removing the operational-verification blocker.
- Response display adds the public API (`log`/`result`), allowing external
  clients to dogfood the same surface (consistent with the spirit of ADR-0007).
- The Wizardry-style framed window serves as self-restraint for richening the
  dashboard (avoiding its becoming a conversation-authoring environment), as
  specified in issue #21's implementation policy.

### Negative

- The responsibilities and maintenance surface of the included dashboard grow
  (revising ADR-0007's "minimum").
- The `log` stream increases wire volume.

### Neutral

- Delivery control is added to the existing viewer/operator roles; no new
  authorization mechanism is created.
- In-memory history only requires a small change to `AgentStates`, with no new
  DB dependency.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Implement response relay only and delegate display to external clients (former Option C) | Operational verification would not be complete with the included dashboard alone |
| Keep the dashboard "minimal" | The response to an instruction remains invisible and bidirectional functionality is half-finished |
| Display only result (one final response, former Option A) | Progress during a turn is not visible |
| Full chat conversation pane (former Option D) | Excessive; turns it into a conversation-authoring environment |
| Always use a master-detail two-pane layout | Compresses a bird's-eye view (many faces) into a narrow list |
| Move the list off-screen with a modal/slide | Loses list visibility (goal A) |
| Simplify grid cards (face/name/state only) | Contrary to the user's desire for information density |
| Deliver response logs to all roles | Secrets could be exposed to viewers |
| Implement server history disk persistence (Option B) now | More writes and secrets-at-rest → issue #24 |
| No server history (latest item only) | The log disappears on reload |

## Related

- Resolved: issue #13 (response display), former open question `response-display`
- Implementation: [plans/response-display](../plans/phase-3.5-response-display.md)
  (phase-0 MVP / phase-1 game-like polish = issue #21)
- Future: issue #24 (disk persistence for history), #25 (three columns + response
  timeline), #16 (visualize token/context with `ext`)
- Related ADRs: [0007](0007-client-separation-reference-dashboard.md),
  [0010](0010-protocol-precisification.md),
  [0011](0011-phase3-reliability-and-auth.md),
  [0014](0014-session-resume-and-restore.md)
