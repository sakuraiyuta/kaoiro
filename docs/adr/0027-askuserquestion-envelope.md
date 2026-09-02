---
title: Add dedicated envelopes (question_request / question_response) and waiting_question state for AskUserQuestion
status: accepted
date: 2026-07-03
opened: 2026-07-03
supersedes: []
superseded_by: null
related_specs: [protocol, protocol-inter-agent, agent-sdk-events, threat-model]
related_adrs: [10, 11, 12, 21, 22]
---

# ADR-0027 — Dedicated Envelope and `waiting_question` State for AskUserQuestion

## Status

Accepted

## Context

The `AskUserQuestion` tool in Claude Agent SDK (v0.3.187) reaches the wrapper through the same **`canUseTool` path** as tool permission (official docs `agent-sdk/user-input`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:724`’s `AskUserQuestionInput`). However, the current wrapper reduces everything to allow/deny in `host.ts:731 #canUseTool`, so structured information (question / options / header / multiSelect) does not reach the dashboard and selected answers cannot be returned (issue #78).

Technical investigation fixed the answer-return path:

- Input `AskUserQuestionInput`: each of `questions[1-4]` is `{ question, header, options[2-4]{ label, description, preview? }, multiSelect }`.
- Return from `canUseTool`: `{ behavior: "allow", updatedInput: { ...questions, answers: { [質問文]: 選択 label }, annotations? } }` (`AskUserQuestionOutput` `sdk-tools.d.ts:2991`).
  Rejection/cancellation is `{ behavior: "deny", message }`.

Three options were considered for the wire protocol (wrapper ↔ server ↔ dashboard) (the three options in the Context below and in Alternatives Considered).

| Option | Summary | Decision |
|---|---|---|
| A | Extend the existing `permission_request` / `permission_decision` and piggyback questions/answers | Rejected: allow/deny and structured answers are semantically different. Piggybacking them in one type would make the dashboard branch by sniffing fields, muddying the meaning of permission and creating a drift nursery |
| B | Add dedicated envelopes `question_request` / `question_response` and a dedicated `waiting_question` state | **Adopted**: consistent with the existing protocol design, which separates `waiting_permission` (waiting for permission) and `waiting_input` (waiting for instructions) by *kind of wait*. It also fits kaoiro’s core “state = character” idea and can be reused for inter-agent escalate-to-user |
| C | Use a dedicated wire type but reuse `waiting_permission` for state | Partially adopted: reusing the state conflicts with the existing separation of permission/input. However, reuse the broker plumbing (the part described in F5) in this ADR |

## Decision

Apply the pattern in [ADR-0022](0022-pending-permission-authoritative-source.md) (put the source of truth for pending state in `state_change.ext`) **to the question side in the same way**.

### F1: New state `waiting_question`

The state while `canUseTool` fires with `toolName === "AskUserQuestion"` and the Promise is pending. Both its derivation and transitions are equal to `waiting_permission` (`canUseTool` is called after tool_use, so `tool_running → waiting_question → tool_running`). Add it to the protocol state table and mermaid, and to `wrapper/src/state.ts`. The direction of the expression is “wait while offering a choice” (room for an expression distinct from permission’s “look this way and wait”).

### F2: Make `ext.pending_question` the authoritative source

The source of truth for a pending question is `state_change.ext.pending_question`. `null` / unset means nothing is pending. Its shape is `{ request_id, questions, ts }` (equivalent to the payload of the `question_request` envelope).

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

### F3: `question_request` envelope is an initial notification

For protocol compatibility and consistency (the same form as permission_request), and to notify that new pending state exists, send `question_request` (envelope `type`). The source of truth is `ext.pending_question`. The wrapper guarantees synchronisation between the two (the same `request_id` / `questions` / `ts`). The dashboard should read ext.

### F4: Answers are a `question_response` channel event

This is a client → server → wrapper channel event (not an envelope `type`; a direction-specific message like `permission_decision`). Shape:

- client → server: `{ agent_id, request_id, answers, cancelled? }` (operator only)
- server → wrapper: `{ request_id, answers, cancelled? }` (relay)

`answers` is `{ [質問文]: string }`. **Use the question text as the key** and the selected option’s `label` as the value. The client joins multiSelect into one string with `", "`. “Other” (free text) is used as-is as the value. `cancelled: true` means rejection (equivalent to deny).

### F5: Branch `#canUseTool` in the wrapper and reuse broker plumbing

- Branch `toolName === "AskUserQuestion"` in `host.ts #canUseTool` and enter the question flow. Extract `questions` from `AskUserQuestionInput` and pass them to `QuestionBroker`.
- `QuestionBroker` **shares the pending-map / timeout / close-deny mechanisms** with `PermissionBroker` (extract a common core or reuse it through a sibling implementation). These requirements are identical to permission and invisible from the protocol/UX, so reuse the plumbing (the benefit of C).
- On answer receipt, return `{ behavior: "allow", updatedInput: { ...input, answers } }`. On `cancelled` / timeout / close, return `{ behavior: "deny", message }`.
- The host holds `#pendingQuestion` and persistently attaches `pending_question` to `state_change.ext` during `waiting_question` (same pattern as ADR-0022 F3).

### F6: Viewer delivery follows ADR-0021’s allow-list

Deliver `question_request` only to operators; completely remove it from viewers and replace it with a synthetic `state_change(waiting_question)` (`payload={}` / no `ext`) for grid consistency (same treatment as `permission_request`). Because `ext.pending_question` is in ext, it is automatically protected by “viewers have ext removed for every type” (no additional guard). Add `question_request` / `question_response` to the server’s operator-only allow-list.

### F7: Restore from a snapshot

`question_request` does not piggyback on state_change, but because the source of truth `ext.pending_question` is on the latest state_change envelope, it is restored as-is in a snapshot for a newly joined client (same pattern as ADR-0022 F5). DETS persistence is unnecessary.

## Consequences

### Positive

- The dashboard can render structured choices (label / description / preview / multiSelect / Other) in a dedicated dialog and correctly return the answer to the SDK (root fix for #78).
- It does not piggyback on permission’s meaning and is consistent with the protocol’s state-separation idea.
- Pending state is restored from an `ext.pending_question` snapshot after reload / reconnection.
- Viewer leakage is automatically protected by ADR-0021’s allow-list / ext removal.
- Inter-agent `escalate-to-user` ([protocol-inter-agent](../specs/protocol-inter-agent.md)) can reuse the same structured dialog (the concrete implementation of that spec’s “reuse the existing AskUserQuestion UI”).

### Negative

- The new `waiting_question` state affects the protocol state table / mermaid, `state.ts`, and the client’s state-to-expression mapping. Make the “waiting for a choice” character representation work with existing assets for now; add dedicated assets later.
- Apply the unlimited broker timeout (ADR-0022 F6) to questions as well, so an operator who does not respond leaves the turn unadvanced (same behaviour as permission; forcibly deny on close()).

### Neutral

- Normalise `answers` into one string joined by the client for multiSelect (1:1 with the SDK’s `answers: Record<string,string>`). If structured retention becomes necessary, extend it in a backward-compatible addendum (leave `version` unchanged).
- Do not pass through `annotations` (per-question notes/preview) for now; add it later if needed.

## Alternatives Considered

| Option | Why rejected |
|---|---|
| A: Extend permission_request/decision | Piggybacks the meanings of allow/deny and structured answers. The dashboard’s rendering branch becomes field sniffing, muddying permission’s meaning and creating a drift nursery |
| C: Dedicated wire type but reuse waiting_permission for state | Inconsistent with the existing separation of permission/input. Broker-plumbing reuse is already incorporated in F5 of this ADR |
| Receive through the onUserDialog path | Incorrect. `onUserDialog` is for other dialog_kind values such as refusal_fallback_prompt / side_question; AskUserQuestion uses the canUseTool path (confirmed in the official docs) |

## Related

- specs: [protocol](../specs/protocol.md) (add `question_request` type, `ext.pending_question`, direction-specific `question_response`, and `waiting_question` state), [protocol-inter-agent](../specs/protocol-inter-agent.md) (the “reuse the existing AskUserQuestion UI” for escalate-to-user points to this ADR’s implementation), [agent-sdk-events](../specs/agent-sdk-events.md) (the AskUserQuestion branch and answer return in the canUseTool path), and [threat-model](../specs/threat-model.md) (viewer leakage automatically covered through ADR-0021).
- ADRs: [0021](0021-role-information-disclosure-policy.md) (allow-list foundation for operator-only delivery), [0022](0022-pending-permission-authoritative-source.md) (prototype of the same pattern: ext = truth for pending state).
- Origin: [issue #78](https://github.com/sakuraiyuta/kaoiro/issues/78).
