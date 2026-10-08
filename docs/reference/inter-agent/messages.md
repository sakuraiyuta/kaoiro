---
title: Inter-agent message contract
status: provisional
last_updated: 2026-10-08
description: Inter-agent message contract and its boundaries.
---

# Inter-agent message contract

Structure is defined by `Envelope`, `InterAgentMessagePayload`, and
`InterAgentMessageKind` in [@kaoiro/protocol](../../../protocol/src/index.ts);
this page specifies the corresponding semantics.

## Send result

An accepted send returns the existing `ingress_stamp: [us, seq]` plus additive
`delivery_authority`, `delivery.advisory`, and, when an operation was carried,
`work_control_result`. Older servers omit the additive keys; wrappers preserve
legacy acceptance and show no advisory. The advisory contains
`recipient_state`, `granted`, optional `downgrade`, `mechanism`,
`unresolved_count`, and guidance. `mechanism` is `queue`, `fold`, `cut`,
`steer`, `hook`, or `unknown`; receivers normalize unrecognized values to
`unknown`. Guidance describes the accepted delivery and does not ask the sender
to resend it.

A `work_operation_deduplicated` rejection has no `ingress_stamp` and sets
`send_not_attempted: true`; its details carry the operation receipt and
delivery knowledge (`recorded`, `not_recorded`, or `unknown`). The body was not
sent by this attempt, so the sender must consult that delivery knowledge and
explicitly decide whether to start a new delivery. A `work_outcome_unknown`
rejection also has no `ingress_stamp`; it carries the `operation_id`. Query
`work_op_result` with that ID and retry with the same ID only if it was not
applied. A yield-only WorkStore timeout is downgraded and proceeds as an
accepted send, rather than returning `work_outcome_unknown`. If a work
operation applies but yield-token issuance fails, its receipt remains applied
and early is only a fallback delivery mode. Recipient capability and early
quota checks still apply, so the final send result may grant early or normal
with a downgrade such as `yield_token_unavailable`, `recipient_legacy`,
`unsupported_by_recipient`, or `early_quota`. Treat the reply's
`delivery_authority.granted` and `.downgrade` as the final result; the work
receipt records the operation result and delivery knowledge, not that downgrade.
See [work authority and operations](work.md#work-authority-and-operations).

### Early input that waits in the queue

`granted: early` and `mechanism` in a send result state what the server granted
and what the recipient can do. They do not say whether this input steered the
running turn. A Codex app-server recipient can steer a correction into its
sender's running request, overtaking queued ordinary messages even in the
same conversation. Ordinary messages stay queued and arrive afterwards.
It still queues early input behind its sender's host-queue root already
dispatched for another turn,
an earlier early fallback, another token's same-CID root or a legacy root,
operator or synthetic input, or placeholders. The per-turn caps also apply:
three IA writes overall, and at most two while host-queue peer roots wait.
The send result does not report the hold; the recipient's wrapper logs the
reason (see [Codex app-server](../engines/codex-app-server.md#when-an-early-input-is-queued)).

Send an early correction to change the running request. A normal message
waits for a root or stale-basis recovery. An overtaken ordinary message's
next root can itself get `stale_reply_basis` if the later early ticket was
not spent. A retained, corroborated steer returns its body and a fresh
authorization inline; retry with both fields from that authorization.
Wait for confirmed input only when the rejection returns no retained body.
To stop the work at once, the operator interrupts the turn; hard
cancellation stays operator-only
([ADR-0063](../../adr/0063-layered-delivery-authority-and-continuations.md) D2).

### envelope.type: "inter_agent_message"

The common envelope outer shape in [protocol.md](../protocol/envelope.md#terms-and-hierarchy)
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
| `error.code` | optional | Open-string error code indicating the peer became unable to respond (see [“Unresponsive-error notices”](errors.md#unresponsive-notices-payloaderror)) |
| `error.message` | MUST when `error` exists | Human-readable reason with secrets masked and truncated |
| `error.affected_deliveries` | optional on negotiated `turn_failure` notices | Nonempty, strictly increasing list of `{delivery_seq, peer_turn_number, batch_id}` identifying exactly which steer inputs the notice covers. The server validates shape, owner, generation, size and allowed error codes; old unscoped notices remain conservative. The receiving wrapper matches both CID and peer turn before consuming a synchronous waiter. |
| `notice_attribution` | optional negotiated receiver marker | `"v1"` marks an early peer delivery whose sender supports sequence-attributed failure notices. It does not authorize a reply. |
| `owner.kind` | MUST | `"user"` or `"agent"` |
| `owner.id` | MUST | Declared owner identifier. The current shared sender emits the placeholder `"operator"`, not an authenticated user ID; the server validates its string shape, not a binding to the connection principal. See [“Conversation owner and tie-breaker”](conversations.md#conversation-owner-and-tie-breaker) |
| `delivery_intent` | optional | `normal` (default), `early`, or `yield`; the requested delivery mode. Non-normal values require negotiated delivery modes. |
| `work_id` | MUST with `delivery_intent: "yield"` | Work targeted by the yield; work operations also carry their own `work_id`. |
| `expected_authority_epoch` | MUST with `delivery_intent: "yield"` | Caller-supplied expectation, normally copied from an observed work stamp. The wrapper checks presence and numeric shape, then copies it unchanged; it does not prove the caller observed it. The server enforces the expected epoch against the current grant. |
| `work_control` | optional | One typed operation with `operation_id`, requiring negotiated `work_control: "v1"`. Applied before conversation admission and never relayed as executable input. |
| `delivery_authority` | server-owned | Requested and granted intent, downgrade, and a `yield_token` only for a granted yield. A sender-supplied value is rejected. |
| `work` | server-owned | `{work_id, revision, authority_epoch, state}` at admission for a linked conversation. A sender-supplied value is rejected. |
| `work_control_result` | server-owned | `{op, operation_id, outcome}` replaces an applied `work_control` in the relayed payload. A sender-supplied value is rejected. |

The work and delivery fields are additive v0 wire shapes from
[ADR-0063 phase 1](../../plans/issue-429-delivery-authority-protocol.md).
Their effect requires server and wrapper negotiation; a type declaration alone
does not activate the control. A successful work operation can precede a
failed message admission, so its receipt and message-delivery knowledge must
be reported separately.

The wrapper treats `expected_authority_epoch` as the caller's expectation,
not as evidence that the caller observed the stamp. The server's grant and
epoch check is the authority boundary.

A former assignee may read only its pending transfer obligations through
`work_status`. Each such obligation includes `work_id` and `transfer_id`, so
the former assignee can call `work_transfer_ack` even if the best-effort
`work_notice` was lost. A named lookup returns
`{work_id, access: "transfer_pending", pending_transfers}` instead of a
complete work record for this role. `work_transfer_ack` returns only
`{work_id, transfer_id, state: "acknowledged"}`, never a full work record.
See [work authority and operations](work.md#work-authority-and-operations).

For negotiated v1 ordinary sends, `in_reply_to` names the latest ordinary peer
turn actually handed to the sender; the server rejects a stale basis before
accepting the message. An internal `notice_type` identifies one of the two
validated, non-ordinary notices. A recovery `loss_id` identifies a reported
delivery loss independently of its transport sequence. Their validation and
ownership rules live in [reply basis](reply-basis.md#negotiation-and-comparison)
and [delivery](delivery.md#negotiated-gap-recovery).

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

## Constraints

- MUST: Route by `to` without interpreting an agent's `body` or deciding the
  meaning of its `kind`. Admission does interpret `meta.done` for mutual
  closure and, for negotiated v1 sends, compares `in_reply_to` with ordinary
  peer history. The server validates internal `notice_type` and `payload.error`
  before exempting a notice from that history. This is the implemented boundary
  in `wrapper_channel.ex` (`preflight_inter_agent`, lines 2479–2491 at
  87500b55) and `ConversationStates.record_bound_message/8`; see
  [conversation lifecycle](conversations.md#conversation-lifecycle-and-post-close-handling-issue-167)
  and [reply basis](reply-basis.md#negotiation-and-comparison). The server also
  synthesizes reachability notices for peers.
- SHOULD: Truncate `body` at 16 KB on the wrapper like other protocol fields and
  set `meta.truncated=true`.

### Reserved `envelope.type` and version

`inter_agent_message` is a settled type in the
[envelope contract](../protocol/envelope.md#envelope-v0); it keeps `version`
unchanged ([ADR-0010](../../adr/0010-protocol-precisification.md) and
[ADR-0015](../../adr/0015-protocol-version-stamping.md)).

| type | status | payload |
|---|---|---|
| `inter_agent_message` | **settled** (this spec) | see “Inner envelope” above |

## Related inter-agent topics

- [Inter-agent messaging](../../architecture/inter-agent-messaging.md).
- [Inter-agent conversation contract](conversations.md).
- [Inter-agent conversation admission](conversation-admission.md).
- [Approval](../security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration) and [session-operation tools](session-tools.md).
- [Delivery confirmation and recovery](delivery.md).
- [Send and wait](send-and-wait.md).
- [Coordination monitoring and display](coordination-monitoring.md).
- [Peer directory and companion tools](directory.md).

## Input-bound reply contract

See [negotiation and comparison](reply-basis.md#negotiation-and-comparison)
and the [internal notice exception](reply-basis.md#internal-notice-exception).
