---
title: Session reset requested by the agent itself at a turn boundary
status: accepted
date: 2026-07-28
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [21, 22, 33, 36, 44, 55]
---

# ADR-0043 — Session reset initiated by the agent

## Status

Accepted (2026-07-28, grounded in the decision record of [#158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
and the Phase B real-machine acceptance of [#158 comment-5384365348](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365348)). Implementation is
carried out in [Phase C of phase-28-agent-initiated-session-ops](../plans/phase-28-agent-initiated-session-ops.md#phase-c--自発-newclear-詳細化-2026-07-28クロエ裁定).

## Context

[ADR-0036](0036-session-lifecycle-commands.md) defines `/new` and `/clear` as
operator-only first-class control operations. F1 adopts the principle that the
wrapper does not re-parse user text and that the client/server defend exact
reserved commands; F6 rejects reset for a busy agent and does not introduce
automatic interrupt or a queue.

Phase 28 enables an agent to detect and judge context fatigue and propose a
recovery operation. Phase B accepted on a real machine the form in which
`request_compact` executes an action in the wrapper after obtaining per-operation
operator approval through the MCP tool's `canUseTool` path. We want to apply this
path to `/new` and `/clear` as well. However, because reset replaces the wrapper
process, executing it during a tool call would break completion of that turn, the
tool result, and log correlation.

What is therefore needed is not to expand the meaning of text commands, but a
limited new origin in which the agent itself obtains permission and **reserves**
a reset, then passes the request to ADR-0036 F2's existing reset path at the
boundary after the current turn completes. The semantics of runner kill + fresh
relaunch, the session pointer, and operator-initiated reset do not change.

## Decision

### D1 — Extend F1's origin to the agent itself

In addition to the operator, permit **the agent itself (self-initiated)** as an
origin under ADR-0036 F1. The Claude wrapper provides the
`request_session_reset` MCP tool, and an agent may pass only for itself
`mode: "new" | "clear"` and an optional `reason`. An approved request is sent
from the wrapper to the server at a turn boundary as
`session_reset_request {mode, reason?}`. The server records the origin as
`agent_self` and joins the existing runner push path through the existing
capability / pending lock / state / cooldown gates.

This addition does not introduce re-parsing of user text by the wrapper. The
handling of ADR-0036 F1's exact instruction reject for `/new` / `/clear`, as well
as inputs containing attachments, remains unchanged. A local command entered by
the operator and a control operation requested by the agent through a tool are
separate paths.

### D2 — Do not create a dedicated path originating from another agent

Do not introduce a dedicated protocol / tool through which agent A directly
requests a reset for agent B. Do not create a permanent director role. It is
sufficient to retain the existing separation of responsibilities: the operator
appoints a director when needed, the instructed agent calls **its own** tool, and
the operator approves each request.

### D3 — Supplement F6 with deferred execution of self-initiated reset

Do not execute reset when the `request_session_reset` tool call is approved; the
wrapper returns an acceptance of the reservation. Only after processing the
current turn's `result` and confirming the turn boundary itself does the wrapper
send the request to the server. The difference between the time of permission
and the time of execution is intended behavior for a deferred reset.

Maintain all of ADR-0036 F6's busy rejection, non-adoption of automatic interrupt,
and non-adoption of queue waiting for operator-initiated reset. A self-initiated
origin also enters the same server gates, so the server may reject reset if state /
pending lock / cooldown is no longer eligible after reservation. Reuse the reset
execution system (kill + fresh relaunch) without changing ADR-0036 F2.

### D4 — Treat permission as “heavy” and obtain broker approval for each tool call

`request_session_reset` is a Phase 28 P2 “heavy” operation and requires per-call
approval from the permission_broker through `canUseTool`. Do not introduce
auto-allow, persistent permission, or agent self-approval. The operator reviews
the reason and mode and permits or rejects the reservation.

### D4 Addendum (2026-07-28 — approval depends on permission mode)

Real-machine acceptance found that the approval dialog did not appear to the
operator for the dogfood Claude persona (`permission_mode=auto`). In autonomous
modes such as `auto`, the SDK automatically approves tool calls as part of the
mode's semantics, so the canUseTool → permission_broker path does not fire. The
wrapper's gate implementation (not registering READ_ONLY_TOOLS → going to
canUseTool) is correct; the per-call dialog appears in `default`-family modes.

マスター decision (2026-07-28): **approval depends on the agent's permission
mode** is now the formal specification. D4's “do not introduce auto-allow,
persistent permission, or agent self-approval” is limited to meaning that kaoiro
does not have its own auto-allow mechanism that bypasses the mode. Automatic
approval granted by the mode itself is valid as part of the autonomy the operator
gave that agent. For an agent that requires strict per-call approval, the operator
can restore the gate by setting its mode to the `default` family. This semantics
is common to all tools through canUseTool, including `request_compact` /
`send_to_agent`.

### D5 — Do not mechanize handoff; encourage externalization in the tool description

Do not create a mechanism that stores a handoff summary before reset in the
protocol or server state. Before calling `request_session_reset`, the agent
writes necessary handoff information to an external durable destination such as
WORKLOG. The tool description explicitly states this responsibility. Do not
generalize embedded compact summaries to new/clear.

## Consequences

### Positive

- An agent that recognizes context fatigue can request a fresh session while
  preserving operator confirmation.
- Limiting reset to a turn boundary avoids losing the tool result, logs, and
  completion of the current turn midway through it.
- Reusing the server / runner reset execution system keeps gates and failure
  semantics aligned with operator-initiated reset.
- Avoiding re-parsing of user text preserves the responsibility boundary between
  reserved-command defense and model input.

### Negative

- Reset is not executed until the turn completes even after tool approval, so
  approval and execution are separated in time.
- If state changes after reservation, the server may reject the request; the agent
  learns of the failure on the next turn.
- Externalizing handoff is an operational responsibility of the agent and has no
  mechanized completeness guarantee.

### Neutral

- Do not expose `request_session_reset` to Codex. The target is the Claude
  wrapper's MCP tool path.
- Addendum (2026-08-28): retain the above non-exposure based on measurement of
  issue #246. `codex exec` has its approval axis fixed at `never` and no per-request
  approval path (`wrapper/codex/src/host.ts`); exposing it would allow a self-reset
  without operator approval. Reconsider once Codex has an approval path.
- The information boundary to viewers remains ADR-0021; do not disclose origin /
  reason to viewers.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Dedicated path for another agent to directly trigger any agent's reset | Unnecessary under P5. The operator appoints a director each time, and the target agent's own tool plus approval is sufficient |
| Reset immediately after automatic interrupt | Risky because tool write / current-turn output and context destruction are bundled into one operation; retain ADR-0036 F6's rejection |
| Queue reset until busy work ends | Later destruction can make the input destination ambiguous; retain ADR-0036 F6's rejection |
| Have the wrapper re-parse user text and treat it as an agent reset | Breaks the principle of separating F1 control from model input and the defense of reserved commands |

## References

- Decision record: [issue #158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
- Phase B real-machine acceptance: [issue #158 comment-5384365348](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365348)
- Implementation plan: [phase-28 Phase C](../plans/phase-28-agent-initiated-session-ops.md#phase-c--自発-newclear-詳細化-2026-07-28クロエ裁定)
- Source revision: [ADR-0036](0036-session-lifecycle-commands.md) F1, F2, F6
- Permission precedents: ADR-0022, ADR-0033
- Viewer information boundary: ADR-0021
