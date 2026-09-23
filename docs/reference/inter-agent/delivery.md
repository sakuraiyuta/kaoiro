---
title: Inter-agent delivery
status: provisional
last_updated: 2026-09-18
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

## Related topics

- [Message fields](messages.md).
- [Conversation lifecycle](conversations.md).
- [Dispatch and coalescing](../../architecture/inter-agent-messaging.md#dispatch-and-coalescing).
- [Approval flow](../security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration).
- [Companion tools](directory.md#companion-tools-wrapper-sdk-mcp).
- [Send and wait](send-and-wait.md).
