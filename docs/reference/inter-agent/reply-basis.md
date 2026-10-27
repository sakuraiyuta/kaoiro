---
title: Input-bound inter-agent replies
description: Negotiated reply basis, single-use tickets, recovery handoff, and engine origin guards.
status: provisional
last_updated: 2026-10-27
related: [messages, conversations, delivery, send-and-wait]
---

# Input-bound inter-agent replies

## Negotiation and comparison

A wrapper requests `inter_agent_reply_basis: "v1"` in its channel join. The server
must echo `"v1"` before protected sends start. Without that echo, the wrapper
reports `legacy`; legacy sends remain accepted and are outside server basis
protection. Reconnection negotiates again. A queued send waits inside its CID
lock for negotiation, then captures the mode and join generation. Immediately
before pushing, ServerLink requires that generation still matches and the socket
and channel are joined. Protected inter-agent sends never enter Phoenix's
reconnect buffer. An already-written push may still have an unknown outcome;
it is not automatically retried.

Channel `phx_close`, normal socket close (code 1000), and `ServerLink.close()`
are terminal: pending and future sends return local `reply_basis_closed` with
`send_not_attempted: true`; no retry ticket is issued. Recoverable channel/socket
errors wait for rejoin. Join error/timeout releases current waits as failed;
every negotiation wait also has a fixed ten-second deadline. A failed wait
returns local `reply_basis_pending`, even if rejoin succeeds before its
continuation runs. A finite same-CID queue drains without overtaking: each call
releases its slot after bounded negotiation or acknowledgement. Abort retires
the call's input without changing the connection's negotiation state. See the
[lifecycle table](../../plans/issue-407-rejoin-followup.md#channelsocket-lifecycle-contract).

Directory entries and `whoami` expose
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
snapshots but never update the current turn's default. Confirmed inputs from a
completed turn are merged by CID and peer into a session-local ledger. A new legacy
Claude SDK notification turn copies that ledger; queued or unconfirmed input
does not enter it. A notification folded into a live wrapper turn keeps that
turn's earlier snapshot.

The wrapper captures that default through an origin bound to the tool call. It
checks origin liveness again immediately before the send sink, after asynchronous
waits. Retired or unbound calls fail locally with `send_not_attempted: true`.
They cannot borrow the current turn's snapshot.

An `unbound_tool_call` means no confirmed live turn owns that call;
adding a ticket, changing the conversation ID, or retrying within the same
continuation cannot bind it. A `stale_tool_call` means its owning input ended
or was cancelled. Neither error attempts a send. A new confirmed wrapper input
or validated Claude SDK notification prompt is required before retrying either
call. Unknown notification shapes and reused retired prompt IDs remain unbound.

| Adapter | Origin binding |
| --- | --- |
| Claude | A confirmed root `UserPromptSubmit.prompt_id` owns its `PreToolUse.tool_use_id`; a validated background-task notification (explicit or timeout-promoted background Bash, background Agent, or Workflow; see [Claude events](../engines/claude-events.md)) either folds into that live owner or starts an independent token from confirmed completed input. The SDK MCP callback resolves `_meta["claudecode/toolUseId"]` and combines native cancellation with turn retirement. |
| Codex exec | A private ToolHost endpoint and captured token per execution turn; endpoint lifetime ends before another turn begins |
| Codex app-server | Bridge-preserved `x-codex-turn-metadata` thread/turn IDs matched to the authoritative start result and wrapper token; absent/mismatched metadata is rejected |
| Antigravity | Native engine boundary remains a measurement gate; no full-engine protection claim or v1 activation follows from ToolHost-only measurements |

## Native continuation snapshots

The [Claude native continuation mode](../engines/claude-events.md#native-continuation-ownership)
uses a detached immutable copy of the confirmed launch owner's map for Agent
reports and Monitor events/completions. Source-owner retirement does not erase
that copy. It contains no waiter, recovery or fold tickets, abort signal, or
pending input, and session reset invalidates it. An inactive reactivation gets
a new snapshot from its confirmed root; known live-target messages do not.
Agent peer hand-back and native completion share one report slot and the same
launch snapshot. Completion selects that snapshot by its native call/task/run
and matching opener runId; result markers are ignored. Only peer hand-back
requires the canonical report marker. Default permission mode can return by
completion without advertising a hand-back tool.

Bash and Workflow retain the completed-map snapshot taken at their opener.
A folded notice keeps the already-live owner's snapshot. Multiple proved blocks
must all select the same map: a Monitor launched at N combined with Bash opened
after N+1, or two Monitors launched under different maps, refuses atomically with
`batch-basis-conflict`. Maps are never merged or replaced by the latest ledger.
This can reject a batch that legacy mode would accept.

A long-running Monitor can therefore send with an older default and receive
`stale_reply_basis` after newer confirmed input. Existing recovery rules apply;
no current-input guessing is permitted. Each detached origin requires its
asynchronous native-evidence validator at the actual common send site, followed
by a synchronous lease check. Missing or invalid proof refuses locally before a
transport attempt. Source claim retirement and the admitted root lease are
separate: stopping the source blocks future claims without borrowing or erasing
an already-admitted root's authority.

## Explicit replies and tickets

To intentionally reply to input received inside the same SDK turn, copy both
`in_reply_to` and `reply_ticket` from the returned `reply_authorization`. Explicit
basis without a valid ticket is rejected even if its number matches the default.
A ticket uses 256 random bits and is bound to the wrapper session, SDK turn token,
CID, peer, and peer turn. It authorizes one attempted send and is spent before an
asynchronous send. A later call cannot obtain authorization merely by guessing
a future peer turn number.

Every tool result that carries `reply_authorization` also carries
`reply_authorization_guidance`, one sentence that names `in_reply_to` and
`reply_ticket`. A Claude session resumed across a wrapper upgrade keeps the tool
description it recorded
([ADR-0065](../../adr/0065-footer-changes-on-resumed-sessions.md)), which may not
list the two properties; the sentence tells such a session which arguments to
pass. A result without `reply_authorization` never carries it.
A Claude fold with at least one provisional `reply_authorization` includes the
same sentence once before its authorization lines; see
[Claude recipient handoff](delivery.md#claude-recipient-handoff).

Tickets become usable only at complete tool-result handoff. `expires_in_ms:
300000` is the lifetime from that handoff, not remaining time when the model
reads the result. Turn retirement and session replacement invalidate tickets.
Closed conversations cannot send. At most 256 ticket records are held per turn.
New authorization supersedes unused authorization for the same peer/CID.

When a call supplies `in_reply_to` without `reply_ticket`, the wrapper rejects
locally with `reply_ticket_required` and applies this table. `P` is the supplied
basis, `F` is the live origin's frozen default for the same CID and peer, and
`T` is the basis on a handed-off ticket for that exact turn/CID/peer. A usable
ticket is unused and unexpired. Provisional tickets have not been handed off.

| Ticket and issuance history | Basis relation | Guidance |
| --- | --- | --- |
| At least one usable ticket has `T = P` | `P` may equal or differ from `F` | Copy both fields from the matching handed-off `reply_authorization`; its unspent, unexpired ticket can be retried. |
| Usable ticket(s) exist, but every usable `T` differs from `P` | `P` may equal or differ from `F` | Do not substitute another basis or omit both fields. Wait for confirmed input or a handed-off authorization for `P`. |
| Issuance is known, but no usable ticket remains (spent, expired, superseded, or forgotten) | `P` may equal `F`, an old `T`, or neither | Wait for a fresh authorization for `P` or new confirmed input. |
| No issuance is known; history is unsaturated; no ticket or provisional-only ticket | `P = F > 0` | Resend as a normal reply with both authorization fields omitted; the wrapper applies `F`. |
| No issuance is known; history is unsaturated; no ticket or provisional-only ticket | `P != F` | Wait for new confirmed input or a handed-off authorization for `P`. |
| No issuance is known; history is unsaturated; no ticket or provisional-only ticket | `P = F = 0` | No ordinary peer input is confirmed. Wait for confirmed input; do not describe the send as a reply. |
| History is saturated and the tuple is unrecorded, with no retained issued ticket record | Any relation to `F`; prior `T` is unknown | Treat prior issuance as unknown. Wait for confirmed input or a matching authorization; never infer that omission is safe. |

The precedence is matching usable ticket, different-basis usable ticket,
known exhausted issuance, then unsaturated never-issued history. Saturation
makes only unrecorded history unknown: a retained ticket record still
determines whether to copy a matching usable authorization, wait because its
basis differs, or request fresh authorization after it is spent or expired.
The per-turn issuance ledger stores at most 256 distinct tuples and records
only successful handoffs. A successful activation of a 257th distinct tuple
marks the ledger saturated without growing it; `forget(cid)` retains issuance
facts and the saturation flag until turn retirement or session reset. If the
257th tuple's live ticket record is later forgotten, its earlier issuance is
unknown and the conservative saturated guidance applies.

Claude phase-2 fold text carries provisional tickets. An exact, trusted
`UserPromptSubmit` hook activates them only for the live turn that owned the
push; a receipt that starts a new root voids them. A fold leaves that turn's
default snapshot fixed. The next ordinary or receipt-created root copies
confirmed and completed input plus its own root envelopes, excluding any
earlier fold whose ticket has not been used. Spending a ticket credits its
folded input to completed history without changing the current turn's
default snapshot. See [Claude recipient handoff](delivery.md#claude-recipient-handoff).

Tickets appear in tool results and transcripts; confidentiality is not a
requirement. Unpredictability before issuance and origin/binding checks are the
requirements. Do not repeat tickets in diagnostics.

| Outcome | Retry authorization |
| --- | --- |
| Missing/mistyped/wrong-CID ticket | Local error; no send. Other valid tickets remain usable and can be copied correctly |
| Spent or expired ticket | Local error; the same value cannot be reused |
| Local `reply_basis_connection_changed` / `reply_basis_pending` | No push attempted (`send_not_attempted: true`); fresh authorization for an intentional retry after rejoin |
| `peer_reconnecting_capacity` / `delivery_backlog` | Definite nonacceptance: return a fresh ticket for the same observed input, for an intentional retry |
| `stale_reply_basis` | A non-empty recovery can authorize its returned input. Empty or oversized recovery has no ticket; a later input follows the route table below |
| Accepted | Spent; an eligible v1 ticket-authorized reply may return a fresh authorization for a distinct follow-up. A separately handed-off peer input has its own authorization and takes precedence. |
| Unknown delivery / ack timeout | No renewed ticket; automatic retry could duplicate a delivery |
| Closed or other permanent rejection | No renewal |

The wrapper does not automatically resend a rejected body. Local errors include
`send_not_attempted`, a distinct error code, and correction guidance.

### Accepted-reply follow-ups

An accepted v1 reply using a handed-off ticket for N newer than its frozen
default F can return a fresh `reply_authorization` for a new follow-up in the
same SDK turn, CID and peer. The default stays F. Copy `in_reply_to` and
`reply_ticket` from the new authorization; the accepted body's ticket is spent.
The fresh value is unpredictable until its result handoff, so a delayed call
formed earlier cannot borrow N. Server basis comparison is unchanged.

This metadata may appear in an additional JSON text content part, with
`reply_authorization_source: "accepted_reply"` and this guidance:

> Your previous send was accepted; for a new follow-up to the same peer and conversation in this turn, copy in_reply_to and reply_ticket from this reply_authorization, and do not resend the accepted body.

A waiter-delivered `delivery_lost` cannot name which send was lost, so
"confirm the peer state before retrying" and "do not resend the accepted
body" are one rule. `lost_notice/2` in
`server/lib/kaoiro_server_web/delivery_loss_dispatcher.ex` puts `code`,
`message`, `synthetic`, `kind`, `loss_id`, and `peer` on the error. The
payload `turn_number` is 0. The loss intent keeps `seq`; the notice does
not copy it. A synthetic notice uses code `delivery_lost` and says to
confirm the current peer or conversation state. Any other notice uses the
recorded reason, `delivery_lost` or `interrupted`, and says to confirm the
peer's state before retrying. The wrapper holds one waiter per
conversation. Which inbound resolves it is decided by the `matchesWaiter`
condition in `receiveInbound`
(`wrapper/agent-common/src/inter_agent.ts`), which is the source of truth.
A `delivery_lost` that resolves the waiter does not say which send was lost.
Server admission allows `affected_deliveries` only on `turn_failure`, and
the permitted `turn_failure` codes are the notice message table except
`stale_turn` (`server/lib/kaoiro_server/inter_agent_reply_basis.ex`).
`delivery_lost` is not one of them. A notice that both names this send and
says it was not dispatched is `invalid_internal_notice` and is not
delivered. Confirm the peer state before retrying, and do not
unconditionally resend the body this result already records as accepted.

It becomes usable only at the actual result handoff and gets the normal
300,000 ms lifetime and single-use binding. Issuing it acknowledges no new
peer input, credits no fold, and changes no native continuation snapshot or
lease. Antigravity and Grok remain legacy; this does not activate v1 there.

Unknown outcomes, rejections and fire-and-forget fallback acceptance issue no
success follow-up ticket. A new ordinary waiter input's authorization takes
precedence. In a result carrying a server `status_notice`, an accepted-reply
authorization is solely for the previously answered ordinary input N; the
notice itself never authorizes a peer reply.

Newer usable authorization is preserved. Closure, retirement, forgetting,
capacity or entropy failure cannot revive authority or hide acceptance: the
result retains the accepted receipt. It may report
`followup_authorization_unavailable: true` with bounded `followup_guidance`,
except when this call's own `done: true` is the transition that sets the
conversation closed. A later inbound close, retirement, forgetting, capacity
failure, or entropy failure still reports that part. Optional metadata is
finalized before serialization; a failed write discards its provisional
ticket. An uncertain result handoff never resends the body.
The existing 256-record per-turn limit includes spent and follow-up tickets.

## Inline recovery and ownership

This matrix is the source of truth for reply metadata in each delivery route.
Tool guidance and tests follow the route that actually hands the input to the
SDK; an oversized recovery response does not predict that later route.

| Route | `reply_authorization` / ticket on this handoff? | Reply method |
|---|---|---|
| Normal root input | No explicit ticket; the wrapper freezes the input turn as the default basis. | Omit both `in_reply_to` and `reply_ticket`. |
| Claude fold | Yes, for each latest ordinary peer input represented in the fold. | In the same SDK turn, copy both fields from the fold's `reply_authorization`. |
| Waiter | Yes for an ordinary peer envelope. A server turn-zero `status_notice` supplies no authorization of its own; an accepted reply can separately supply the follow-up authorization above. | Copy both fields for the ordinary input or the accepted-reply follow-up. Do not reply to the notice. |
| Recovery | Yes when a non-empty recovery hands off ordinary peer input; no for an empty result. | Copy both fields from a non-empty recovery result. Empty recovery provides no ticket. |
| Oversized queue | No ticket accompanies the oversized recovery result. The queued item may later arrive as a normal root input or as a Claude fold. | Wait for the handoff. For a root input omit both fields; for a fold copy both from its `reply_authorization`. |
| Generic empty recovery | No new ticket accompanies the empty result. | If an unused, unexpired authorization for the exact expected input was already handed off in this SDK turn, intentionally copy both fields from that result. Otherwise follow the later root/fold rule; the empty result does not prove pending input. |
| Retained fold | An oversized retained-fold result has no current-turn ticket; an earlier fold's ticket belongs to its original SDK turn. | Do not assume the old body or ticket is usable. Wait for new confirmed input, then follow its root or fold rule above. |

A stale rejection can return already-received, ordinary, undelivered envelopes
for that peer/CID in arrival order. Recovery contains at most ten whole messages
and at most 16,384 UTF-8 bytes for the complete serialized tool result, including
authorization and unread advice. An oversized oldest message stays queued and
produces `oversized_pending`; later messages cannot skip it. The tool result
guidance distinguishes an ordinary queued item, which remains eligible for the
normal input handoff, from a retained Claude fold, which may belong to an earlier
SDK turn and does not prove that its body is visible or that authorization is
available. Neither case permits resending the rejected body.

With an empty recovery, the wrapper has no matching input available for inline
recovery now. If a usable authorization for this exact origin/CID/peer and
`expected_peer_turn` has already been handed off, guidance points to that
result's `in_reply_to` and `reply_ticket`. It issues no new ticket, does not
renew its lifetime, and does not establish pending unread input. The caller
must intentionally reconsider its send using the confirmed input.

Without such a matching authorization, it cannot infer delivery loss or
whether a later confirmed input will arrive. The result omits `awaiting_delivery` and unrelated aggregate unread
counts. Do not retry the failed send with its stale basis on that conversation.
If peer input is needed, wait for a later confirmed input; when it arrives as a
normal root input, reply in this conversation with both `in_reply_to` and
`reply_ticket` omitted. If it arrives in a Claude fold with
`reply_authorization`, copy both fields from that same-turn authorization. If
the context already available is enough, omit `conversation_id` and restate it
in a new conversation. An empty recovery does not prevent a later ordinary
input from arriving through the normal handoff path.

`unread_remaining` and `more_pending` describe queued work only when a recovery
envelope is actually returned; they do not predict whether the rejected
conversation will receive later input.

For Claude folds, `stale_reply_basis` can also return a previously folded
envelope with `folded_earlier: true` and a fresh ticket, including after its
original turn retires. The coordinator retains at most 256 recovery bodies;
ticket use, a newer confirmed turn for the same peer/CID, or a session-ledger
reset retires a body. Capacity eviction drops the oldest body and records a
counted `fold_recovery_capacity` reason. Recovery does not advance an
uncredited fold into a later root's default snapshot.

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

For a Codex early steer, a reply ticket becomes live only after both a valid
`turn/steer` response and the exact completed user-message item arrive before
terminal. Activation replaces an older unused ticket for the same peer/CID.
The wrapper retains the activated input body, bounded to 256 records, for a
stale-basis recovery result with `folded_earlier: true`; ticket use, a newer
confirmed input or session reset retires it. Provisional or uncertain inputs
without both activation facts receive no recovery ticket.

Negotiated steer failure notices carry `error.affected_deliveries`. The server
accepts only bounded, sorted coverage for the current owner and generation.
The recipient matches each entry to its original peer turn; an A-only notice
cannot consume B's CID waiter. It is instead shown as an asynchronous
A-attributed input. A matching B notice returns with B's original peer turn
and wait/no-retry guidance. Old unscoped notices do not claim sequence
coverage and never authorize a retry of a possibly delivered steer.

These notices still advance transport turns and use normal delivery/quota
accounting. They neither close conversations nor advance ordinary peer history.
`resolveTurnEnd` and stale-delivery producers use the acceptance-aware notice
sink. Rejected or unknown notices produce bounded diagnostics, without resend or
retrospective delivery ack. A legacy wrapper's arbitrary `error` payload is not
an exemption.

## Known limitation: sends after subagent hand-backs (issue #426)

On Claude Code, a background `Agent` subagent's final report reaches the
root as an `<agent-message>` continuation prompt that the host does not
inject and does not admit as a send owner. Ordinary `send_to_agent` calls made
in that continuation are rejected locally with `unbound_tool_call` and
`send_not_attempted: true`; nothing is sent. The block lasts until the next
inbound inter-agent message starts a new turn. The host treats the
continuation as a [foreign root interval](../engines/claude-events.md#foreign-root-intervals):
it holds the next wrapper input until the interval's result.

Operational guidance until issue #426 is resolved under ADR-0063 D6:

- A Claude peer that must report to its director after background `Agent`
  work should expect to wait for the director's next message, or run the
  subagent in the foreground so the report returns as a tool result inside
  the live turn.
- A director waiting on such a peer should send a short message to open a
  turn rather than treat silence as failure.

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
