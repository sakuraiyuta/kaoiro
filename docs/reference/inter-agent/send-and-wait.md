---
title: Send and wait
status: provisional
last_updated: 2026-09-27
description: Send and wait contracts and compatibility.
---

# Send and wait

The structural type `InterAgentMessagePayload` is defined in
[@kaoiro/protocol](../../../protocol/src/index.ts).

### Sending a normal reply

For a normal reply to confirmed wrapper-delivered input, omit both
`in_reply_to` and `reply_ticket`; the wrapper uses that input turn's frozen
default basis. Same-turn waiter and recovery results are different: copy both
fields from their handed-off `reply_authorization`. Supplying only one field,
or supplying a basis without its matching ticket, is rejected locally with
`send_not_attempted: true`. The wrapper's guidance distinguishes a matching
usable authorization, a different-basis or exhausted ticket, a frozen-basis
mismatch, and unknown issuance history; see the [reply-basis guidance
table](reply-basis.md#explicit-replies-and-tickets).

### Receiver-side behavior (wrapper-B)

For an inbound `envelope` (type `inter_agent_message`, `agent_id` not self)
selected for next-turn SDK injection, the following is the body/meta excerpt
for an ordinary message, not the complete injected text. The formatter prepends
a conversation marker with reply or close-proposal guidance. Error notices use
a dedicated `peer-error(...)` line; a multi-message batch also has a preamble
and separators between the individual formatted messages:

```text
[from <agent_id>] <kind>: <body>

(meta: done=<done>, propose_next=<propose_next>, conversation_id=<conversation_id>, turn_number=<turn_number>)
```

An agent replies with `send_to_agent` when it chooses to respond. Otherwise a
normal `result` envelope is sufficient; it need not send `done`. The
conversation remains open until both sides send `done=true`, a hard limit is
exceeded, or `open_conversation_ttl_ms` elapses (default 24 hours, issue
#211). The former server `max_wallclock` hard limit automatically attached
`done` on timeout; issue #211 removed it. `open_conversation_ttl_ms` is now
memory reclamation rather than a hard-limit escalation or evidence of mutual
agreement. GC closes the server entry and sends a synthetic `kind: "done"`,
`meta.done: true` notice; a receiving wrapper learns that closure without
injecting the terminal notice into an SDK turn (see
[conversation lifecycle](conversations.md#conversation-lifecycle-and-post-close-handling-issue-167)).

#### Coalescing pending messages (issue #211 phase 3)

- **The trigger is busy state, not a time debounce.** An idle wrapper injects a
  lone message immediately with no added delay. Only messages from the same
  peer that arrive while an injection is pending join the next flush batch.
- **Preserve receive order.** Each message keeps its own
  `[from <agent_id>] <kind>: <body>` block (including its conversation_id) and
  blocks are concatenated in arrival order. The model can select the matching
  conversation from each block.
- **Cap count and total size.** A batch has at most **10 messages** (the same
  order as `MAX_ATTACHMENTS_PER_INSTRUCTION`) and formatted text totals at most
  **16,384 bytes** (the wrapper's `MAX_INPUT_BYTES`,
  `MAX_TASKLIST_ITEMS_JSON_BYTES`, and `MAX_LOG_BYTES`). Overflow is **not
  dropped**; defer it to the next batch/turn. A single oversized message still
  delivers by itself; the first item is always included regardless of the cap.

**Trade-off: one turn failure affects every conversation in the batch.**
After sending a turn to the SDK the wrapper cannot identify which message
caused a failure. If a coalesced turn fails with `context_overflow`,
`api_error`, or similar, send a `payload.error` notice (see [“Unresponsive
  notices”](errors.md#unresponsive-notices-payloaderror)) **separately for each still-pending conversation_id owned by that
turn's token**, addressed to its recorded sender. Already-resolved entries and
entries owned by another turn are skipped. Because a batch contains only one
peer's messages, the same peer can receive notices for multiple conversations;
messages from other peers are not part of that batch. This is an intentional cost of reducing
turn count (Chloe ruling, 2026-08-11); the total-size cap also limits how often
large batches trigger context overflow.

Replies consumed by a `send_to_agent.wait_for_response` waiter are not
coalesced: the waiter consumes the inbound envelope immediately, so no SDK
turn injection occurs (below).

#### Synchronous reply wait (`send_to_agent.wait_for_response`)

Normal reception injects the next SDK turn as above. When the current SDK turn
needs the peer's answer, the sender may set `wait_for_response: true`. After
sending, the wrapper waits for the next inbound envelope for the same
`conversation_id` and returns the complete envelope (including `body` and
`meta`) in the **same tool result**.

- Default is `false`; existing fire-and-forget and next-turn injection are
  unchanged.
- `timeout_ms` defaults to 300,000 ms, must be a positive integer, and is
  capped at 300,000 ms. On timeout return the send ack and `reply_pending=true`;
  do not cancel the send.
- Do not inject an envelope consumed by the waiter into the next SDK turn.
  An envelope arriving after timeout is injected normally.
- Allow one waiter per `conversation_id`; reject duplicate synchronous waits
  before sending.
- If the server rejects the send (`unknown_agent`, etc.) or no acceptance ack
  arrives, **release the waiter immediately** and return a reject or delivery-
  unknown result (Fujino 30-10 M5, 2026-08-08). Do not wait the full timeout for
  a peer that cannot answer.

## Send acceptance and rejection

Errors for unknown `to`, self-routing, participant mismatch, invalid
`turn_number`, stale turns, closed conversations, or explicitly unknown
conversation IDs (`unknown_agent`, `self_routing`, `participants_mismatch`,
`invalid value: payload.turn_number`, `stale_turn`, `conversation_closed`
 (the latter three from issue #167), `unknown_conversation_id` (issue #252),
`delivery_backlog`, `peer_reconnecting`, `peer_reconnecting_capacity` (issue #256), and
`disconnected` (issue #257, when `to` is known but not currently connected
and no planned intent covers it)) are returned in the `envelope` reply.
`peer_reconnecting` and `disconnected` are normalized by the wrapper to a
structured `peer_error` (`code=reconnecting` / `code=disconnected`
respectively). A disconnected rejection also carries optional
`disconnect {origin, reason}` and maps it to the peer error's `origin` /
`reason`, distinct from a generic tool error; either reject happens
before `ConversationStates.record_message`, so it never mutates the delivery
ledger or either pane. `peer_reconnecting_capacity` is a terminal tool error:
the message was not accepted and no close notice was scheduled; fixed
wording asks the sender to retry later with the same conversation_id.

Negotiated v1 also rejects `stale_reply_basis` before delivery and can return
an inline recovery envelope. Ordinary sends use their live origin's bound
input snapshot as the default basis. An explicit same-turn override must supply
both `in_reply_to` and `reply_ticket`; a missing, expired, or mismatched ticket
then fails locally. Unbound or retired tool origins also fail locally with
`send_not_attempted: true`.
Definite temporary refusal can issue a fresh ticket; an unknown send outcome
cannot. The [reply-basis contract](reply-basis.md#explicit-replies-and-tickets)
defines the correction path.

- MUST: Reject self-routing where `payload.to == agent_id`.

## Related topics

- [Message fields](messages.md).
- [Conversation lifecycle](conversations.md).
- [Dispatch and coalescing](../../architecture/inter-agent-messaging.md#dispatch-and-coalescing).
- [Approval flow](../security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration).
- [Companion tools](directory.md#companion-tools-wrapper-sdk-mcp).
- [Delivery confirmation and recovery](delivery.md).

## Input-bound reply contract

See [explicit replies and tickets](reply-basis.md#explicit-replies-and-tickets).
