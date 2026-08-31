---
title: Auto-injection and nominating director of common footer of cooperative guideline
status: accepted
date: 2026-07-29
opened: 2026-07-28
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, persona-personality-injection, threat-model]
related_adrs: [21, 22, 29, 43, 45]
---

# ADR-0044 — Auto-injection of common footer and nominating director under the cooperative guidelines

## Status

Accepted (2026 -28 Weeds, 2026Japanese termー-29 Revised F2 at Master Resolving).
kaoiro issue #87  phase


F2**Standing**director 2 hours later
Submitted
[#158 comment-5384365227](https://github.com/sakuraiyuta/kaoiro/issues/158#issuecomment-5384365227)
P5 "Persistent director role is not defined. Every time operator instruction +
permission broker Inconsistent with each approval. 2026Japanese termー-29 Master Resolved
by F2 to each agent under director whose operator nominates each time
Revised to the form of "the responsibility is assigned, and the responsibility is autonomy, and the permanent act is
P5 and not defined
[ADR-0043](0043-agent-initiated-session-reset.md)
F1 (futter injection) / F3 (passive dysfunction) does not change from starting point.

## Context

When multiple agents are operated inJapanese term on kaoiro, operator is collaborating each time
Autonomously looking at each other's situation without instructing the way
(kaoiro issue #87)

The observation base has been maintained in phase-27: `list_agents` is the execution property oferer
( model / model / effort) and operation status (context / session started at /
return / last activity at / conversation / rate  s).
On the other hand, there is no infusion mechanism of action guidelines, and `send_to_agent` is
[ADR-0022](0022-pending-permission-authoritative-source.md)
`canUseTool` Each time the operator approves
[protocol-inter-agent](../specs/protocol-inter-agent.md)
auto-  is "Phase 2 or later". "Work allocation" on operational rules
Promises are escalate targets (2026 -21) and autonomous work sharing is
Not established.

## Decision

### F1 — Extension of server SoT common footer

"Observing the situation of other agents with `list_agents`, judge yourself,
`send_to_agent`
LINK0 [0029-persona-server-sot-and-pack-distribution](0029-persona-server-sot-and-pack-distribution.md)
The server aggregated SoT common footer and launched on kaoiro
auto-inject with system prompt append to agent**. engine non-dependent
Claude skill (SKILL.md)
The text and length of the guideline are determined by the draft A (sh  principle only)
(2026 08 Master decision, details are as follows).

### F2 — HITL boundary is “Autonomous in the responsibilities under the director nominated each time”

**Does not define permanent director roles.**The operator is working for each unit.
Nominate director every time
([ADR-0043](0043-agent-initiated-session-reset.md) D2 and #158 P5 and
same shape). The nominated director acts as a subdivision agent.
Assignment, each agent is responsible without operator approval
`send_to_agent` should cooperate (agreement, adjustment, post-report).
check to director or escalate to operator


HITL**Specifying director's no  and scope of responsibility**
not individual `send_to_agent`. With this, the current operation "work distribution promise is
Revises the escalate object (2026 -21) within the scope of responsibility.
`send_to_agent` auto-agent is a protocol-inter-agent
'Phase 2 or later' and 'conversation unit whitelist'
Finalized (2026 08 Master decision, details are as follows).

**Destructive operation is not subject to responsibilities.** session reset (`/new`・`/clear`)
ADR-0043 D2/D4
permission broker director directly reset
Do not create a route to start.

### F3 — The activation is passive (work trigger)

The behavior of the collaborative judgment is when the task is received and when it is filled
Check the status**Passive type**idle agent
The function monitoring (polling resident) is not scoped to supportSupporter.

### (issue #165, 2026 (2009)

2026 08 Two remaining F1/F2 was assumed by master decision
open-question

- **send-to-agent-auto-allow**: B (conversation unit whitelist)
Adopt. first approve to server
the `(conversation_id, to)`
Automatically allow `send_to_agent` for later — only after canUseTool approval
(server is not yet accepted or rejected/unknown)
inexJapanese termー review,
  [#201](https://github.com/sakuraiyuta/kaoiro/issues/201)
See — conversation id Alternately, the change of destination after rejection is dialog
If the runaway guard is still weak,
Decision that automatic permission of narrow range is safe. Detailed implementation behavior (disp  waiting
(including resistance to the receiving race)
[protocol-inter-agent](../specs/protocol-inter-agent.md) Automatic approval

- **coordination-footer-scope**: adopt the draft A (sh  principle only).
The details of procedures such as usage and reporting of kind are not included in the footer.
Expand after operation measurement if the lack is found. Length collateral mechanism
[ADR-0045](0045-footer-file-externalization.md) F5

Both open-question reflected and closed.
issue ([#165](https://github.com/sakuraiyuta/kaoiro/issues/165))
([protocol-inter-agent](../specs/protocol-inter-agent.md))
"Approval flow" section,   side `priv/footers/system-footer.md`).

## Consequences

### Positive

- Operation of the agent group is established without the operator's instructions, andJapanese term operation
The throughput rises.
- Injection is an extension of the existing SoT mechanism of ADR-0029, and centralized control of theJapanese term side
Contact Us Because of the passive type, there is noHome cost of the resident mechanism.

### Negative

- `send_to_agent` operator approval is reduced and run between agents
Increased risk of dialogue and overlapping (#87’s “end design” and “observation potential”
and
  [work-division-conflict-guard](../open-questions/work-division-conflict-guard.md)
**Supplement (2026 09, issue #167)**: Part of "Ending" —
done / escalate ping-pong
#167 tombstone
`conversation_closed`
(`localDone` / `remoteDone` / `closed`,lele/duplicate turn)
denied) mechanically closed
  ([protocol-inter-agent](../specs/protocol-inter-agent.md)
“Conversation’s Lifecycle and End of Life” section. Remaining Points
(e.g., detection of loops repeatedly by changing the shape of the same proposal)
#87
- Normally consumes all agent context when common footer is obese
(ADR-0029)

### Neutral

- dashboard's observation path (inter-agent message operator only),
[ADR-0021](0021-role-information-disclosure-policy.md)) is unchanged.
Autonomousization is the approval of transmission and not the scope of disclosure.
- `send_to_agent`
require operator approval. Autonomously works within the scope of no  and obligation assignment
The default state is current.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Claude Code skillILL.md|engine dependencies|
|Footer + skill|Complexity of SoT management|
|Full Autonomous + Post-Report (no director)|Risks of Runaway and Duplicate Work|
|Persistent director De  roles andHome no |The role is fixed and the operator control point is lost. #158 P5 / ADR-0043 D2|
|Approval of operator (current status)|autonomy|
|Active Monitoring (polling resident)|Sound Cost and Noise|
