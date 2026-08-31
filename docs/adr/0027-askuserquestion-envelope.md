---
title: Added envelope (question request / question response) and state waiting question for AskUsertionstion
status: accepted
date: 2026-07-03
opened: 2026-07-03
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, agent-sdk-events, threat-model]
related_adrs: [10, 11, 12, 21, 22]
---

# ADR-0027 — dedicated envelope  and state for AskUsertionstion`waiting_question`

## Status

Accepted

## Context

The `AskUserQuestion` tool of the Claude Agent SDK (v0.3.187) is
Same**`canUseTool` Route**wrapper (formal docs `agent-sdk/user-input`,
`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:724`
`AskUserQuestionInput`. `host.ts:731 #canUseTool`
structured information (question / options / header /
multiSelect) does not reach dashboard and can not return the answer (issue #78).

The return route is confirmed in the technical survey:

- Input `AskUserQuestionInput`: `questions[1-4]` each
  `{ question, header, options[2-4]{ label, description, preview? }, multiSelect }`.
- Response from `canUseTool`
  `{ behavior: "allow", updatedInput: { ...questions, answers: { [Questions]: Pets label }, annotations? } }`
`sdk-tools.d.ts:2991`
`{ behavior: "deny", message }`

3 thoughts on how to design wire protocol (wrapper ↔ server ↔ dashboard)
(Alternatives Considered)

||||
|---|---|---|
| A |Existing`permission_request` / `permission_decision`Extend questions and answers|rejected:Structure/deny and structured answers are semantics. 1 In case of a different type, dashboardthe relevant entrys the drawing in the field sniff, and the meaning of the permission is muddy and drift becomes warmer|
| B |envelope `question_request` / `question_response`and dedicated state`waiting_question`Open| **permission**: Existing protocol`waiting_permission`())`waiting_input`Consistent with the design concept that makes the waiting type* separate state. kaoiro's "state=character" is also chewed and reusable for inter-agent escalate-to-user|
| C |wire is a special type, but state is`waiting_permission`permission|Partial adopt: state misalignment with existing stateseparation (separate permission/input). However, the part of the “Broker’s plum ” (F  below is included in this ADR)|

## Decision

Design [ADR-0022](0022-pending-permission-authoritative-source.md)(pending)
`state_change.ext`**Same type applies to question side**

### F1: New state`waiting_question`

`canUseTool` ignites with `toolName === "AskUserQuestion"` and state in Promise hold.
`waiting_permission`
to be called `tool_running → waiting_question → tool_running`). protocol
Add to `wrapper/src/state.ts`. The direction of expression
"Remove and wait" (a place where the expression is separate from the permission "Want to look here");

### F2: `ext.pending_question`authoritative source

The truth of the question in pending is `state_change.ext.pending_question`.
`null` / No pending if not set. Shape
`{ request_id, questions, ts }` (equivalent to payload of `question_request` envelope ).

```json
{
  "type": "state_change",
  "state": "waiting_question",
  "payload": {},
  "ext": {
    "pending_question": {
      "request_id": "q-abc-123",
      "questions": [
        {
          "question": "どの方式を採用しますか?",
          "header": "方式",
          "multiSelect": false,
          "options": [
            { "label": "REST", "description": "素直だが冗長" },
            { "label": "gRPC", "description": "高速だが導入コスト" }
          ]
        }
      ],
      "ts": "2026-07-03T09:41:00Z"
    }
  }
}
```

### F3: `question_request`envelope

protocol-compatible consistency (same as permission request) and new pending
`question_request`(envelope. `type`) The truth of state
`ext.pending_question` Both guarantee hronization with wrapper
`request_id` / `questions` / `ts`). dashboard reads ext.

### F4: answer`question_response`Channel Events

client → server → wrapper channel event (not envelope  `type`)
`permission_decision` Shape:

- client → server: `{ agent_id, request_id, answers, cancelled? }`(operator only)
- server → wrapper: `{ request_id, answers, cancelled? }`(relay)

`answers` `{ [Questions]: string }`.**Key Question Statement**and the value of the option
`label` multiSelect is a string that client joins in `", "`. "Other"
The string is the same. `cancelled: true` is rejected (equivalent to deny).

### F5: wrapper`#canUseTool`brokerthe relevant entry

`host.ts #canUseTool`
Drop to the flow. `AskUserQuestionInput`
Pass to `QuestionBroker`.
- `QuestionBroker` is `PermissionBroker` and
Share mechanisms** (extract common cores, or stream with si  implementations). These requirements
Same as permission, it is invisible from protocol/UX.
- Returns `{ behavior: "allow", updatedInput: { ...input, answers } }` in response.
`cancelled` / timeout / close `{ behavior: "deny", message }`.
- host has `#pendingQuestion` and `state_change.ext` in `waiting_question`
`pending_question` is added.

### F6: viewer delivery follows ADR-0021 allow-list

`question_request` is only available for the operator, and the viewer is completely removed and the grid matching
the relevant entry to `state_change(waiting_question)` (`payload={}` / `ext`)
(same as `permission_request`). `ext.pending_question` to ride ext
"viewer is automatically protected by ext removal in all types" (no additional guard required).
`question_request` / `question_response`
Add.

### F7: Snapshot Restore

`question_request` does not match state change, but the truth
`ext.pending_question` to get the latest state change envelope
Restored in the client's snapshot (same as ADR-0022 F5). DETS
None

## Consequences

### Positive

- dashboard is a structured option (label / description / preview / multiSelect / Other)
You can draw in a dedicated dialog and return the response to the SDK correctly (#78 Neji).
- Consistent with the stateseparation idea of permissionprotocol, without interfering with the meaning of permission.
- pending is restored with `ext.pending_question` snapshot when reloading and reconnection.
- The viewer leak is automatically protected by the allow-list / ext removal of ADR-0021.
- inter-agent `escalate-to-user` ([protocol-inter-agent](../specs/protocol-inter-agent.md))
Reusable of the same structured dialog (for the existing AskUsertionstion-based UI)
).

### Negative

- New state `waiting_question` is a protocol state table, mer , `state.ts`,
Ripple to client's state→expression mapping. The character expression material of "」ing" is
It is established for existing current, and the dedicated material is followed.
- operator to apply unlimited timeout (ADR-0022 F6) to question
If it is not responded, it will not proceed (the same behavior as permission, force deny with close())).

### Neutral

- `answers` normalizes multiSelect to a single string that the client joins (S )
`answers: Record<string,string>` 1:1). structured If the retention is required
Extendable with backward compatible rearing (`version` installation).
- `annotations`(per-question notes/preview) does not passthrough on the face, and is repaired when required.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|A: Add request/decision permission|The meaning of allow/deny and structured responses. dashboard draws become a field sniff, and the permission meaning is turbid and drift hotbed|
|C: wire is a special type, but the state is waiting permission|unmatched with an existing stateseparation (separate permission/input). ADR F5|
|onUserRoute|Error.`onUserDialog`refusal fallback prompt / side question|

## Related

- specs: [protocol](../specs/protocol.md)(`question_request` type・
`ext.pending_question`·`question_response` Message/state by direction
`waiting_question`, [protocol-inter-agent](../specs/protocol-inter-agent.md)
(Escalate-to-user's "Existing AskUserBodystion-based UI" refers to the actual ADR),
[agent-sdk-events](../specs/agent-sdk-events.md)(canUseTool path)
AskUser stion   and return), [threat-model](../specs/threat-model.md)
(viewer leakage is automatically covered via ADR-0021).
- ADR: [0021](0021-role-information-disclosure-policy.md)
allow-list base), [0022](0022-pending-permission-authoritative-source.md)
(ext = pending)
- Origin: [issue #78](https://github.com/sakuraiyuta/kaoiro/issues/78).
