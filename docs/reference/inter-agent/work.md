---
title: Work authority and operations
status: provisional
last_updated: 2026-10-17
description: Durable work grants, operation receipts, and transfer obligations.
---

# Work authority and operations

A work record names a director, an assignee, a revision, and an authority epoch.
The server owns these fields. An agent can nominate work with `assign` in a new
conversation; the recipient gains active authority only after
`accept_assignment`. An operator can assign active work directly. A conversation
links to at most one work, and `done: true` does not complete that work.
In current reducer output, unset `origin`, `reviews`, and `subject` values in
full work records, and unset `subject_hash` and `target` values in check audits,
are serialized as `null`.

The [wire types](../../../protocol/src/work.ts) define each `work_control` op.
The [operation table](../../plans/issue-429-delivery-authority-protocol.md#ops)
defines actors and preconditions. Director ops use `expected_revision`; assignee
ops use `basis_revision` where required. `transfer` advances the authority epoch.
Changing the assignee creates a pending obligation. The old assignee calls
`work_transfer_ack {work_id, transfer_id}`; the new assignee's `work_check` stays
fenced until every pending obligation is acknowledged or overridden by the
operator.
The wire-level `work_check_request` may include an unenforced audit target
`{ref, expected_old, actual?}`.

Each operation carries an `operation_id`. The server commits the work change
and its receipt in one WorkStore write. A duplicate ID with the same body
returns the stored receipt without relaying another message. A duplicate ID
with a different body is rejected. `work_op_result_request` reads the receipt
without sending a message; `unknown_operation` means no receipt existed at the
lookup point, while `operation_id_expired` means the ID is outside its validity
window. Preserve an uncertain ID while checking the outcome.

Yield tokens and the recipient's last granted claim time occupy one
`{:yield_state, recipient}` record. A claim consumes its token and advances the
interval in one write. An op with a yield request commits its work receipt
first, then issues the token. If token issuance fails, the op stays applied
and delivery first falls back to `early` with `yield_token_unavailable`.
Recipient capability and early-quota checks may still change the final grant;
the send reply's `delivery_authority` carries that final result. The receipt
records only the op result.

Work application precedes conversation recording. A committed operation may
therefore have no delivered message. The receipt's `delivery` field reports
`recorded`, `not_recorded`, or an unknown outcome separately from its applied
work result. `work_status_request` gives the caller's current authorized view;
the old assignee can retrieve only its own pending transfer obligations, each
with `work_id`, through either the full list or a named restricted view.
Its `work_transfer_ack` reply confirms only `{work_id, transfer_id,
state: "acknowledged"}`. Operator notices sent while an old assignee's
obligation remains pending carry that restricted view, including only its
own obligations, instead of the full work record.
Receipts remain until their ID timestamp plus the configured validity window
has passed, including IDs accepted ahead of server time. Terminal retention
does not delete a work while it still holds a live receipt.

`work_check` is a preflight for an assignee and records a bounded audit entry.
`start` requires active
assignment and no pending transfer. `land` additionally checks the supplied
revision and subject hash, no holds, and an effective accepted verdict when
`requires_verdict` is true. The final grant changes only through `complete`.

An active grant also authorizes one operation outside `work_control`: the
director may request the assignee's session reset through
`request_peer_session_reset` ([ADR-0068](../../adr/0068-director-requested-peer-session-reset.md)),
naming `work_id` and `expected_authority_epoch` taken from its own work
results. The reset does not advance the revision and is not an op; a
`transfer` or override invalidates the director's request through the
epoch, and the server answers any authority failure with
`reset_not_authorized`.

See [delivery](delivery.md) for `delivery_intent` and yield claims, and
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
