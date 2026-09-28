---
title: Work authority and operations
status: provisional
last_updated: 2026-09-28
description: Durable work grants, operation receipts, and transfer obligations.
---

# Work authority and operations

A work record names a director, an assignee, a revision, and an authority epoch.
The server owns these fields. An agent can nominate work with `assign` in a new
conversation; the recipient gains active authority only after
`accept_assignment`. An operator can assign active work directly. A conversation
links to at most one work, and `done: true` does not complete that work.

The [wire types](../../../protocol/src/work.ts) define each `work_control` op.
The [operation table](../../plans/issue-429-delivery-authority-protocol.md#ops)
defines actors and preconditions. Director ops use `expected_revision`; assignee
ops use `basis_revision` where required. `transfer` advances the authority epoch.
Changing the assignee creates a pending obligation. The old assignee calls
`work_transfer_ack {work_id, transfer_id}`; the new assignee's `work_check` stays
fenced until every pending obligation is acknowledged or overridden by the
operator.

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
and the intent becomes `early` with `yield_token_unavailable`. The receipt
records only the op result; this downgrade is visible in the send reply's
`delivery_authority`.

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

See [delivery](delivery.md) for `delivery_intent` and yield claims, and
[channel contracts](../protocol/channels.md) for request and reply shapes.
