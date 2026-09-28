---
title: Inter-agent delivery
status: provisional
last_updated: 2026-09-29
description: Inter-agent delivery contracts and compatibility.
---

# Inter-agent delivery

The structural type `InterAgentDeliveryStatus` is defined in
[@kaoiro/protocol](../../../protocol/src/index.ts).

## Dispatch-confirmation ledger (issue #237)

`ingress_stamp` records server acceptance, not confirmation that the receiving
wrapper read an SDK turn. Per-recipient
`inter_agent_delivery = {issued_seq, acked_seq, pending_since?, lost_count?, last_loss?}`
observes later dispatch confirmation and negotiated explicit retirement. It
retains no payloads and does not guarantee retransmission or delivery.

- For live/synthetic messages to a wrapper that joined with capability
  `inter_agent_delivery_ack: "dispatch-v1"`, the server adds a recipient-local
  positive `delivery_seq` to the outer envelope and advances `issued_seq`.
- A wrapper does not ack queue insertion or `receiveInbound` arrival. It confirms
  a contiguous prefix as `delivery_ack {delivery_seq}` when an actual SDK turn
  starts, or when intentional non-injection (consumed/terminal/stale) is fully
  classified, including terminal reclassification when a queued item reaches
  the peer dispatch or actual engine input boundary. Until then, a gap remains as `issued_seq > acked_seq`;
  `pending_since` is the timestamp of the first divergence.
  Recovery and waiter inputs follow the same
  [tool-result handoff boundary](reply-basis.md#inline-recovery-and-ownership).
- `whoami`, `list_agents` entries, and the operator dashboard's
  `snapshot.deliveries` / `delivery_status` all read the same server ledger. An
  absent field is **unknown** (legacy/disarmed), not zero.

`transition_id` correlates session transitions and cannot identify a process because
a runner crash relaunch may reuse it. An ack-capable `ServerLink` joins with a
random per-process `delivery_generation`. WebSocket reconnects with the same
generation retain gaps. A different generation (reset/crash/explicit restart) is a
boundary that lost the old process memory, so the server atomically abandons old
gaps with `acked_seq := issued_seq`. The sequence remains monotonic; nothing is
resent to the new process.

### Negotiated gap recovery

An additional join capability, `delivery_resync: "skip-v1"`, enables explicit
retirement of missing deliveries without changing envelope version `"0"`.
The server echoes that capability only when supported. Without the echo, a
new wrapper records recovery as unavailable and sends no resync requests;
an old wrapper keeps the original dispatch-only behavior on a new server.

The wrapper tracks receipt separately from dispatch. At rejoin, missing
sequences at or below the join's `issued_seq` are resynchronized immediately.
For later status updates, a 30-second grace period detects both trailing and
interior holes above the local resolved prefix. The grace cutoff is fixed
when the timer starts: newer sequences receive their own grace period.
Received inputs waiting for an SDK turn are never candidates. Immediately
before a request, candidates are checked again and quarantined; late copies
cannot enter an SDK turn while retirement is unresolved.

`delivery_resync` carries `generation`, `request_id`, `cutoff`, and sorted,
disjoint inclusive `missing_ranges`. Each request covers at most 256 sequence
numbers, all positive and at or below the cutoff. The server validates the
current channel owner, bound generation, negotiated capability, and
`cutoff <= issued_seq` before any mutation. It durably records retirements
and replies with the same `request_id`, `skipped_ranges`, and post-skip
`delivery` status; it also broadcasts the updated status. Repeated requests
are idempotent. A lost reply leaves the same request quarantined for retry,
including across rejoin. A replacement process never replays the old process's
messages, and an old channel cannot acknowledge or retire its replacement's
deliveries.

For negotiated recipients, `acked_seq` denotes a **resolved prefix**, which
can include explicit losses, not proof that every message was dispatched.
`lost_count` and `last_loss {at, first_seq, last_seq, count, reason}` distinguish
those outcomes. A retirement behind an earlier received-but-unstarted input
does not move the prefix past that input. The wrapper applies the response's
skip ranges to its completion ledger and rebinds the post-skip prefix so later
completed turns can acknowledge again. A locally confirmed ack lost during a
disconnect is resent on rejoin.

For skip-v1 recipients the ledger durably retains minimal routing descriptors
(sender, conversation, turn and kind), never message bodies or credentials.
A missing legacy descriptor is recorded as `untraceable`; the server never
guesses its sender. Known ordinary losses produce a sender-addressed
`delivery_lost` error. Each loss has a stable identifier derived from recipient,
ledger incarnation, generation and sequence. The incarnation is persisted and
changes after ledger deletion, so a recreated generation cannot reuse an ID.
Skip and the durable notification intent are written together; notifications
are dispatched outside the ledger process. Completion compares the intent's
revision so an older dispatcher attempt cannot delete a newer loss of its
recovery notice. A lost response or dispatcher
restart may redeliver a notification with the same loss ID, which receivers
deduplicate against the latest 10,000 distinct loss IDs in FIFO order within
one wrapper process. Duplicate arrivals do not refresh that order. An older,
evicted loss ID is treated as a new notification if it arrives again.

Synthetic losses are never reported back to a sender. Reachability notices are
regenerated from current connection/planned-restart state, and conversation
closure notices from current tombstones. When that state is unavailable or the
notice cannot be regenerated, the recipient receives a `delivery_lost` error
with `synthetic: true`, its original kind and loss ID. Recovery notices retain
their original loss ID if lost again; they do not create notification loops.
Server-generated notices, including `delivery_lost` and `work_notice`, bypass
intent admission, carry no `delivery_authority`, and consume no early quota.
They cannot grant yield. A wrapper-origin internal notice carrying
`delivery_intent` is rejected with `invalid_internal_notice`.

Normal sends reserve one of 1,000 unresolved metadata slots before conversation
accounting. A reservation is released when conversation preflight rejects or
its owning channel dies, and becomes routing metadata when the sequence is
issued. Full recipients reject with `delivery_backlog`: wait for recipient
drain and do not retry automatically. Rejection changes neither conversation
accounting, panes nor delivery sequence. Synthetic notices bypass this cap,
so 1,000 is not a strict bound on all metadata. Legacy recipients neither store
metadata nor enforce the cap. Active metadata is reclaimed on ack prefix,
explicit skip, generation change, disarm and deletion; notification intents
survive separately until dispatched. Generation changes explicitly retire
remaining descriptors as interrupted before reclaiming the old ledger.

A wrapper may explicitly retire received but permanently discarded, unstarted
inputs using `delivery_resync` with `reason: "interrupted"`. This is distinct
from missing-sequence detection: watchdog fail-stop preserves the active turn,
while retiring discarded queued batches. Shutdown attempts retirement before
closing transport, bounded to five seconds; it cannot promise acceptance after
a broken connection. A subsequent generation bind retires surviving metadata.

A terminal intentional disconnect (`operator`, `runner`, or `agent_self`) also
retires every unresolved sequence of the channel's exact owner and generation.
The owner/generation fence makes a stale terminate a no-op. The retirement and
its durable loss intents complete before the delivery-status broadcast, which
precedes the disconnected state, peer notice, and lifecycle entry. An
`unplanned/socket_lost` disconnect and a planned restart preserve the ledger so
skip-v1 reconnect recovery remains possible.

The server writes recipient/sequence loss diagnostics without message contents. Recipient and sender panes can still contain the original accepted
envelope even though it was retired before dispatch; a later resend is a
separate displayed message. Loss counts reset at a new process generation.

The Claude wrapper emits `claude-code-lifecycle` diagnostic records for
`dispatch_queued`, `turn_start`, and `delivery_ack`, correlated by `agent_id`,
turn token and delivery sequence where available. `dispatch_queued` does not
prove SDK dispatch: an input arriving mid-turn waits for the current turn's
boundary. `turn_start` is emitted at the host's input-yield callback;
`delivery_ack` with `phase: "send_attempt"` records an attempted watermark
send, not server acceptance. The acknowledgement and turn-start records come
from the same callback, with the acknowledgement logged first. Server ledger
status remains the confirmation source. These records omit message bodies,
and diagnostic write failures do not change turn or acknowledgement control.

## Delivery intent and staged delivery (ADR-0063)

A wrapper that joins with `inter_agent_delivery_modes` and receives the `"v1"`
echo declares its early and yield mechanisms and reports per-sequence stages.
The server stamps the granted intent into the relayed payload and send result.
Stages are `accepted`, `queued`, `submitted` (with mode and the named handoff
event), optional `included` (evidence `ticket_used` in v1), `settled`,
`unknown`, `lost`, and, on query, `expired`; a yield also has a set-once
`yield_disposition`. Stage history is bounded and query-only, keyed by
`(recipient, incarnation, generation, delivery_seq)` and indexed by
`(conversation_id, turn_number)` for the sender. It remains separate from
`delivery_ack`: an out-of-order submitted sequence joins the resolved set, is
not retired or reported lost, and the prefix crosses it when earlier gaps close.
Stage changes are never injected into model input.

For Codex exec, `exec_input_written` means the first `iterator.next()` on
`runStreamed(input).events` resolves with the child’s first stdout JSONL value.
By then the SDK has spawned the child, written the input, and closed stdin;
`runStreamed()` itself resolves before spawn. The name is historical: the
evidence is first-event receipt. The wrapper reports stages only when the join
reply supplies the server-issued `inter_agent_delivery_incarnation`; it never
fabricates one.

If a work operation applies but yield-token issuance fails, the operation
receipt remains applied and early is only a fallback delivery mode. Recipient
capability and early-quota checks still apply, so the final send result can
grant early or normal with a downgrade such as `yield_token_unavailable`,
`recipient_legacy`, `unsupported_by_recipient`, or `early_quota`. The reply's
`delivery_authority.granted` and `delivery_authority.downgrade` give the final
result; the receipt does not store that downgrade. See [work authority and
operations](work.md#work-authority-and-operations).

### Claude recipient handoff

The Claude wrapper advertises `early: "fold"` and `yield: "tool_boundary"` only
when `KAOIRO_CLAUDE_PHASE2_DELIVERY=1` is set; it uses those modes only after
the server echoes delivery modes v1. The flag is off by default. Codex and
Antigravity do not advertise these modes. A granted early peer delivery can
bypass the same peer's ordinary turn queue to enter its live Claude `Query`;
ordinary peer batches remain serial. An operator early instruction without
attachments can also fold, without a peer reply ticket. Synthetic notices
never request early or yield. With the flag off or without the matching server
echo, root input retains its arrival order and phase-2 overtaking is disabled.

For a fold, the wrapper reserves a fold slot for the live turn,
then pushes text containing a correlation `fold_id`, a peer-input preamble,
and provisional `reply_authorization` tickets for the latest ordinary turn
from each conversation and peer. A trusted `UserPromptSubmit` hook activates
the one-use receipt only when its session, host generation, `Query`, entire
text digest, and still-live eligible owner all match. That hook reports
`submitted` with `handoff: "fold_hook"`; the push itself does not. A matching
hook that instead starts a new root creates that root's input snapshot and
reports `handoff: "prompt_hook"`. Other combinations become `unknown` and
grant no send authority. The root owns its peer batch until it settles, so a
later ordinary batch from that peer cannot replace its reply obligation.
An unmatched hook containing a task-notification still passes through the
existing foreign-notification guard; knowing a `fold_id` does not preserve
send authority after a rejected notification.

A fold leaves the live turn's default reply snapshot unchanged. Its ticket is
bound to that turn, is single-use, and retires with the turn. Spending it
reports optional `included` with `evidence: "ticket_used"` and credits the
folded input to the completed-input ledger. A default-basis send after the
fold can receive `stale_reply_basis`; recovery re-hands the folded envelope
with `folded_earlier: true` and a fresh ticket at the tool-result boundary.
The wrapper retains at most 256 folded recovery bodies until ticket use, a
newer confirmed turn from the same peer and conversation, or a session-ledger
reset retires them. Capacity eviction drops the oldest body and records
`fold_recovery_capacity` with a count.

A granted yield is usable only when the live turn has input linked to that
work, no input linked to another work, and no operator instruction. The
wrapper reserves an urgent root boundary, asks the server for `yield_claim`,
and waits at most `yield_claim_timeout_ms` (default 2,000 ms). A refusal or
timeout leaves the message as early input and records a downgraded
`yield_disposition`; the recipient does not cut. After a grant, the wrapper
rechecks the same live owner, work eligibility, and overtake budget before
pushing `priority: "now"`. The running tool completes before the current turn
ends; the yielded message starts the next root. A transfer after a granted
claim does not revoke that cut. At most `urgent_overtake_limit` consecutive
urgent peer root boundaries (default 2) may pass an older ordinary one, and
at most `folds_per_turn` fold batches (default 3) may enter one turn. A fold
whose pushed receipt becomes void or unknown still consumes its reserved
slot; operator roots do not reset the peer overtake count.
If another fold receipt is pending after a claim grant, the scheduler waits
up to `pending_receipt_root_timeout_ms` for its decision, then rechecks the
owner and all folded work input before cutting. A changed owner or
eligibility downgrades the yield. One pushed text is limited to ten peer
messages and 16,384 UTF-8 bytes, counting its full SDK user-message text,
including the preamble, `fold_id`, and ticket lines. Oversized text stays in
the root queue; the attempted fold does not consume a turn slot or activate
its tickets. The final cut text is checked before `yield_claim`; when it is
oversized, the wrapper leaves the urgent item at its arrival position in the
root queue, makes no claim or early fallback, and reports
`yield_disposition: {outcome: "downgraded", reason: "oversized_input"}`.
`queued`, `submitted`, `included`, `settled`, and `unknown` are
separate stage reports. `delivery_ack` advances the recipient's delivery
ledger; it does not assert a Claude hook or completed model input.

After the old result, a pushed fold or cut receipt holds the next queued root
until its hook decides the receipt. A task-notification turn pauses the
`pending_receipt_root_timeout_ms` clock (default 2,000 ms); the pause count is
diagnostic. If no hook arrives by the deadline, the receipt becomes
`unknown(root_hook_timeout)`, admission and tool-origin authority freeze,
the wrapper enters `error`, and queued root input is cancelled without
reaching the old `Query`. The pushed item F is `unknown` because its handoff
is uncertain. The queued item R is `settled(failed_before_handoff)` because
it was never handed to the engine; its cancellation kind is
`receipt_timeout_fail_stop`, and its sender receives a best-effort failure
notice. The timeout is counted in diagnostics.
Recovery requires an operator restart of the wrapper; a session reset inside
the failed host does not restore admission. See [Claude fail-stop recovery](../engines/claude-events.md#recovering-a-fail-stopped-claude-wrapper)
and [wrapper delivery controls](../configuration/wrapper.md#claude-phase-2-delivery-controls).

## Related topics

- [Message fields](messages.md).
- [Conversation lifecycle](conversations.md).
- [Dispatch and coalescing](../../architecture/inter-agent-messaging.md#dispatch-and-coalescing).
- [Approval flow](../security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration).
- [Companion tools](directory.md#companion-tools-wrapper-sdk-mcp).
- [Send and wait](send-and-wait.md).

## Input-bound reply contract

See [inline recovery and ownership](reply-basis.md#inline-recovery-and-ownership).
