---
title: Inter-agent message contract
status: provisional
last_updated: 2026-09-18
description: Inter-agent message contract and its boundaries.
---

# Inter-agent message contract

Structure is defined by `Envelope`, `InterAgentMessagePayload`, and
`InterAgentMessageKind` in [@kaoiro/protocol](../../../protocol/src/index.ts);
this page specifies the corresponding semantics.

### envelope.type: "inter_agent_message"

The common envelope outer shape in [protocol.md](../../specs/protocol.md)
(`version`/`agent_id`/`session_id?`/`persona`/`display_name?`/`ts`/`seq`/`type`/`state`/`payload`/`ext`)
is inherited unchanged. `agent_id` is the sending agent and `state` remains the
current state of that wrapper (normally `tool_running`).

Only the `type` value and `payload` schema are new.

| Field | Meaning |
|---|---|
| `type` | `"inter_agent_message"` |
| `payload` | See “Inner envelope” below |

### Inner envelope(`payload` schema)

```json
{
  "to": "lab-pc-1.claude-b",
  "conversation_id": "cnv-7f3a1c",
  "turn_number": 3,
  "kind": "propose",
  "body": "ベンチマーク結果を踏まえ、CSV 出力を採用するのはどうか",
  "meta": {
    "done": false,
    "propose_next": "B の同意があれば実装に入る",
    "confidence": 0.7
  },
  "owner": {
    "kind": "user",
    "id": "operator"
  },
  "new_conversation": false
}
```

| Field | Required | Meaning |
|---|---|---|
| `to` | MUST | Destination `agent_id`; `[A-Za-z0-9._-]` constraint is shared by the protocol |
| `conversation_id` | MUST | Identifier linking one conversation. The initiating wrapper assigns it (session-unique, UUIDv4-based) |
| `new_conversation` | MUST (compliant wrapper); server treats omitted as `true` (see [admission](conversation-admission.md)) | Boolean. True only when the sender omitted `conversation_id` and this wrapper assigned a new one (issue #252); false for explicit IDs, replies, and notices. The server uses it to distinguish an omitted new ID from an explicit unknown ID—see [“Explicitly specified unknown conversation_id”](conversation-admission.md#explicitly-supplied-unknown-conversation_id-issue-252) |
| `turn_number` | MUST | Positive integer starting at 1; increment per send in a conversation. `(conversation_id, turn_number)` defines total order |
| `kind` | MUST | Nine-value enum below |
| `body` | MUST | Free-text message body; agents define its semantics |
| `meta.done` | MUST | Boolean. True when this agent proposes ending the conversation. **Both owner-side agents must send true to complete** |
| `meta.propose_next` | MUST | String describing the next expectation (may be empty) |
| `meta.confidence` | optional | 0.0–1.0 |
| `meta.reject_reason` | MUST when `kind=reject` | String with the concrete reason for rejecting a proposal |
| `error.code` | optional | Open-string error code indicating the peer became unable to respond (see [“Unresponsive-error notices”](../../specs/protocol-inter-agent.md#unresponsive-notices-payloaderror)) |
| `error.message` | MUST when `error` exists | Human-readable reason with secrets masked and truncated |
| `owner.kind` | MUST | `"user"` or `"agent"` |
| `owner.id` | MUST | Declared owner identifier. The current shared sender emits the placeholder `"operator"`, not an authenticated user ID; the server validates its string shape, not a binding to the connection principal. See [“Conversation owner and tie-breaker”](conversations.md#conversation-owner-and-tie-breaker) |

### kind enum (nine values)

Semantics and adoption decisions are in kaoiro repository issue #17
issuecomment-5384349594.

| kind | Role | Typical pair |
|---|---|---|
| `request` | Work request | → `response` |
| `response` | Result report | `request` ← |
| `query` | Question (yes/no, value, opinion) | → `inform` |
| `inform` | Information, opinion, or answer to a query | `query` ← or standalone |
| `propose` | Candidate agreement | → `accept` or `reject` |
| `accept` | Agreement with propose | `propose` ← |
| `reject` | Opposition to propose (`meta.reject_reason` required) | `propose` ← |
| `escalate-to-user` | Request for human tie-breaker; also used for server-synthesized notices on hard-limit breach | → user |
| `done` | Completion declaration | Agent-originated completion requires both owner sides. Server notices at `open_conversation_ttl` (issue #211 direction 2) also use this kind, but are one-shot, one-way events distinct from agent-to-agent agreement |

Covered cases:

- Request: `request` → `response`
- Consultation: `query` → `inform` exchange
- Debate: `propose` → `accept` / `reject` → the other side proposes an alternative
  → both owner sides `accept` + `done` on the final `propose`
- No conclusion: `escalate-to-user` at any point, or automatic cutoff on a hard-limit breach

### Reserved `envelope.type` and version

Add `inter_agent_message` to the type list in [protocol.md](../../specs/protocol.md) as a
**settled addendum** (keep `version` unchanged;
[ADR-0010](../../adr/0010-protocol-precisification.md) and
[ADR-0015](../../adr/0015-protocol-version-stamping.md)).

| type | status | payload |
|---|---|---|
| `inter_agent_message` | **settled** (this spec) | see “Inner envelope” above |

## Related inter-agent topics

- [Inter-agent messaging](../../architecture/inter-agent-messaging.md).
- [Inter-agent conversation contract](conversations.md).
- [Inter-agent conversation admission](conversation-admission.md).
- [Remaining protocol topics](../../specs/protocol-inter-agent.md), including delivery, approval, observation, and companion tools.
