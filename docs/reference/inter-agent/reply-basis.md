---
title: Input-bound inter-agent replies
description: Negotiated reply basis, single-use tickets, recovery handoff, and engine origin guards.
status: provisional
last_updated: 2026-09-26
related: [messages, conversations, delivery, send-and-wait]
---

# Input-bound inter-agent replies

## Negotiation and comparison

A wrapper requests `inter_agent_reply_basis: "v1"` in its channel join. The server
must echo `"v1"` before protected sends start. Without that echo, the wrapper
reports `legacy`; legacy sends remain accepted and are outside server basis
protection. Reconnection negotiates again. Directory entries and `whoami` expose
the current mode; a missing mode is unknown, not protected.

An ordinary v1 send carries `payload.in_reply_to`, an integer from zero through
9,007,199,254,740,991. Zero means no ordinary peer input has been handed off in
this conversation. The server compares it with the latest accepted ordinary
turn from the destination in this CID, in the same `ConversationStates` operation
that admits the new transport turn. On mismatch, `stale_reply_basis` includes
`conversation_id`, `expected_peer_turn`, and `supplied_basis`. It does not advance
conversation history or deliver the rejected body. This comparison precedes the
transport-turn stale check. Existing participant, closure, quota, and delivery
admission checks still apply.

Operator instructions and external-human messages are not ordinary peer turns.
A validated internal notice does not advance ordinary history. An old wrapper's
notice without the discriminator remains ordinary history: its full envelope
must be handed off before it can authorize a v1 reply.

## Default basis and tool origin

Each SDK input publishes a fixed snapshot of envelopes actually passed to that
turn, after coalescing and terminal-item removal. If turns N and N+2 from the same
peer/CID survive in one batch, its default is N+2. Queue arrival and delivery ack
alone do not publish input. Inline waiter/recovery results affect future input
snapshots but never update the current turn's default.

The wrapper captures that default through an origin bound to the tool call. It
checks origin liveness again immediately before the send sink, after asynchronous
waits. Retired or unbound calls fail locally with `send_not_attempted: true`.
They cannot borrow the current turn's snapshot.

| Adapter | Origin binding |
| --- | --- |
| Claude | Observed assistant `tool_use.id` to turn token; the SDK MCP callback resolves `_meta["claudecode/toolUseId"]` and combines native cancellation with turn retirement |
| Codex exec | A private ToolHost endpoint and captured token per execution turn; endpoint lifetime ends before another turn begins |
| Codex app-server | Bridge-preserved `x-codex-turn-metadata` thread/turn IDs matched to the authoritative start result and wrapper token; absent/mismatched metadata is rejected |
| Antigravity | Native engine boundary remains a measurement gate; no full-engine protection claim or v1 activation follows from ToolHost-only measurements |

## Explicit replies and tickets

To intentionally reply to input received inside the same SDK turn, copy both
`in_reply_to` and `reply_ticket` from the returned `reply_authorization`. Explicit
basis without a valid ticket is rejected even if its number matches the default.
A ticket uses 256 random bits and is bound to the wrapper session, SDK turn token,
CID, peer, and peer turn. It authorizes one attempted send and is spent before an
asynchronous send. A later call cannot obtain authorization merely by guessing
a future peer turn number.

Tickets become usable only at complete tool-result handoff. `expires_in_ms:
300000` is the lifetime from that handoff, not remaining time when the model
reads the result. Turn retirement and session replacement invalidate tickets.
Closed conversations cannot send. At most 256 ticket records are held per turn.
New authorization supersedes unused authorization for the same peer/CID.

Tickets appear in tool results and transcripts; confidentiality is not a
requirement. Unpredictability before issuance and origin/binding checks are the
requirements. Do not repeat tickets in diagnostics.

| Outcome | Retry authorization |
| --- | --- |
| Missing/mistyped/wrong-CID ticket | Local error; no send. Other valid tickets remain usable and can be copied correctly |
| Spent or expired ticket | Local error; the same value cannot be reused |
| `peer_reconnecting_capacity` / `delivery_backlog` | Definite nonacceptance: return a fresh ticket for the same observed input, for an intentional retry |
| `stale_reply_basis` | Only newly handed-off recovery bodies authorize a new ticket |
| Accepted | Spent; a separately received waiter/recovery input can authorize another reply |
| Unknown delivery / ack timeout | No renewed ticket; automatic retry could duplicate a delivery |
| Closed or other permanent rejection | No renewal |

The wrapper does not automatically resend a rejected body. Local errors include
`send_not_attempted`, a distinct error code, and correction guidance.

## Inline recovery and ownership

A stale rejection can return already-received, ordinary, undelivered envelopes
for that peer/CID in arrival order. Recovery contains at most ten whole messages
and at most 16,384 UTF-8 bytes for the complete serialized tool result, including
authorization and unread advice. An oversized oldest message stays queued and
produces `oversized_pending`; later messages cannot skip it. If a newer accepted
message has not arrived locally, the result reports `awaiting_delivery`.
`unread_remaining` and `more_pending` describe queued work after this handoff.

The coordinator claims exact items from pending or host-queued input. Claimed
items cannot also enter an SDK input. Result handoff activates authorization,
records provenance, transfers pending-reply ownership, and acknowledges exactly
the returned envelopes. Before handoff, cancellation, serialization failure, or
connection loss returns ownership without ack. The adapter checks liveness
immediately before its synchronous write/return; socket backpressure is not a
failure. Failure after handoff does not trigger automatic duplicate injection.
This is a dispatch boundary, not proof that a model reasoned about the body.

The same handoff applies to `wait_for_response`, including the full ordinary
`peer_error_envelope` from legacy notices. Validated notices and server-authored
synthetic errors preserve `peer_error` but do not authorize a peer-turn override.
A timeout does not consume a later reply: normal delivery handles it.

Kaoiro tool results include unread-count advice. It counts pending, host-queued,
and leased-but-uncommitted input; a recovery result projects its post-handoff
count. It is informational and never substitutes for the server comparison.

## Internal notice exception

Only negotiated v1 wrappers can use `notice_type: "turn_failure"` or
`"stale_delivery"`. The server requires `kind: "inform"`, an existing CID,
`new_conversation: false`, `meta: {done: false, propose_next: ""}`, no basis,
confidence, rejection decision, or extra payload/error fields, and canonical
code/message/body templates. The shared
[protocol fixture](../../../protocol/fixtures/inter-agent-internal-notices.json)
defines producer/validator examples. `rate_limit` may include a safe nonnegative
`reset_delay_seconds` with the exact canonical duration suffix.

These notices still advance transport turns and use normal delivery/quota
accounting. They neither close conversations nor advance ordinary peer history.
`resolveTurnEnd` and stale-delivery producers use the acceptance-aware notice
sink. Rejected or unknown notices produce bounded diagnostics, without resend or
retrospective delivery ack. A legacy wrapper's arbitrary `error` payload is not
an exemption.

## Rollout boundary

Deploy the server before upgraded wrappers; prepare runner artifacts first.
During mixed operation old wrappers continue sending, marked unprotected. New
wrappers use the negotiated mode and can reply to legacy waiter/error envelopes.
Record server switch, last old-wrapper retirement, each v1 join, and first
successful ordinary exchange. Roll back a failing wrapper to the prepared prior
artifact; rolling the server back requires rejoin and visible legacy mode.

Deployment scope for Antigravity remains subject to native measurement and the
operator's decision. Neither installation nor a directory mode label establishes
the native-engine guarantee. See the approved
[implementation and operational measurement plan](../../plans/issue-407-message-crossing.md)
and [decision record](../../adr/0062-input-bound-inter-agent-replies.md).
