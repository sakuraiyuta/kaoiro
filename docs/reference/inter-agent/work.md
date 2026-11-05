---
title: Work authority and operations
status: provisional
last_updated: 2026-11-05
description: Basic work authority, durable receipts, and conversation links.
---

# Work authority and operations

A work record names a director, an assignee, a revision, and an authority epoch.
The server owns these fields. An agent can nominate work with `assign` in a new
conversation; the recipient gains active authority only after
`accept_assignment`. An operator can assign active work directly. A conversation
links to at most one work, and `done: true` does not complete that work.
Full records keep unset `origin`, `reviews`, and `subject` as `null`.

## Basic operations

The server accepts these operations under
[issue #965](https://github.com/sakuraiyuta/kaoiro/issues/965).
The outbound protocol and wrapper schema expose these five operations.
U1 and U2 are released together, using the coordinated
[runner update procedure](../../operations/runner-update-and-rollback.md#coordinated-server-and-wrapper-updates).

| Operation | Actor | Required state | Result |
|---|---|---|---|
| `assign` | Agent, or operator with explicit director and assignee | Capacity and unclaimed conversation link | `nominated`; operator assignments are immediately `active` |
| `accept_assignment` | Assignee | `nominated`, active capacity available | `active`, revision advances |
| `decline` | Assignee | `nominated` | `declined` |
| `complete` | Director or operator | `active` | `completed`, revision advances |
| `cancel` | Director or operator | Non-terminal | `cancelled`, revision advances |

`revision` is a server-maintained state version. The server ignores supplied
`expected_revision`, `basis_revision`, and `subject_hash`; completion does not
require an artifact, hold release or verdict. The director checks artifacts
and review results through messages and files. Cancellation does not stop a
running tool: confirm that the previous assignee has stopped before assigning
the replacement work.

`revise`, `hold`, `release`, `submit`, `verdict`, `withdraw_verdict`,
`accept_verdict`, `revoke_verdict`, `transfer`, and `release_transfer` are
rejected before actor or work lookup with `unsupported_work_operation`.
Already-recorded operation IDs are deduplicated before this rejection. For an
unrecorded removed operation, the wrapper channel returns:

```json
{
  "reason": "unsupported_work_operation",
  "send_not_attempted": true,
  "details": {"operation_id": "<received operation ID>", "delivery": "not_recorded"}
}
```

The operator channel exposes the same reason. `work_check_request` and
`work_transfer_ack` remain recognized channel events but return that reason
without applying anything. They no longer check implementation or landing,
record an audit, or acknowledge a transfer. Current wrappers expose neither
control tool and do not emit either request.

## Continuing work across conversations

An ordinary `normal` or `early` message may carry `work_id` without a
`work_control`. The sender must be the director or assignee of an active work
and address its counterpart. `work_control` and a top-level `work_id` may be
combined only when the IDs agree; the operation then owns the link update.

A conversation already linked to that work stays linked without a change.
An unlinked conversation requires an explicit `new_conversation: true` and
must not belong to another work. A work has at most 32 links. The declaration
is trusted: the same participants may link an existing open conversation by
setting it to true. Missing or false declarations do not authorize this
attachment. Third-party conversations and closed, stale, or otherwise
inadmissible messages fail the existing conversation preview before any link
mutation. `yield` does not create a link and still requires an existing one.

The sequence is receipt lookup (operations only), conversation preview,
serialized work/link update, delivery-intent admission, then conversation
recording. Links do not advance the revision or create receipts. The recipient
receives the current work stamp. A race after preview may reject delivery even
though the link or operation was committed; those changes are not rolled back.
Unavailable or corrupt saved capacity settings also refuse link mutations.

If the work store exits or times out during ordinary-message linking, the
reply is `work_outcome_unknown` with `send_not_attempted: true` and
`details: {work_id, conversation_id}`. Delivery has not started, but the link
may still commit after the timeout. There is no operation ID or receipt for
this path; inspect the work's links before retrying.

## Receipts, status and authority

Each operation carries an `operation_id`. The server commits the work change
and receipt in one write. The same ID and operation map return the stored
receipt without relaying another message, even if the message body differs.
A different operation map under the same ID returns `operation_id_conflict`.
`work_op_result_request` reads the receipt without sending a message:
`unknown_operation` means none existed at lookup, while `operation_id_expired`
means the ID is outside its validity window. Preserve an uncertain ID while
checking the outcome. This lookup's error is inside an otherwise successful
channel reply; callers must read its JSON `error` field.

Yield tokens and the recipient's last granted claim time occupy one
`{:yield_state, recipient}` object. A claim consumes its token and advances
the interval in one write. Work application precedes conversation recording:
a receipt's `delivery` independently reports `recorded`, `not_recorded`, or
unknown. Delivery-intent downgrades are reported by `delivery_authority`;
receipts record the operation result, not that final delivery decision.
Receipts remain until their ID timestamp plus validity; terminal retention
does not delete a work with a live receipt. Old operation receipts stay readable.

`work_status_request` lists a caller's non-terminal work and always returns
`pending_transfers: []`. A named record is available only to its director,
assignee or an operator. A former assignee or a reviewer has no special access.
Operator notices go only to the current assignee and director.

`WorkControlOp` contains the five outbound operations. `WorkReceiptOp` and
the inbound rendering table retain all fifteen operation names so queued
messages and durable receipts remain readable.

The v1 `WorkRecord` shape preserves existing values of `holds`, `verdicts`,
`accepted_verdicts`, `transfers`, `subject`, `requires_verdict`, `reviews`, and
`checks`. Server releases before `v2026.11.05.1` read these keys, so they
remain without a removal date for record-shape compatibility. Their keys are
optional for readers; optional typing does not remove stored values. New
assignments initialize them to empty lists, `null`, or `false` as appropriate.
They still appear in full `work_status`, `work_notice` and client
`work_changed` records, but do not determine access, completion or any other
server decision. No removal is planned.

An active grant also authorizes the director to request the assignee's reset
through `request_peer_session_reset`
([ADR-0068](../../adr/0068-director-requested-peer-session-reset.md)).
Use the record's actual `authority_epoch`, including retained values above 1.
Reset and yield authorization still compare that epoch. New grants start at 1;
without transfer there is no operation that advances it. Reset failures remain
`reset_not_authorized`. See [delivery](delivery.md) for yield claims and
[channel contracts](../protocol/channels.md) for request and reply shapes.

## Admission capacity and saved settings

Operators can configure nomination and active-work admission limits; 0 disables
only the selected check. Defaults remain 16 and the nomination TTL remains 24
hours. Closing a conversation does not decline its nominated work. Storage,
receipt and subordinate collection caps remain finite. Lowering a cap preserves
existing work and healthy idempotent receipts.

`work_capacity` retains its wire meaning. An optional `details.capacity` has
`limit`, `scope` and positive integer `maximum`, without identities or occupancy.
The first failing check is reported: records before admission before global
receipts, outgoing nominations before incoming, per-work receipts before total.

| limit | scope |
|---|---|
| `work_max_records` | `store` |
| `work_nominated_per_principal` | `director` or `assignee` |
| `work_active_per_assignee` | `assignee` |
| `work_receipts_per_work_principal` | `work_principal` |
| `work_receipts_per_principal` | `principal` |
| `work_pending_transfers` | `holds` (twice its configured value) or `transfers` |
| `work_verdicts_per_work` | `work` |
| `work_accepted_verdicts_per_work` | `work` |
| `work_links_per_work` | `work` (32) |

Unknown/malformed diagnostics are ignored without changing the refusal; old
servers may omit them. Assigning an already-linked conversation still returns
`work_link_conflict`, without capacity details. Invalid/uncertain saved settings
instead return `work_settings_corrupt`/`work_settings_unknown`, never a fabricated
capacity refusal. They close mutation and authority grants while the store stays
alive. See [configuration and recovery](../configuration/server.md#unavailable-settings).

The four limits for transfer, verdict and check collections
(`work_pending_transfers`, `work_verdicts_per_work`,
`work_accepted_verdicts_per_work` and `work_checks_per_work`) remain v1 settings
compatibility fields without a removal date. No supported operation grows
these collections, and the limits do not affect current server decisions. No
removal is planned.
