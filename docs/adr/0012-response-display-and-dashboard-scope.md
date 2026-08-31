---
title: Revised the scope of the dashboard included with the response display
status: accepted
date: 2026-06-14
opened: 2026-06-11
supersedes: []
superseded_by: null
related_specs: [non-goals, protocol, threat-model, overview]
related_adrs: [7, 10, 11, 14, 16, 20, 21, 22, 27, 30, 36, 41, 52]
---

# ADR-0012 — Revising the scope of the dashboard included with the response display

## Status

Accepted

## Context

You can send instructions in Phase 3, but the agent's response text is
not display (to dashboard or wrapper terminal). First day of verification
(2026-06-11) to be pronounced, "instructions are not answered, but what is invisible"
(formerly open-question `response-display`).

[non-goals](../specs/non-goals.md) and
[ADR 7](0007-client-separation-reference-dashboard.md)
Fixed to the minimum of "state list, expression, approval, and instruction input", and the response display is displayed on this list.
I didn't know. In light of the goal of "consolidation should be a minimum practical use"
The answer to the instructions is semi-finished and the re-determining of the scope line is essential
Comment

2026-06-14,HomeーHome user and UI direction (my-spec-elicitation). Dark
The theme, face, standing picture, etc. width font) remains fixed, screen transition, display item, function
d.

## Decision

- **(F1) Include response display in scope**Home Positioning the included dashboard
Minimum**Information rich operator console**Revised to Line Pull
Determination criteria is not "Number of functions" but "**New public protocol surface / serverJapanese term
* Public API Consuming and non-permanent richness is allowed
(Updated ../specs/non-goals.md).
- **(F3) List of tiles by default**Home Click on the agent to transition animation
  **Full screen details**display.
- **(F2/F6) Grid card is the current display item**(face, name, state, agent id)
Retention (rich card). Permission/rejection of approval is not placed on the card and is required
You can notice it with badge (blinking).
  - **Updated(2026-06-16)**: Initially, the card had the instruction input, but it was removed.
Sending instructions is only a detailed screen, and it is a policy that does not put the edit UI on the bird-eye grid.
- **(F  response is a chat-like `log` stream**display. `assistant` text
`tool_use`/`tool_result`
Click to expand.
- **(F  Blind Spot Indicator**Home All screen details are blind spots that overlook other agents
To grow,**Other N body is required →**"Always display (color follows the emergency state:
error > waiting permission)
- **(F7) server is in-memory ring buffer history**snapshot at join
(latest) return + history (re-read and re-connection).**No disk persistence**
(Reboot disappears) issue (re-depro  resistance) to issue #24 with specification formulation.
history**wrapper host SDK JSONL**and this ring buffer is
Reconstruction via resume
  [ADR-0014](0014-session-resume-and-restore.md))。
- **(F9) Return log (`log`/`result`, especially tool input/output) only to operator role
Delivery viewer is up to the grid. viewer = overview / operator = operation + details
../specs/threat-model.md)

Protocol details (`log`/`result` payload, distribution control, history resynchronization)
[protocol](../specs/protocol.md)
[plans/response-display](../plans/phase-3.5-response-display.md)。

## Consequences

### Positive

- Instruction -> Res ence is completed by the bundled dashboard alone and the actual operation verification blocker is eliminated.
- Increase the API (`log`/`result`) for the response display, and use theternal client
dogfooding can (comparing with ADR 7 spirit).
- Wizardry The window with the wind frame is a self-control (to avoid conversation authoring environment)
Working (issue #21).

### Negative

- Encouragement and maintenance of the bundled dashboard (Revision of the minimum of ADR 7).
- More wires in `log` stream.

### Neutral

- No new authorization mechanism is created only by adding distribution control to the existing role of viewer/operator.
- In-memory history is a small modification of `AgentStates`, without new DB dependency.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Implemented only response relay, display delegates to ex  client (formerly C)|Operational verification does not complete only with the bundle|
|Keep Dashboards Minimized|Half-finished|
|Result only display (last response 1、old draft A)|I can't see the course in the middle of the turn|
|Full chat conversation pane (old D)|Excessive conversation authoring environment|
|Always master-  2 pane|Compression of a large number of faces to a narrow list|
|Move the list outside the screen with modal/s |Lose listability (goal A)|
|Simplify grid cards (face/name/state only)|Contrary to the user’s intention to want information density|
|Deliver response  to all roles|The secret can be exposed to viewer|
|Serverhistory is now available|#24|
|No serverhistory|Log disappears by reloading|

## Related

- : issue #13, old open-question `response-display`
- [plans/response-display](../plans/phase-3.5-response-display.md)
(phase-0 MVP / phase-1)
- Future: issue #24 (history disk persistence), #25 (3 s + response timeline),
#16(Visualizeken/context with `ext`)
-cli ADR: [0007-client-separation-reference-dashboard.md],
  [0010](0010-protocol-precisification.md)、
  [0011](0011-phase3-reliability-and-auth.md)、
  [0014](0014-session-resume-and-restore.md)
