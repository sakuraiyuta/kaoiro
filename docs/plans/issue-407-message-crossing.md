---
title: Snapshot-bound replies with inline recovery for inter-agent crossings
description: Approved design for origin-bound replies, one-use reply tickets, bounded inline recovery, and explicit transient-rejection retries.
status: approved
last_updated: 2026-09-26
---

# Snapshot-bound replies with inline recovery

## Authority, baseline, and scope

Baseline: `ba696b503261db5c3af9f4806a5579b9f8f8d995`. Kogane is the writer;
Kuroe owns scope, review dispatch, and landing; Fuji reviews. Design approval was
granted on 2026-09-26 after six review rounds. Implementation starts only after
Kuroe supplies the baseline-capture ledger path, hash and recording start time.
Claude and Codex implementation may then proceed while Hisui measures the AG
engine boundary. Landing requires both the AG result and implementation review;
all-engine rollout additionally requires evidence that AG's origin guard works.
If AG measurement remains unmet, the operator must decide the deployment scope.
No all-engine protection is claimed before that evidence exists.

The operator's 2026-09-26 decision adopts A' with (a) pending bodies returned
on stale-basis rejection and (b) unread-count advice, with reply_ticket required
for explicit same-turn replies. The operator selected this fourth alternative
over per-engine weaker boundaries, deferring all replies, or waiting for engine
support. Cross-turn origin attribution is a required admission boundary below;
there is no accepted exception for delayed default sends.
Unconditional interruption is rejected. Selective interruption is outside this
delivery. Engine-native
fold/priority/steering is tracked in
[issue 412](https://github.com/sakuraiyuta/kaoiro/issues/412), referenced only as
future input-boundary support. This design does not enable it.

[Issue 407](https://github.com/sakuraiyuta/kaoiro/issues/407) stays open until
uncovered incident classes and operational before/after measurement are complete.
Operator instructions and external-human communication are outside the basis
comparison; they neither advance peer history nor become recovery payloads.

## Problem, evidence, and priority

The issue records six incidents, not measured production frequencies. Four share
a same-thread stale reply; the fourth could have lifted a merge hold using
retracted evidence. That shared mechanism and impact justify classes 1–4 first.
Class 5 also risks damage but needs mutation/workstream authority beyond reply
admission. `receiveInbound()` currently advances transport numbering before
engine input; monotonic server acceptance alone therefore permits stale replies.
Delivery acknowledgement is not evidence of model input or understanding.

The [joint research report](../evidence/2026-09-26-issue-407-interrupt-comparison.md)
(SHA-256 `7eea0ffc4c73d3556a1464e9441bb3c999fb6c3d5a5d4c81fa2d2c071ee5a782`)
records input retention and interrupt limits, not rollback or productivity gains.
Its source/measurement baselines remain unchanged by this plan's rebase. The
[call-provenance investigation](../evidence/2026-09-26-issue-407-call-provenance.md)
records SDK/CLI ID and ordering observations; the fourth review checked its hashes
and checker, not a product guard. Neither report measures reply_ticket behavior.

Manual basis on every send adds burden; wrapper-only checks miss server-accepted
but undelivered turns; interruption cannot undo accepted sends or started effects.
Chosen: fixed input snapshots plus atomic server comparison, with tickets for
intentional inline recovery/waiter replies. A call whose arguments were fixed
before a result cannot contain its freshly random ticket. This proposed reasoning
still requires actual-engine tests. Tickets replace per-call override eligibility
registries; they do not replace binding the call to its originating SDK turn.

## Basis and tool invocation contract

Keep three different facts: transport numbering, model-input provenance, and
server-accepted ordinary peer history. Do not derive one from another.

- A shared input-provenance component records the latest ordinary peer turn
  delivered into this session for each `(conversation_id, peer)`; it uses the
  same bounded conversation lifetime as IA tracking, never a separate unbounded
  cache. Reset/session replacement clears provenance. Eviction means unknown,
  not read. Reconnect of the same wrapper does not reconstruct read state from
  the server's delivery-ack prefix.
- At each actual SDK input boundary, form `basisSnapshot[turnToken]` from prior
  delivered inputs plus the exact surviving envelopes entering this input.
  Freeze that snapshot until the turn finalizes. All three hosts, including
  operator-origin turns, establish an exact active token. Receipt, coordinator
  queue insertion, and `notePendingInjection` do not advance it. A skipped or
  cancelled-before-input envelope contributes nothing. Track only ordinary
  peer messages, including legacy ordinary messages, not synthetic/internal
  notices or the sender's own sends.
  For coalesced same-peer/same-CID turns N and N+2, both surviving in one input,
  the basis is N+2 (the maximum delivered ordinary turn), not the first item.
  Exclude items removed during input reclassification or claimed for tool input;
  recompute from prior delivered provenance plus survivors, never the old text.
- Hook the existing actual input boundary: Claude input yield; Codex exec
  `runStreamed` admission and app-server `turn/start` dispatch; Antigravity's
  successful stdin write. Antigravity must publish the token/snapshot before
  allowing a tool callback for that input, and roll back provisional admission
  if the write fails. A single-threaded ownership transition prevents callbacks
  from running against a half-published snapshot. Failure before engine input
  must not report a delivered basis.
- Resolve the originating session/SDK turn through the engine adapter contract
  below, before choosing any default. At shared handler entry capture that origin
  token and its frozen default snapshot before any await. Keep that capture through CID locks,
  transport queues, and waiter processing; recheck token liveness before send
  and result handoff. A known retired token fails locally. Receipt counters or
  the token active after a wait must not replace the captured values.
- With both `in_reply_to` and `reply_ticket` absent, use that frozen snapshot's
  latest ordinary peer turn, or zero if none. New conversations use zero.
  Consecutive own sends and recovery/waiter results do not advance this default.
- Any explicit `in_reply_to`, even one equal to the default, requires its matching
  reply_ticket. A ticket without in_reply_to is also invalid. Explicit replies
  require an existing explicit CID, a nonnegative safe integer basis, and the
  ticket validation below. No argument contains a force flag or automatic retry.

## Reply tickets and guarantee boundary

A recovery/waiter result handing off ordinary peer input supplies
`reply_authorization: {in_reply_to, reply_ticket, expires_in_ms: 300000}` for the
latest ordinary peer turn handed off in that CID. Several recovery messages still
produce one ticket. Generate 32 CSPRNG bytes with `crypto.randomBytes(32)` and
encode 43 unpadded base64url characters (256 bits). Never derive tickets from
turns, timestamps, native IDs, or a predictable PRNG. Regenerate collisions;
entropy failure returns a local error and restores the body lease without ack.

Bind each record to session identity/generation, SDK turn token, CID, peer ID,
and target peer turn. Expire at the earliest of 300,000 monotonic milliseconds
after handoff, turn end/cancel, session replacement, CID closure/eviction, or
shutdown. Reconnect does not renew it. Internal/synthetic notices and terminal
closed conversations issue none; legacy ordinary errors require a full-envelope
handoff. Tickets never change the current default snapshot.

Serialization can allocate provisional bytes, but activation occurs only in the
synchronous body-handoff/ack transaction. Check token liveness there. Cancellation,
pre-write disconnect, or serialization/write failure discards the provisional
ticket and restores the body lease without ack. Include ticket metadata in the
recovery byte cap; never publish it separately before the body. Post-handoff
failure has the same delivery uncertainty as the body and causes no automatic
requeue/revival. Future snapshots remember input, not ticket strings.

After schema/routing/origin/liveness checks, validate all bound fields and expiry,
then atomically mark the live ticket spent before the shared handler's first
await. This admits at most one concurrent attempt, even across CID locks.
Invalid or missing tickets fail locally without network send, numbering/done
changes, or consuming any other valid record. Recheck captured origin liveness
and deadline immediately before dispatch. A consumed value is never restored,
even on cancellation or a definite rejection; renewal below always uses new
random bytes and requires another intentional model call. This is one attempt,
not one successful delivery. No automatic resend or default-basis promotion.

### Definitive rejection and renewed authorization

Keep the attempted ticket's immutable binding until its acceptance result has
been classified. Only a typed server result `kind: rejected` with the exact
allowlisted reason `peer_reconnecting_capacity` or `delivery_backlog` permits
renewal. Both mean this send was not accepted. A text substring, transport
exception, timeout, disconnect, or missing acknowledgement does not establish
that fact. Preserve the server outcome and its retry-later/drain advice.

For an explicit attempt with an originally valid ticket, prepare one fresh
reply_authorization for the same observed peer turn, session, original SDK token,
CID and peer. Deliver it inside the rejection tool result, without re-delivering
the old body or changing delivery ack/provenance. It activates only at the same
real result-adapter handoff used for body tickets, with the captured token still
live. The model can deliberately retry later in that turn using the fresh value;
it cannot reuse the spent one. No new external input or forced next turn is
necessary. If a newer unused authorization for that pair was handed off while
this attempt waited, do not supersede it with an older-basis renewal: return the
definite rejection and advise using that newer result, without reprinting its
ticket. A default attempt simply retains its frozen default for a deliberate
retry; it does not need or acquire a ticket from a rejection.

| Outcome after one explicit attempt | Authorization result |
|---|---|
| Definite `peer_reconnecting_capacity` or `delivery_backlog` | Fresh one-use ticket at live result handoff; same observed basis; keep retry-later/drain advice |
| `stale_reply_basis` | Only ordinary bodies actually handed off by recovery can issue a ticket; never renew the rejected stale basis by itself |
| Accepted | Spent; only a separately handed-off waiter/recovery input can authorize another explicit reply |
| Closed, participant failure, or other definite rejection | No renewal; preserve specific error |
| Unknown delivery, timeout, disconnect, or cancelled attempt | No renewal or refund; warn that acceptance is unknown where applicable |
| Origin retired, original ticket expired before dispatch, or failed result handoff | No renewal; never transfer authorization into the next SDK turn |

Renewal does not promise that the peer basis is still current: a newer peer turn
can race and the server must reject again. Fresh-ticket generation/capacity
failure returns the original definite rejection plus an authorization-unavailable
reason; it must not convert it to accepted/unknown or silently reuse the value.
A provisional renewal lost before handoff is discarded. A handed-off value has
its own upper lifetime of 300,000 ms from that handoff, always bounded by the
original SDK turn's end; it does not extend the turn. Repeated renewals require
repeated definite nonacceptance and intentional model attempts.

### Local errors, lifetime, and bounded records

Return `send_not_attempted: true` for schema/ticket/origin failures before network
dispatch. Distinguish `reply_ticket_invalid` (unknown/mistyped or mismatched
binding), `reply_ticket_expired`, and `reply_ticket_spent` while their records
exist. For an invalid copied value, explain: if the matching authorization in the
original tool result is still unused and unexpired in this turn, copy both fields
again. This is conditional advice, not disclosure that an arbitrary guessed value
is valid. Spent/expired errors prohibit reuse of that value; a separately issued
fresh authorization may be used. Do not echo tickets in errors. Local errors do
not consume another live ticket. After session/turn retirement, report the origin
or turn failure; absence of a deleted record is never evidence of permission.

Allow at most one latest unused ticket per `(CID, peer)` and 256 total ticket
records per active SDK turn, counting provisional, unused, spent, expired and
superseded records. Keep bounded spent/expired records until that turn ends to
classify errors without allowing replay. New handoff invalidates the pair's old
unused value. At capacity, restore a new body lease without ack or, for renewal,
return the definite rejection without authorization. Never evict another usable
record to admit a new one; turn retirement clears this bounded table.

`expires_in_ms: 300000` is an upper lifetime measured from adapter handoff, not
300,000 ms remaining when the model receives or reads the result. Transport and
model delay consume it; turn end/cancel can expire it earlier. Every attempt
checks the local monotonic deadline; no client-supplied clock extends it.

Tickets are observable receipts, not secrets or an authentication boundary. They
may appear in tool results, transcripts and existing logs; secrecy/redaction is
not required for correctness, and no extra value logging is needed. The required
property is unpredictability before the result. Delayed B cannot acquire A's
future value just by waiting; later C can copy it once. This does not prove C
understands the body or protect against deliberate misuse by an actor controlling
the session. Observing a ticket cannot change any of its bound fields.

## Cross-turn call origin: required admission boundary

The [cross-turn investigation](../evidence/2026-09-26-issue-407-cross-turn.md#codex-actual-host-cli-bridge-and-shared-tool)
records the baseline reproductions and their limits; its
[timeout analysis](../evidence/2026-09-26-issue-407-cross-turn.md#why-the-timeout-paths-differ)
separates observed behavior from the source-supported causal interpretation.
Current-token lookup at ToolHost/shared-handler receipt is insufficient even
without explicit override. A same-turn-only limitation is not the accepted v1
contract, and rejection counters cannot expose silently borrowed defaults.

Resolve an immutable `(session generation, origin SDK token)` before default
selection, permission waiting, or shared invocation. Retire it synchronously on
terminal observation, abort, reset, session replacement and close, before another
input can publish its snapshot. Never assign unknown origins to the currently
active token. Missing/mismatched/retired origin returns a local origin error with
`send_not_attempted: true`, before numbering, ticket consumption or server send.
The final admission point is immediately before invoking sendInterAgent (or the
legacy send sink), after every permission/CID/queue await, with no intervening
await between the origin/AbortSignal check and sink invocation. Check immutable
origin identity, active-token membership and cancellation together. A retired
origin returns stale_tool_call; absent/unresolvable metadata returns
unbound_tool_call, both with send_not_attempted. Ingress checks alone are not
sufficient. Repeat the captured-origin check at result handoff. This applies
to both default and explicit sends; a ticket validates the observed peer input
within that origin but does not establish origin for a ticketless call.

### Codex exec: endpoint scoped to one run

Create a private ToolHost endpoint for each admitted exec SDK turn, with descriptor
contexts permanently bound to that turn's token and abort signal. Supply that
endpoint to the CLI's MCP bridge in its immutable launch config. Move exec client
construction from the session-wide run setup to this per-turn setup, using the
same real SDK factory, session resume ID, settings and system instructions. Exec
already launches a fresh CLI per turn; this does not add another model turn.
Tools/list can run during startup without admitting a model send before input.

End/abort synchronously retires the endpoint and bound token, then destroys its
connections and closes/unlinks its socket. The next run gets a distinct private
path; never reuse or retarget the old path. A bridge delayed before connect still
names T's retired path, while one already connected still names T's retired
context. Reconnection cannot upgrade either to T+1. An entered handler retains
that context through every await. Do not replace it by host.activeTurnToken().
This avoids an exec item-ID/native-call-ID join and an asynchronous rollout lookup.

### Codex app-server: native turn carried through the bridge

The persistent MCP bridge must forward engine-supplied
`_meta["x-codex-turn-metadata"].{thread_id,turn_id}` separately from model arguments.
The previous pinned probe observed these values matching app-server item/started
threadId/turnId. Associate `(app-server connection generation, threadId, turnId)`
with the captured wrapper token from the authoritative turn/start response; retire
that association at terminal/abort before admitting another turn. Do not infer
it from the most recent tool call or accept model-supplied lookalike fields.

If MCP arrival precedes the turn/start response, preserve its exact native IDs
in a bounded pending-admission slot tied to the already-dispatched start request.
Resolve only against that request's response, never a subsequent turn/start.
A mismatch, response failure/timeout, cancellation or retired request rejects
without invoking the shared tool. Cap this admission queue at 64 calls for that
one dispatched start; overflow fails locally, with no replay into a later turn.
The existing RPC start timeout bounds waiting. Matching the first observed MCP
ID to the active token without the authoritative response is prohibited.

This is a native turn join, not a native tool-call-ID/override-eligibility registry.
The private bridge connection generation prevents restarted app-server sessions
from reusing stale mappings. Persistent connection identity alone is insufficient
because one connection legitimately serves several turns. Strip neither native
turn fields nor the captured wrapper token before descriptor invocation. Engines
missing these metadata cannot use a permissive current-token fallback; report an
unsupported origin boundary and block protected activation pending director action.

### Claude: native tool-use identity resolves the origin

At the SDK assistant event, before tasklist refresh or another await, associate
`tool_use.id` with the input token owning that SDK stream position and session
generation. Retain that immutable association through permission/CID waits.
The MCP callback reads `extra._meta["claudecode/toolUseId"]`, resolves the same
origin, and passes it plus extra.signal into the shared descriptor context.
canUseTool uses options.toolUseID to reference the association before awaiting
operator permission; it never creates an origin merely from the current token.
If that event has not been consumed yet, defer by exact ID within the already
active input admission, bounded to that token and cancelled when it retires.
Missing/conflicting IDs or late events cannot attach the call to the next input.
A callback after origin retirement fails even if an earlier MCP cancellation
notification was consumed before that callback existed.

The previous pinned native-ID probe establishes equality of assistant, permission
and MCP IDs. The current delayed-call probe establishes that SDK cancellation
alone is insufficient under its controlled scheduling; it does not validate the
new host registry. This is an origin-only join, not the removed mutable registry
of explicit-override eligibility. Reply tickets still handle knowledge obtained
within a turn. No raw-pipe cancellation parser or new interrupt policy is added.

Use a bounded session registry of at most 8,192 observed tool-use IDs (active or
retired), with immutable entries and duplicate-conflict rejection; never recycle
an ID into a newer token. Capacity exhaustion reports origin-unavailable locally
and blocks further protected tool admission until session replacement, rather
than evicting a retired ID and silently accepting its reuse. Session replacement
changes the generation and clears the table. The implementation tests must cover
permission before assistant-event consumption, late handler execution, cancel
before callback creation, token retirement, duplicate IDs and capacity exhaustion.

### Antigravity: engine boundary not established

The [AG evidence](../evidence/2026-09-26-issue-407-cross-turn.md#antigravity-adapter-observations-native-measurement-unmet)
records three adapter-only controls and the prior preparation stop (0/5 live
runs); none establishes the native engine boundary. The epoch nonce is not a
per-turn identity, and closing an endpoint does not cancel an entered handler.

The operator authorized Hisui to measure the actual AG engine, with at most five
live-model executions, real host interrupt/epoch-respawn, and immediate stop if
the required order cannot be controlled. Record execution count, input/output
tokens, conversation IDs, owned PIDs and global-hook effects. Preserve evidence
of T's held call, T's termination, actual new peer input during T+1 and release;
measure old send attempts before implementing a guard. Report missing observations
as unknown. Only signal processes started by the measuring agent, by retained PID.

**AG's engine boundary remains unverified.** Claude/Codex implementation may
proceed after the baseline-capture handoff, but landing waits for the AG result
and implementation review. All-engine rollout requires actual-engine evidence
that the origin guard works. If the measurement remains unmet, return deployment
scope to the operator; adapter-only controls cannot satisfy this gate.

Adding current-token lookup to the existing socket is rejected: the Codex probe
shows exactly how that borrows T2's default. A possible stronger alternative is
one epoch/endpoint per SDK turn with immutable origin at launch and retirement
before the next input; it would change Antigravity's process reuse and resume
cost, so it is not adopted without an explicit director/operator scope decision
and actual-engine validation. No per-turn process restart is implemented here.
If no native turn identity or approved equivalent boundary can be established,
report that fact to the operator and keep all-engine deployment blocked for
this boundary. Do not silently exempt Antigravity, disable its protection, claim
an all-engine v1 guarantee, or treat adapter-only tests as the required engine test.

### Await boundaries and common constraints

| Path | Immutable origin source | Later waits that must retain it |
|---|---|---|
| Claude | Assistant tool-use ID joined to the SDK input token; exact-ID admission before permission | Event-consumption admission, operator permission, MCP scheduling, CID lock, transport acceptance, waiter and result handoff |
| Codex exec | Per-run endpoint and launch configuration fixed to T | CLI/MCP startup, socket connect/write, ToolHost dispatch, permission broker, CID lock, acceptance/waiter/handoff |
| Codex app-server | Native thread/turn metadata joined only to its dispatched turn/start response | Response-before-MCP admission race, socket transport, permission broker, CID lock, acceptance/waiter/handoff |
| Antigravity | Unestablished at the native engine boundary; epoch nonce alone is insufficient across normal turns | Hook permission, process/bridge startup, socket connect, descriptor/CID/acceptance/handoff remain unprotected until that boundary is resolved |

Unknown origin never becomes the latest snapshot after waiting. Recheck the
original cancellation/liveness at every side-effect admission and final handoff;
closing a socket is not cancellation of an already running JavaScript handler.
No new origin guard is implemented or validated by these baseline probes.

### User-visible tool changes

Add optional `reply_ticket` alongside optional `in_reply_to` to the shared model
schema and validate the paired-field rule consistently in Claude MCP, both Codex
backends, and the Antigravity bridge. Preserve argument values; do not fill in a
missing ticket from a mutable wrapper registry. Add this sentence to
send_to_agent's description: "For an explicit in_reply_to, copy the matching
single-use reply_ticket from the recovery or waiter result in this SDK turn."
Return reply_authorization beside recovery messages or the waiter reply/error
envelope; definitive transient rejection can return a renewed authorization.
Local errors include send_not_attempted and invalid/expired/spent distinctions,
with conditional copy-correction advice. Never advise automatic resend.
These tool schema/result/description changes are operator-approved visible
behavior. Tickets stay wrapper-local and are not sent to the peer/server wire;
server admission still compares only in_reply_to. Legacy mode reports its lack
of server protection, while new-wrapper explicit arguments still undergo local
ticket validation. Keep issue 365's final build-identity sentences in
LIST_AGENTS_DESCRIPTION and WHOAMI_DESCRIPTION unchanged; add the ticket sentence
only to the send description, preserving any other existing final build text.

## Server admission and negotiated compatibility

Join requests/echo advertise `inter_agent_reply_basis: "v1"`. The authenticated
channel's negotiated state, not a payload flag alone, selects protected admission.
Extend typed transport acceptance to retain structured rejection details.

For protected ordinary sends, require `in_reply_to` as a nonnegative safe integer.
Store the latest accepted ordinary transport turn per participant in the open
conversation, regardless of whether that participant used a legacy or protected
connection. In the same `ConversationStates` call that accepts a message:

1. Check existing closure and participant constraints; do not disclose another
   conversation's history through an error.
2. Compare the supplied basis with the latest ordinary turn by `to` (zero if
   none). Reject an older or future value as `stale_reply_basis`, before changing
   numbering, tokens, done flags, panes, or delivery sequence. Return
   `{reason, conversation_id, expected_peer_turn, supplied_basis}` to the caller.
   Prefer this diagnostic to stale transport numbering when both are stale.
3. For a matching basis continue ordinary numbering/quota/closure checks and
   update ordinary history atomically with acceptance. No separate check/record
   calls; two crossed sends cannot both pass against superseded history.

Reject releases a delivery reservation and leaves conversation accounting and
recipient display unchanged. Wrapper optimistic numbering/done state rolls back
using its existing concurrent-inbound protection; auto-allow authority is never
established by rejection. A peer message accepted after this send's admission
cannot retroactively revoke it. CID tombstones and server-restart/unknown-CID
behavior remain unchanged; a new thread is not a recovery bypass.

Compatibility matrix:

| Wrapper / server | Ordinary admission | Reported protection |
|---|---|---|
| New / new, v1 echo | Enforce basis; omission or malformed field rejected | `v1` |
| Old / new, no negotiation | Existing legacy admission; do not require/compare a basis | `legacy` |
| New / old, no echo | Explicit legacy fallback; omit unsupported fields and preserve existing sending behavior | `legacy` |
| Rejoin not yet completed | Wait for that connection's negotiation before sending; preserve bounded existing transport queue | `pending` |

In legacy mode explicit-basis intent does not promise protection; tool results
and `whoami`/peer directory show the mode, and wrapper connection diagnostics
record the downgrade once per connection. No silently claimed guarantee.
Optional directory fields are additive; unknown/absent is not protected. The
new server updates ordinary history for legacy sends so a protected peer still
rejects a reply whose basis predates a legacy peer's newer message.

Deploy server first, then restart wrappers in stages. During transition only
negotiated senders get rejection protection. New wrappers joining an old server
remain available in reported legacy mode. Rollback can revert wrappers or server
without resetting CID state intentionally, but the relevant coverage becomes
legacy after renegotiation; the operator must accept that loss of protection.
Do not downgrade a live connection by ignoring an error: reconnect and complete
negotiation. A server process restart already loses volatile conversation state;
report resulting unknown-CID errors separately from downgrade. Historical
transcripts remain readable and are never retroactively checked against a basis.

The deployed workflow is two separate updates, as confirmed in
[production update](../operations/production.md#4-update) and
[runner updates](../operations/runner-update-and-rollback.md): the runner builds
and expands before it stops the old release. This revision removes A's blanket
old-wrapper rejection; the server-first interval is an unprotected mixed-version
interval, not an intentionally imposed IA outage. Plan and record it explicitly:

- Before server commit, prepare the server image and runner tarballs for each
  target platform using the existing prepare/build flows. Record their manifests,
  hashes, the prior server transaction/image, and each host's prior runner release
  ID. Installing/building must not stop live wrappers. Use the prebuilt-tarball
  runner update route; do not add a new deployment mechanism to this feature.
- Record UTC timestamps for server switch/healthy (`T_server`), last old wrapper
  stop (`T_old_stop`), and final intended wrapper's successful v1 join
  (`T_v1_all`). Identify the intended roster first, and distinguish stopped
  agents not scheduled to restart from failed intended joins. Record per-host
  update identity, first successful ordinary send, and failed send reasons.
  Report `T_old_stop - T_server` and `T_v1_all - T_server`, plus observed IA
  failures/unavailability separately; unprotected duration is not outage time.
- Before switching, tell the operator the roster, expected legacy interval and
  rollback identities. During transition, connection diagnostics, `whoami`,
  directory fields, and tool-result mode text tell agents whether they are v1,
  pending, or legacy. Announce completion only for the measured intended roster;
  do not claim complete protection while any required sender remains legacy.
- A runner build/install failure before stop leaves its old release serving in
  legacy mode: stop advancing the rollout and report that state. A failed new
  wrapper join/start or functional regression after switch returns that host to
  its recorded prior runner release through the existing rollback procedure.
  A server regression (including unexpected legacy rejection or protected stale
  acceptance) stops rollout and uses the recorded prior server transaction/image
  through the existing server rollback procedure. Retained new wrappers must
  reconnect, report legacy mode, and cannot claim v1 protection on the old server.
  Recovery must confirm process identity, health, mode, and an ordinary send;
  changing a symlink or reading an old version label alone is not recovery proof.

These are implementation rollout requirements, not authorization to deploy during
design review. No fixed success timeout substitutes for the recorded join/send
evidence, and missing timestamps or logs are reported as unknown durations.

## Inline recovery (a): bodies, ownership, and acknowledgement

After `stale_reply_basis`, return a tool error with the rejected-send identity,
supplied/expected basis, bounded ordinary inbound envelopes and reply guidance,
plus `unread_remaining` and `more_pending`. Messages retain sender, CID, turn,
kind, body, and done metadata. Do not silently turn a rejected body into a send.

Recover only the rejected conversation's **already locally received, ordinary,
not-yet-engine-delivered** messages in receive order. The server returns numbers,
not stored message bodies. If the newer accepted turn has not arrived locally,
return an empty list with `awaiting_delivery: true`; never pretend its body was
read. The agent yields for ordinary delivery rather than polling or guessing
`expected_peer_turn`. Later arrival follows the regular queue path.

Hard limits: at most 10 complete messages and at most 16,384 UTF-8 bytes for the
entire serialized recovery content, including metadata and advice. Bound and
escape diagnostic strings before packing, and reserve space for the trailing
unread advisory before selecting messages. Add only
whole envelopes while the result remains within that bound. If the oldest
message alone does not fit, return a bounded `oversized_pending` description
and leave it queued for normal next-turn handling. Do not truncate a body and
ack it as complete; do not skip an oversized oldest message to deliver a later
same-CID basis. Existing normal coalescing's oversized-singleton exception is
not copied into this bounded tool-result route.

One envelope has one delivery owner. Extend the existing coordinators with a
synchronous claim/release interface across both pending batches and batches
already handed to a host but not started. Identify items by envelope/delivery
identity, not just CID. Ownership transitions are:

`queued or host-queued -> tool-result lease -> tool-result handed off`

or, on cancellation before handoff, back to their former queued ownership.
Engine input preparation and recovery claims use the same synchronous ownership
check. An engine-started item cannot be recovered. A claimed item cannot enter
engine input; a released item can. No await occurs between validation and claim.
On stale send completion release the send's done-ack gate and CID lock **before**
claiming recovery, because `receiveInbound` may be waiting on that gate.

Rebuild affected queued text and CID lists. An emptied host-queued batch is
skipped without an engine call; a partly emptied batch retains other items.
Move only claimed items' pending-reply ownership to the active token, preserving
any unrelated batch and preventing a late `settle()` from clearing a newer lease.
A recovery result for a currently active CID must merge into that token's lease,
not erase its existing obligations. No repeated `receiveInbound` call is made.

A shared tool-result handoff adapter carries the lease through tool handling.
Commit the claim only when handing the complete result to the active engine's
tool-response path, after checking its captured cancellation/token. At this
boundary activate the reply_ticket, record input provenance for future SDK turns,
and acknowledge exactly the handed-off envelopes through the existing contiguous
delivery-ack tracker. It does not modify this turn's snapshot. Failed/cancelled
handling before handoff releases the lease without
acknowledging. A disconnect after handoff has the same delivery limitation as
the existing synchronous-waiter handoff: dispatch does not prove model reasoning;
record it as a tool-input handoff, not a read guarantee. No promise of crash-proof
exactly-once model consumption is introduced.

Bind handoff to each real result adapter, not completion of the shared handler:
Claude's registered SDK MCP callback validates the token/cancellation and commits
immediately as it returns the complete result to the SDK, without an intervening
await. Codex and Antigravity ToolHost adapters serialize first, check that the
captured token/connection remains live, and commit only after the response frame
is synchronously accepted by `socket.write`, with no intervening await. A `false`
return is backpressure, not failure. A destroyed connection, cancellation, or
serialization/write exception before acceptance releases the lease with no ack
or usable ticket. Do not infer handoff from a void reply helper that silently skips
a destroyed socket. A later socket failure is post-handoff uncertainty, not a
reason to requeue automatically. Test the decoded receiving bridge frame as well
as the local write boundary; this still does not prove the engine consumed it.

A coordinator/host must consult ownership again at its actual input boundary,
so previously formatted host-queued text cannot inject a message already handed
off through a tool result. Duplicates use the existing receive classification,
not a second claim. Invalid/stale/terminal envelopes are not recovery candidates;
existing closure and intentional-non-injection ack rules remain authoritative.

## Synchronous waiter input

Keep one waiter per CID. A waiter-consumed envelope uses the same tool-result
handoff/lease protocol as recovery: its ticket authorizes an explicit same-turn
reply and its input advances future snapshots, never the active default. Do not
ack merely when resolving the promise. Refactor the current handler's immediate consumed
ack into handoff completion. If the call is cancelled before handoff, route an
ordinary envelope once to normal input instead of silently losing it.

Timeout returns existing send acceptance plus `reply_pending`; it does not
invent peer input or advance any basis. A later reply queues normally and only
advances provenance when actually delivered in a later SDK turn (or separately
claimed recovery). Server-authored synthetic errors and validated internal notices
do not become ordinary peer basis. Classify by authenticated envelope origin and
the validated notice discriminator, never by `payload.error` alone.

An accepted legacy peer error without that discriminator is ordinary history on
the new server. Preserve the existing `peer_error` summary for failure handling,
and add `peer_error_envelope` containing the complete received envelope (including
body, peer, CID, and transport turn) to this waiter result. It is not renamed to a
successful `reply`. Only handoff of that full envelope activates a reply_ticket
and records future input provenance; promise resolution or the summary alone
does not. The current default remains frozen. A fresh same-turn call may
explicitly supply its turn and ticket; the next SDK turn uses it by default. Cancelled-before-
handoff legacy errors return once to ordinary queued input, and a legacy error
arriving after timeout follows normal delivery/recovery. Do not exempt arbitrary
legacy error bodies from server comparison to solve this migration case.

Use this classification for ordinary input and recovery as well as waiters. A
validated v1 notice or a server synthetic error grants no basis even if it is
returned to a waiter; its sender's latest ordinary basis remains unchanged.
A normal returned done proposal may authorize an explicit response; a terminal
closure cannot be overridden by that number.

## Advisory unread count (b)

Append a compact `unread_inter_agent: {count, scope: "ordinary-local-pending"}`
text block to results of `send_to_agent`, `list_agents`, and `whoami`, counting
locally accepted ordinary envelopes with no committed model-input handoff,
including host-queued and leased-but-uncommitted items. After recovery's handoff,
report the remaining count. No bodies, operator instructions, human messages,
or guessed server-only backlog are included. The value is a point-in-time
observation, not proof that zero remains at the next action.

| Engine | Route in this delivery | Not part of this delivery |
|---|---|---|
| Claude | Shared descriptor result through SDK MCP tool handler | PostToolUse hooks, fold, `priority: now` |
| Codex exec / app-server | Shared descriptor result through ToolHost/bridge | Arbitrary exec results or `turn/steer` |
| Antigravity | Shared descriptor result through its command bridge | PreToolUse deny-reason injection or process interruption |

This emits advice only when a listed kaoiro tool finishes. There is no immediate
notification while the engine only thinks or runs unrelated tools, no polling
requirement, and no unread-count mutation gate. Existing result text and schemas
remain intact; the additive text does not change the directory's agent array or
whoami's identity fields.

## Automated notification exception (Fuji M3)

Protected wrappers must not bypass the guard simply by setting `payload.error`.
Introduce a dedicated, closed `notice_type` discriminator for the two existing
wrapper-authored paths: `turn_failure` (`resolveTurnEnd`) and `stale_delivery`
(the notice produced by `receiveInbound`). It is an internal wire field, absent
from `send_to_agent`'s model-visible schema. Server ingress validates it before
ordinary admission; callers cannot add it through unknown MCP arguments.

Permitted notice shape: existing positive `turn_number`, existing explicit CID
(`new_conversation: false`), `kind: inform`, `meta.done: false`, empty
`propose_next`, no confidence/reject_reason, no in_reply_to, and an error code
from the closed set appropriate to its type. `turn_failure` permits the current
classifier outputs (`rate_limit`, `context_overflow`, `api_error`, `timeout`,
`interrupted`, `permission_gate_blocked`); `stale_delivery` permits only
`stale_turn`. Optional rate-limit reset seconds are a safe integer in
`0..9,007,199,254,740,991`, matching the classifier's current numeric domain.
Raw exception detail and arbitrary body/error-message text are forbidden: use
canonical per-code templates, with only the validated numeric reset substitution.
Move the template contract into protocol-owned fixtures shared by wrapper/server
tests. Server rejects any mismatch or extra content that could carry a verdict,
work instruction, or done proposal as `invalid_internal_notice`.

These constrained notices are accepted without reply-basis comparison. They
still require a connected target and valid conversation participants and pass
existing monotonic transport numbering, closure, quota, and reservation checks.
They advance the transport turn and its existing message/token accounting,
**not ordinary peer-basis history**; they cannot set done flags. Existing quota
exhaustion may still generate a server hard-limit closure, explicitly distinct
from an internal notice carrying a close decision. Server-authored synthetic
notices keep their authenticated server provenance and turn-zero path unchanged.
Legacy wrappers retain their preexisting error-envelope behavior; without the
validated discriminator their accepted messages count as legacy ordinary history,
so the exception cannot silently suppress a protected peer's basis requirement.
The receiving v1 wrapper must therefore preserve a legacy error's full envelope
through the waiter path described above; returning only `peer_error` is invalid
for an ordinary-history envelope. No special legacy-error acceptance bypass is
added to the server.
New wrappers in negotiated legacy mode emit the previous notice shape without
the discriminator; the compatibility test covers this internal-send path too.

Both automated producers still consume their allocated transport number, as
current fire-and-forget producers do; gaps are allowed. Route both through a
shared acknowledgement-observing internal sender. On reject/unknown, emit bounded
machine-readable diagnostics (code, CID, allocated turn, disposition), with no
automatic resend or reciprocal error notice. Do not roll numbering back across
ordinary concurrent sends. Do not establish normal auto-allow permission.
Rejected notices release reservations and issue no delivery sequence or pane
entry; accepted ones use the existing recipient ledger and normal error-input
classification. Their delivery failures do not recursively create notices.
No backend-specific or arbitrary-error-field bypass is permitted.

## Guarantees by incident and participant

Here sender means the author of the stale reply; recipient means the peer that
would act on it. Guarantees require v1 admission and accurate declared provenance.
The table is conditional on the origin-bound adapter contract and its real-engine
tests passing. Ticket binding alone is insufficient: delayed default calls were
reproduced across turns in Codex. Antigravity remains an unmet engine-boundary
gate, not an accepted exception to these guarantees. No v1 rollout is approved
by this design investigation.

| Incident | Sender-side outcome | Recipient-side outcome | Limit / reason |
|---|---|---|---|
| 1: crossed design post | Detect/reject old-basis post; return locally pending decision | Prevent delivery of rejected stale post | Does not assess design semantics |
| 2: unseen grant | Detect/reject outdated waiting report; return grant if queued | Prevent stale report delivery | Cannot start granted work automatically |
| 3: stale reply + done | Detect/reject before done accounting | Prevent closing on that rejected reply | Different-thread routing not protected |
| 4: verdict on withdrawn evidence | Detect/reject verdict predating withdrawal | Prevent acting on that undelivered verdict | Already accepted verdicts not retroactively revoked |
| 5: crossed implementations | Detect only a stale same-thread completion report | Prevent only that report's delivery | Edits/commit/push and changed baselines remain unprotected |
| 6: cross-thread ambiguity | Not addressed | Not addressed | No workstream authority or cross-CID supersession |

A rejection's visibility to its sender does not imply a conflict notification
reaches the recipient. That original issue acceptance remains explicitly open.
Legacy senders are outside the rejection guarantee. Supersede/cancel authority,
mutation barriers, baseline approval revocation, and engine interrupt are out of
scope. Do not close issue 407 on this delivery alone.

ADR-0036 F6 forbids automatically combining interruption with reset because tool
interruption and context destruction compound impact. This design performs
neither and leaves busy-reset rejection unchanged. The measured non-atomic tool
effects reinforce keeping cancellation outside this change. Future issue 412
input boundaries must preserve correlation and cannot silently advance the basis
at queue insertion.

## Verification matrix and implementation gates

Use production shared IA tools, coordinators, result handoff adapters, and channel
admission, not a duplicate fixture state machine. A default-constructed component
must reach its first meaningful operation without injected behavior. Loopback
transport/model fixtures can control order, but actual engine observations must
come from the pinned CLI/SDK when a claim depends on their behavior.
Required entries below remain implementation gates, not completed tests. A
handler-only fixture does not substitute for the actual-engine ticket tests.

| Case | Claude | Codex exec | Codex app-server | Antigravity |
|---|---|---|---|---|
| Queue/host-queue receive does not change snapshot; actual input does | Required | Required | Required | Required incl. stdin-write failure |
| Coalesced same-peer/CID N and N+2 surviving: basis N+2; removed higher item excluded, other CID isolated | Required | Required | Required | Required |
| B issued before result, guesses turn without ticket: fail; C copies actual result ticket: succeed | Actual SDK | Actual exec CLI | Actual app-server | Actual CLI |
| Reused, expired, or different-CID ticket: fail before send | Actual SDK | Actual exec CLI | Actual app-server | Actual CLI |
| Ticketless old T call after T+1 input: reject for normal completion/timeout and interrupt paths that can remain pending | Actual SDK | Actual exec CLI | Actual app-server | Actual CLI |
| Definite capacity/backlog rejection -> fresh ticket at handoff -> intentional retry succeeds; unknown -> no renewal | Actual MCP adapter | Actual bridge adapter | Actual bridge adapter | Actual bridge adapter |
| Mistyped ticket -> send_not_attempted -> correct original succeeds; spent original fails | Required | Required | Required | Required |
| Recovery claim from pending and host-queued batches; full/partial batch removal; no duplicate input or ack | Required | Required | Required | Required |
| Recovery cancellation before handoff, late callback after token change | Required | Required | Required | Required |
| Waiter ordinary reply: explicit retry eligible, default fixed, next snapshot updated, no queued duplicate | Required | Required | Required | Required |
| Waiter timeout then late ordinary reply: no early basis/ack, one normal delivery | Required | Required | Required | Required |
| Waiter cancellation/close/error: no lost ordinary body, synthetic input never becomes basis | Required | Required | Required | Required |
| Both automated producers reach actual internal sender; canonical notice acceptance and malformed rejection | Required | Required | Required | Required |
| Count advice through real registered tool response route, zero/nonzero/recovery remainder | Required | Required | Required | Required |

Run the ticket scenarios through actual engines and registered production tools,
with model loopback where supported and minimal live API calls otherwise. Fix
B's arguments before A's result exists, delaying B through permission or bridge
handling within the same SDK turn. B must fail even if it predicts the exact
peer turn. Construct C only after reading the actual tool result, copying its
random ticket rather than a fixture-known constant. Assert B emits no peer send
and C emits one with the intended basis. Cover both recovery and waiter issuance.
For every backend also submit reused, expired and wrong-CID tickets and observe
no network send; use a controlled wrapper clock for expiry without replacing the
real engine/tool route. Do not claim these results from SDK metadata probes.
If an actual engine cannot be exercised, report the unmet gate to the director.

Shared tests additionally cover missing/malformed ticket, ticket-only arguments,
wrong peer/basis/session/turn, simultaneous replay (at most one attempt), earlier
ticket invalidation, capacity/entropy failure, and expiry/cancellation while a
validated attempt waits. A spent value stays spent on every outcome; only
allowlisted definite rejections can issue a distinct fresh value at handoff.
Test T-bound ticket rejection in T+1 separately from a ticketless delayed T
request. The latter must use the actual engine and adapter, with both normal
completion (including tool timeout) and interrupt: hold before ToolHost/callback,
deliver newer peer input in T+1, release, and assert zero sendInterAgent invocations.
Where normal completion waits for the held tool, measure that wait and release a
positive control; do not claim that a one-second wait proves all timeout behavior.
After origin guards are implemented, repeat the baseline reproductions; disabling
origin binding must make the no-send assertion fail on each reproduced path.
Also delay before socket connect, across permission/CID/admission waits, and
across turn/start-response reordering; native origin must not be reassigned.
For every adapter, separately hold an already admitted handler at an actual
permission/CID/transport wait, retire its origin, start the next input, then
release it: the final pre-sink check must yield zero send calls. Mutate that
pre-sink check independently of the ingress check so the deferred-handler test
fails. Socket close alone must not be credited with cancelling JavaScript work.

Recovery handoff tests must traverse all three registered result paths, not just
call the shared handler. Use the actual SDK MCP server for Claude and the actual
ToolHost/bridge sockets for Codex and Antigravity (Codex's two host backends both
wire this route):

| Route | Successful boundary | Pre-handoff failure control |
|---|---|---|
| Claude SDK MCP | Registered callback returns the complete recovery body; SDK loopback observes the tool result, exactly one delivery ack, and one active reply_ticket | Cancel/retire captured token after handler completion but before callback handoff: no body handed off, no ack/usable ticket, lease returns to normal input once |
| Codex ToolHost/bridge | Response frame written and decoded by the real bridge; exactly one ack/ticket activation and no subsequent queued duplicate | Destroy socket after handler completion but before write; assert skipped write, no ack/usable ticket, restored lease and one normal injection; also cover token cancellation |
| Antigravity ToolHost/bridge | Response frame written and decoded by the real bridge; exactly one ack/ticket activation and no subsequent queued duplicate | Destroy socket after handler completion but before write; assert skipped write, no ack/usable ticket, restored lease and one normal injection; also cover token cancellation |

Hold execution at the actual adapter boundary in these failure tests; a mock
handler returning an error does not test a dropped response. Assert ack timing
(none at shared-handler completion), exact envelope identities, and unchanged
current snapshot in both paths. Restore the connection/start the next input to
observe released items rather than merely inspecting a lease flag. Keep the
documented post-handoff uncertainty outside an exactly-once consumption claim.

Further deterministic server/wrapper tests:

- Use real channel admission to force each allowlisted capacity/backlog rejection,
  after obtaining an actual waiter/recovery ticket. Assert zero recipient delivery,
  spent old value, distinct renewal only after adapter handoff, unchanged default
  and no extra body ack, then clear the condition and explicitly retry successfully.
  Exercise all three real result adapters and both Codex backends. Drop the server
  acknowledgement after acceptance to produce unknown; assert no renewal and no
  automatic resend. Also cover stale/closed/other errors, origin retirement and
  broken result socket before renewal handoff, and repeated intentional rejection.
- Mistype a still-live ticket: local error with send_not_attempted, zero server
  attempts, original record unchanged; recopy original -> one successful attempt.
  Replay a spent value -> spent error, zero new sends. Expiry -> expired error.
  No error echoes the supplied value. Bound the total authorization record count.

- Reproduce representative incidents 1–4: peer N entered input; M accepted while
  the model works; response/done/verdict from N rejected with no ordinary state,
  recipient body, pane entry, or delivery-sequence mutation. Cover M accepted
  before local receipt and simultaneous crossed sends.
- Matching/future/missing/negative/unsafe basis, first send, repeated own sends,
  differing peers/CIDs, closed and unknown CID, ordinary replay, default/explicit
  override limits, snapshot reset/eviction, transport-reject numbering rollback,
  and no permission auto-allow on reject.
- Recovery boundaries: 10/11 messages, exact byte bound and one-byte overflow,
  multibyte UTF-8, oversized oldest, duplicate delivery, pending-done gate release,
  lease rollback, ledger prefix holes, rejoin, and no synthetic notice loop.
- Notice validation: both legitimate producers without ordinary basis; each
  forbidden field/body/code/type rejected; absent discriminator is not a bypass
  on v1; accepted notice changes transport accounting but not peer basis;
  quota closure distinguished from done; rejected/unknown notice diagnostics,
  no automatic retry, no leaked reservation or forged sender identity.
- Exercise all compatibility rows via actual join/echo/send wiring, including
  rejoin downgrade/upgrade, legacy-to-protected history, historical replay,
  protected-mode visibility, and preservation of issue 365's build descriptions.
- Mixed-version waiter tests use actual join -> send -> wait_for_response ->
  result handoff -> next send, with a new server and each receiving engine route.
  For v1 A -> legacy B, B's real resolveTurnEnd sends legacy turn_failure N:
  A receives peer_error plus the complete envelope, its default stays old, a
  fresh explicit send with N and the handed-off ticket succeeds; its next SDK
  snapshot defaults to N.
  For legacy A -> v1 B, B's validated notice is accepted without updating B's
  ordinary history; old A's real waiter still returns peer_error and its next
  legacy send succeeds without basis. Also test legacy error delivery after
  timeout and cancellation before handoff. Assert server ordinary history and
  recipient provenance, not just tool success. A valid v1 notice/server synthetic
  error must never issue a reply ticket; arbitrary legacy error content
  must remain subject to the ordinary basis requirement.
- Mutation tests: remove the server compare; corresponding incident tests must
  fail. Disconnect actual snapshot publication, recovery ownership check/ack
  wiring, notice discriminator validation, and negotiation selection separately;
  their integration tests must fail. Restore each before final gates. A legacy
  non-conflict/control flow must still succeed. Report actual exit codes.
  Remove the paired-field requirement and ticket validation as one guard
  mutation: B must reach admission and the expected-no-send assertion must fail.
  Separately disable one-use consumption, expiry, and binding validation to make
  their respective controls fail. Disable renewal to fail the definite-rejection
  retry test; treat unknown as definite to fail the no-renewal control. Bypass
  handoff activation to fail the pre-write-disconnect test. Remove each engine's
  origin binding/retirement to fail its delayed-call test; do not count ticket
  rejection as evidence that the ticketless default path is covered.
  Restore all guards, rerun the same real-route C success and B failure tests,
  then run final gates. Removing only one of two redundant checks is not enough
  if the other masks the mutation; report an unpinned check instead of claiming red.
  Drop the legacy peer_error_envelope/provenance handoff: the mixed-version
  next-send test must fail. Cut each result adapter's ack/lease wiring: its own
  successful/failed handoff tests must fail, not only the shared helper tests.

Prepare dependencies only in `worktrees/kogane-407`. Run affected protocol/core/
agent-common/engine checks; full `cd wrapper && pnpm typecheck` and `pnpm test`;
full server `scripts/mix-test.sh` (executes `cd server && mix test` and preserves
complete failing output), plus formatter checks for edited Elixir. Report command
exit codes, warnings, unhandled errors, and commit-bound evidence. No full-suite
result from the research report substitutes for these implementation gates.

## Operational before/after measurement (Fuji M1 and director must)

Adopt and concretize the joint report's Operational measurement proposal. The
initial descriptive cohort is five completed assignments before and five after.
The baseline window is the seven calendar days ending at the first server switch;
choose the latest five eligible baseline completions. The post-change window is
the seven calendar days starting at `T_v1_all`; choose the first five eligible
post-change completions. Mixed-version rollout work is reported separately,
not pooled with the protected cohort. If either window supplies fewer than five,
report the actual number and mark comparison incomplete; no silent widening or
selection of favorable later tasks. A changed sampling plan requires a recorded
director decision before examining the replacement cohort's results.

Before implementation starts, Kuroe (sole writer and measurement owner) creates
`docs/evidence/2026-09-26-issue-407-operational-baseline.md` in a director-owned
worktree. This is a durable cohort/source inventory, not a temporary task list;
Kogane does not edit it. Record candidate assignment and SDK session IDs, exact
transcript/tool-result/server-log paths, retention/rotation availability, covered
time ranges, and each metric's availability or `unknown`. Begin preserving the
available pre-change evidence then, before either implementation or server switch;
do not wait until results are counted. Preserve relevant exports with content
hashes in director-controlled access-restricted storage, and record paths/hashes
without copying private transcript bodies into the repository. Kuroe sends the
inventory path/hash and capture-start timestamp to Kogane before authorizing
implementation. If access or retention requires operator privileges, Kuroe asks
the operator for the specific export/retention action; Kogane does not change
production logging or collect inaccessible sessions. Unavailable historic local
retries/rejections remain unknown; new diagnostics cannot backfill them.

Continue candidate capture through the baseline window. Immediately before the
server switch, Kuroe freezes the candidate inventory, data-availability matrix,
and selection rule; record the actual T_server afterward to identify the latest
five eligible completions mechanically. Preserve all candidate sources before
rotation, not only favorable selected sessions. If required records could not
be preserved, record missingness and keep the affected comparison incomplete;
the director must report that limitation before rollout rather than claiming a
complete baseline. No operator permission beyond actual export/retention needs
is presumed. These capture steps are pending operational work, not completed
measurements or an additional product feature.

Before counting outcomes, the director records each selected assignment and SDK
session ID set, exact window timestamps, participant engine/backend/model mix,
protection mode, task category (design/review/implementation), deliverable count,
test-scope category, and completion criteria. Match on director, task category,
engine/backend/model mix, and comparable deliverable/test scope, with the matching
judgment and any deviations written alongside the pair. Unmatched work is reported
separately. Do not invent IDs before those assignments exist or claim a causal
productivity estimate from a small observational sample.

Unit: one completed assignment/workstream across its CIDs. Count accepted IA
messages and request/response exchanges; crossing incidents; extra exchanges solely
to restate/correct a crossing; stale-basis rejects; intentional retries; abandoned
turns/interrupts; retracted verdicts; reimplementation; elapsed completion time;
and reported token usage when present. Give raw counts, per-completed-task and
per-100-accepted-message rates, and group duplicate retries as one conflict episode.
Exclude normal review findings and intentional scope changes from crossing repairs.
An accepted extra restatement and accepted corrective reply count as two additional
IA messages and one corrective exchange; an unanswered restatement counts only
as one extra message until its reply exists. Attribute a correction to crossing
only when the transcript links it to a newer accepted peer turn not incorporated
in the earlier response, recording those turn IDs; ambiguous cases stay separate.

Every `send_to_agent` invocation is a tool attempt. A local schema/override error
or rejected server send counts as a failed tool attempt, not an accepted IA
message or peer exchange. Each subsequent intentional call for that same send
intent counts as a local retry, including missing/invalid argument repairs.
Tag the rejection reason and distinguish network resends from model tool retries.
Compare raw extra-message/exchange counts and local retry counts separately;
never relabel one as the other. Present task count and elapsed window with every
rate so a change in sample size cannot look like an efficiency improvement.

Sources: transcript envelopes (CID/turn/sender/timestamps), send tool results and
structured rejection diagnostics, lifecycle records, and artifact SHAs. Add bounded
content-free stale-rejection/handoff diagnostics in this change so rejected sends
are measurable without storing private bodies in logs. Transcripts alone cannot
count rejected sends. Missing historical indicators are unknown, not zero; no
measured reduction is claimed until comparable real sessions exist. Synthetic
fixture counts do not establish productivity gains. The director owns this later
measurement and records it before issue closure.

## Documentation and delivery

Update protocol types and IA `messages.md`, `conversations.md`, `send-and-wait.md`,
`errors.md`, `delivery.md`, and directory/tool reference. Document snapshot/basis
versus delivery ack, internal notice constraints, protected/legacy visibility,
inline body ownership and limits, origin retirement, transient-rejection renewal,
local copy-correction errors and the handoff-based lifetime. Update engine bridge
references for their origin contract. Update transport capability and deployment
references; link from `architecture/inter-agent-messaging.md`; add a reply-binding
ADR with A/A'/I rationale and reference issue 412. Do not rewrite the reviewed
research evidence to claim implementation or new measurements.

After approved design and baseline-capture handoff:
implement on the single integrated branch `issue-407-message-crossing`. Separate
commits and checks by layer: server basis/notice/capability; shared wrapper
provenance/waiter/recovery; engine adapters and integration tests. These are review
and verification units, not independently landed product stages: all interdependent
contracts land together once, after implementation review, on develop. Deployment
still follows the server-then-wrapper staged rollout above. Explicitly stage own
files, use forward-only English commits mentioning issue 407 and the required
kogane/model attribution, push for director-dispatched review, and let the director
land. Review targets and verifiers stay frozen during each round.
