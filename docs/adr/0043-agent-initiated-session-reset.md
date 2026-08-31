---
title: The agent itself requests the turn boundary
status: accepted
date: 2026-07-28
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [21, 22, 33, 36, 44, 55]
---

# ADR-0043 — agent-initiated session reset

## Status

Accepted (2026-07-28、[#158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
[#158 comment-5384365348](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365348)
Phase B)Home
[Phase C of Phase-28-agent-initiated-session-ops](./plans/phase-28-agent-initiated-session-ops.md#phase-c---spontaneous-newclear-Details-2026-28-28)
Contact Us

## Context

[ADR-0036](0036-session-lifecycle-commands.md)
Determined as first class control operation of operator-only. F1 is user text
wrapper does not reparse and client/cli protects exact command
Adopt, and F6 does not get auto-interrupt and queue by specifying the busy agent reset.

Phase 28 can detect and determine context fatigue and suggest recovery operations
Phase B `request_compact` is the `canUseTool` path of MCP tool.
Once approved, wrapper accepted the actual machine to execute action. This route
`/new`/`/clear` wrapper process.
When the tool call is execution, it breaks the completion, tool result, and log correlation.

Thus, the required is not to increase the meaning of text command, but the
get reset**Reservation**ADR-0036 F2
It is a limited starting point addition to pass the request to the route.   kill + fresh relaunch, session
pointer and operator starting point reset are not changed.

## Decision

### D1 — extending the starting point of F1 to the agent itself

ADR-0036 F1**agent (self-initiated)**
The Claude wrapper provides a `request_session_reset` MCP tool, and the agent is
`mode: "new" | "clear"` and any `The approved request is on the turn border
wrapper to server. server
record origin as `agent_self` and
Run cooldown gate to the existing   push path.

This addition does not introduce user text re parse by wrapper. ADR-0036 F1
`/new``/clear` instruction exact reject, and attachment
keep it. The local command and agent required by the operator
control is another route.

### D2 — Don’t create a dedicated route for other agents

Agent A does not introduce the dedicated protocol / tool that directly requires the agent B reset. Standing
director I don't make it. operator nominates director according to required and instructed agent
Home**Home**call the tool and add it to the existing separation that the operator approves each time.

### D3 — F6 for self-initiated reset deferred execution

When the `request_session_reset` tool call is approved, reset is not executed, and the wrapper is
We accept reservations. the `result` of that turn, and the wrapper itself confirms the turn border
send request to server. different from the point of permission and the point of execution
deferred reset

operator ADR-0036 F6 busy rejection, auto-interrupted rejection, queue
Keep all standby adopts. The agent starts with the same gate of the server.
reset is rejected if state / pending lock / cooldown is unsuitable. reset execution
(kill + fresh relaunch) does not change ADR-0036 F2.

### D4 — approve permission for each tool call

`request_session_reset` is a "heavy" operation of Phase 28 P2.
permission broker auto-agent, Persistent, Agent self-approved
Not introduced. The operator checks the reason and mode to allow or refuse the reservation.

### D4 supplement (2026 -28 — approve permission mode dependent)

Claude persona (`permission_mode=auto`)
The approval dialog was found to not appear in the operator. `auto`
to automatically approve the tool call as mode
canUseTool → permission broker wrapper gate implementation
(READ ONLY TOOLS non-registration → for canUseTool) is correct, `default` system mode
Each time a dialog appears.

Master Resolution (2026 -28):**Authorization depends on the permission mode of the agent**
It is a formal specification. D4's "auto-agent, Persistent, and Agent Self-approved"
"Does not have a unique auto-Japanese term mechanism that the kaoiro side bypasses mode"
the meaning. auto-approval given by mode itself is the agent
The agent is valid as a part of the autonomy given to and requires strict approvals.
The operator restores gate by setting mode to `default`. Japanese term
Semantics canUseTool including `request_compact` / `send_to_agent`
Common to all tools via.

### D5 — handoff doesn’t mechanism and prompts ex ation with tool description

Don't create a mechanism to save the handoff summary before reset to the protocol or server state.
agent, before calling `request_session_reset`, WORKLOG, etc.
Export tool description new/clear
Not generalized.

## Consequences

### Positive

- Context Fatigue-relieved agent keeps the operator's confirmation and self-fresh session
required.
- To limit reset to turn boundary, don't lose the tool result, log, and current turn.
- Reuse the server /   reset execution system and start operation gate and failure semantics
matched.
- Avoid reparse of user text and keep the boundary between reserved command protection and model input.

### Negative

- The reset is not execution until the turn is completed after the tool approval, and there is a time difference between approval and execution.
- If the state changes after reservation, the server may refuse, so the agent will fail on the next turn
I know.
- The ex ation of handoff is the operational responsibility of the agent and there is no mechanical integrity guarantee.

### Neutral

- Codex does notJapanese term `request_session_reset`. wrapper
MCP tool path.
- 2026 2028 Update: Keep the above private by actual survey of issue #246. `codex exec`
approval axis does not have a per-request approval path in `never` fixed
(`wrapper/codex/src/host.ts`), if exposed, self-reset without operator approval is established.
Re-exa  when the codex has an approval path.
- The information boundary to viewer remains ADR-0021 and origin / reason to viewer
Not disclosed.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|A dedicated route where the other agent starts reset of any agent directly|P5 The operator nominates the director every time, and establishes the target agent's own tool and approval|
|reset immediately after auto interrupt|tool write / ADR-0036 F6 rejected|
|queue reset to busy end|ADR-0036 F6 rejected to misunderstand the input destination by discarded then execution|
|wrapper reparse user text and   it as agent reset|Principles that do not mix control and model input in F1, and breaks the defendant|

## References

[issue #158 comment-5384365227] (https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
[issue #158 comment-5384365348]
-phase plan: [phase-28 Phase C](../plans/phase-28-agent-initiated-session-ops.md#phase-c---spontaneous-newclear-information-2026-28-28Japanese term)
- Source: [ADR-0036] (0036-session-lifecycle-commands.md) F1, F2, F6
ADR-0022
- viewer information boundary: ADR-0021
