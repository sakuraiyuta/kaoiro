---
title: Permission synchronization and audit
status: accepted
last_updated: 2026-09-19
description: Persisted permission settings, join synchronization after wrapper reconnect, and the permission lifecycle audit trail.
---

# Permission synchronization and audit

#### Persistence, join synchronization, and resume

`PermissionSettings` is separate from `SessionPointers.snapshot`. It retains raw
next-execution selection, latest request/progress, in-flight revision bindings,
and the authenticated user ID/time for operator requests. The server owns
revision allocation and request records; wrapper reports can update observations
only for matching accepted/submitted revisions on the current connection. A
retired wrapper cannot commit a stale observation.

The wrapper requests `permission_sync:{engine}` in its channel join payload
(`PermissionSyncJoinRequest`); the server replies `permission_sync:true` when
this contract is supported (`PermissionSyncJoinReply`). The engine value uses
the existing EngineKind enum and prevents cross-engine settings replay; it does
not replace capability checks. This negotiation precedes host construction and
does not depend on a state_change capability advertisement.
After **every** negotiated wrapper join, the server sends `permission_sync`:

```ts
{version: "0", control: PermissionControlExt | null,
 next: {revision: number, requested: {sandbox, network_access}} | null}
```

`null/null` explicitly means no saved settings. Both fields are null together or
non-null together. Inside a non-null control, absent optional fields must be
**omitted**, never sent as JSON `null`. This includes `submitted`, `effective`,
`last_effective`, `reason`, and `rolled_back_to`; omission is legal only where
the `PermissionControlExt` arm permits it. A required field cannot be omitted,
and a forbidden field cannot be sent even as `null`. The explicit empty sync is
the exception for the two top-level fields, not a null convention for nested
records. Apply the same omission rule to live control publications.

Seed empty settings from the wrapper's raw launch baseline, not from normalized
`ext.effective`. Otherwise `next` is the saved next-execution selection.

**Rejection before application.** At request acceptance, the server must bind
the then-current accepted `next` selection (revision and raw pair) into that
request's ledger entry as its recovery target. On a definitive pre-application
rejection, retain failed control for the rejected request, restore `next` from
that recorded target, and derive the wire `rolled_back_to` pair from the same
server record. The wrapper's reported rollback pair is never the source of
either value. Do not search for the highest lower revision: it may itself have
been rejected. Ledger pruning must preserve recovery targets still referenced
by unresolved requests. For the first request, the target is the persisted
`{revision:0, requested:<launch baseline>}`. Do not allocate a new revision or
claim an effective observation merely to restore that selection.

For example, A (revision 1) is the accepted next selection, followed by three
requests rejected before application:

| Request | Recovery target bound when accepted | Next after rejection | Latest control |
|---|---|---|---|
| B, revision 2 | A, revision 1 | A, revision 1 | B/failed, rolled_back_to = A's pair |
| C, revision 3 | A, revision 1 | A, revision 1 | C/failed, rolled_back_to = A's pair |
| D, revision 4 | A, revision 1 | A, revision 1 | D/failed, rolled_back_to = A's pair |

Neither B nor C becomes C's or D's recovery target. A block on revision 1 is
not cleared merely because failed control advances to revision 4: clearing
requires `next.revision > blocked.revision`, reflecting a newer server-accepted
selection, whether delivered by live relay or sync.

If an existing entry has no acceptance-time recovery binding, preserve its
current `next` selection and derive any pre-application rejection's
`rolled_back_to` from that same selection; do not infer a missing predecessor
or claim a fresh effective observation.

**Join projection.** Apply these rules after every negotiated join, including
server restart, wrapper restart, and same-process rejoin:

| Stored control | Control sent in sync |
|---|---|
| `pending` | Keep `pending` and any permitted evidence. |
| `applying` | Send `pending`; omit `submitted` and `effective`, retaining any `last_effective`. |
| `applied` | Send `pending`; omit `submitted` and `effective`, retaining the confirmed observation as `last_effective`. |
| `unknown` | Keep `unknown` with its bound `submitted` and `reason`; omit `effective` and `rolled_back_to`. |
| `failed` | Keep `failed`, its reason and permitted evidence; retain a server-derived rollback pair only for a definitive pre-application rejection. |

Unknown requests remain `next` and remain blocked across restart/rejoin; do not
round them to pending or replay them without operator reconciliation. A mismatch
also keeps its authorized `next` and its failed block. A pre-application rejection
uses its ledger-derived recovery target instead. Applied selections are
reasserted on process restart, with historical evidence rather than a claim of
fresh application.
Reasserting a saved widening request is delayed execution of the authenticated
operator selection, not permission to choose a wider policy autonomously.

Synchronization is a readiness barrier, including the explicit empty response.
Buffer messages received before host construction. Process the authoritative
sync before any initial/replayed/queued input can create an exec. On rejoin,
keep an already running exec unchanged and gate its successor until sync.
A same-process rejoin must not turn a cached observation into a fresh application;
a fresh process starts with historical evidence only and must observe its exec.
An old server that does not support this handshake cannot enable the capability;
a wrapper that has already accepted permission changes must not resume dispatch
without synchronization merely because the new connection is silent. Scope sync
to the current channel join, and do not let a delayed sync overwrite a newer live
revision already accepted on that join.

Resume/restore/switch/reset initially use only last-observed effective fields in
`SessionPointers`; sync then supplies the raw requested selection before exec.
Crash restart also needs sync: it may reuse the runner's older launch config.
A legacy snapshot without raw settings cannot recover a latent network toggle.
The live wrapper's launch configuration is the explicit baseline in that case.
Delete removes per-agent PermissionSettings (not the revision allocator or audit
history); an engine change must not replay another engine's settings.

A current confirmed permission observation updates only the relevant snapshot
fields and preserves unrelated model/effort fields. It must still be recorded
when model/effort is pending or failed; the model switch's whole-snapshot skip
must not discard independently observed permissions. Conversely, generic state
snapshots must not overwrite permission fields with pending, unknown, or stale
values. Persisted snapshots remain last observed even while current permission
is unknown. Intentional sandbox/network changes are excluded from resume drift;
unintended host substitutions remain visible.

**Drift comparison while observation is pending.** When permission_control is
present but has no current effective observation, exclude only `sandbox` and
`network_access` from resume_drift comparison. This is an observation-readiness
filter, not an intentional-change filter: it also applies to a resumed agent
that has never received set_permission and remains idle before its first turn.
On a fresh current observation, compare both fields against the resume snapshot.
For each field, exclude an intentional difference only when that observation is
bound to this exec's submitted selection, the selection has a positive revision
allocated for an accepted operator request, and the observed field matches the
selection's sandbox-aware normalized value. Use the submitted selection for
this execution, not a newer pending `next` selection. Revision zero is only a
launch baseline and cannot establish operator intent. A mismatch remains
eligible for drift and must also report a policy violation even if it happens
to equal the resume snapshot.

For the selection's expected network value, use
`effectiveNetworkAccess(submitted.requested.sandbox, submitted.requested.network_access)`
from [network_access.ts](../../../wrapper/codex/src/network_access.ts), the
normalization source of truth in
[ADR-0033](../../adr/0033-permission-model-dual-axis.md#network-configuration-and-effective-access).
Compare this expectation with the observed effective value. Do not renormalize
stored snapshot values or contradictory observations during comparison: doing
so would hide legacy snapshot drift or an observation mismatch.

Recover this attribution from the authoritative selection delivered by
permission_sync after relaunch; it must not depend on a process-local
operator-switched set. Do not permanently exempt either permission field after
a request: validate the execution binding and value match for each observation.
All other fields and engines without this
control keep the existing rule that undefined versus a known value is drift.
The same field-specific pause applies during each later unobserved exec; it must
not suppress model/effort drift while waiting for permission observation.

Implementation checks must cover resume without any operator request before
its first exec (no permission drift), a first observation with an unexpected
sandbox/network value (drift), and an unrelated model/effort difference during
that wait (still drift). Also cover an accepted pending selection followed by
snapshot-applying relaunch and sync: its matching first observation produces no
intentional permission drift, while an unexpected value still does. Include
revision-zero observations and overlapping submitted A / pending B to ensure
neither the launch baseline nor another execution's request masks drift.
Dashboard checks must cover the initial unobserved
Codex state: fixed approval/enforcement present, no Claude picker, and visible
unknown sandbox/network values.
Also cover Claude spawn and restore without an explicit/stored mode and without
running a turn: the first status advertises mode switching, the picker is usable,
and the current mode remains unknown. Verify the capability survives SDK metadata
arrival, explicit false overrides legacy mode metadata, and capability absence
alone exposes neither picker.

#### Permission lifecycle audit

Extend ADR-0055's `SessionLifecycleEvents` timeline, not a separate stderr-only
log. `session_lifecycle` remains a versioned control event; it is not an envelope
`type`. The permission events carry closed, typed `details`:

| Kind | Producer | Details |
|---|---|---|
| `permission_requested` | Server after accepting an operator request | `{revision, requested, actor:{kind:"user",id}, previous?}` |
| `permission_applied` | Wrapper after a new selection's policy is observed | The `PermissionObservation` fields, plus optional `previous` observation. |
| `permission_failed` | Wrapper for a definitive rejection or an unconfirmed/mismatched application | `{revision, requested, reason, execution_id?, rolled_back_to?}` |

`previous` is a historical `PermissionObservation`, absent when unknown. Do not
emit applied solely for replaying an already applied revision; fresh observation
still updates current state. Deduplicate matching revision/kind outcomes across
reconnect; a transition from unknown to subsequently observed may add applied.
The server joins observations to its stored request, resolves previous from
its own accepted observations, and authenticates their agent/current connection.
It never trusts a wrapper-supplied audit actor or a wrapper-produced
permission_requested. Keep in-flight request bindings long
enough for A's result when B is already pending. Rejected client payloads do not
create a permission_requested record.

Validate kind-specific details at ingress, store append, and boot load, and
preserve them in `list_session_events`. `trigger` remains exclusive to
`compact_boundary` (absent/null for permission events). Require finite safe
revisions and bounded identifiers/reasons: IDs at most 256 UTF-8 bytes, reason
at most 256 UTF-8 bytes, with no prompt, tool input, credentials, or raw SDK error.
The existing ISO timestamp and transport frame limits still apply. Unknown
execution outcomes use a reason such as `observation_unavailable` without
`rolled_back_to`; the event name alone does not establish rejection/rollback.

Record narrowing and widening without confirmation UI or peer notification.
The existing retention, operator-only pull access, and best-effort asynchronous
write policy remain. An audit write failure does not reverse or block an
accepted command, and its ack is not an audit-fsync receipt. This timeline is
not a guaranteed durable security journal.

## Related protocol topics

- [Envelope contract](envelope.md).
- [Permission requests](permission-requests.md).
- [Permission state](permission-state.md).
- [Message topology](../../architecture/message-topology.md).
- [Model and effort state](model-effort.md).
- [Session capabilities](capabilities.md).
- [Session lifecycle](session-lifecycle.md).
- [State machine](state-machine.md).
- [Attachment wire contract](attachments.md).
- [Attachment rendering by engine](../engines/attachment-rendering.md).
- [Runner control and launch](runner-control.md).
- [Task and tasklist envelopes](tasks.md).
- [Persona delivery](persona-delivery.md).
