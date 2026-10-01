---
title: ADR-0063 phase 3 — Codex inter-agent early delivery
description: Design for attaching independently leased inter-agent input to a running Codex app-server turn through turn/steer.
status: proposed
last_updated: 2026-10-01
---

# ADR-0063 phase 3 — Codex inter-agent early delivery

## Decision and scope

Design owner: Fuji. Director: Hisui. Baseline: `develop` at
`3794baa7f71f4736138ef6e3a9bfbb37743764ee`. This plan answers the open
inter-agent half of [issue #346](https://github.com/sakuraiyuta/kaoiro/issues/346)
under [ADR-0063](../adr/0063-layered-delivery-authority-and-continuations.md)
and [ADR-0058](../adr/0058-codex-app-server-turn-steer.md). It is a design,
not authorization to implement or advertise a new mode.

**Decision:** use the Stage 2 app-server RPC transport, active-turn identity,
foreign-turn fail-stop and response/item/terminal reconciliation primitive.
Do not use Stage 2's operator-only queue and settlement policy unchanged.
Admit ordinary peer input through a separate priority lease, attach it to the
existing host turn only after a valid response or an exact matching input item,
and give that input
its own delivery-stage, reply-ticket and failure obligations. A root input
remains the existing per-peer batch. Codex `exec` continues to queue. Phase 3
advertises `early: "steer", yield: "none"` only after its gates pass. A valid
director `yield` request is downgraded by phase 1 to `early`, with the
server-stamped reason visible to the sender. A non-destructive Codex boundary
that actually cuts after the current tool has not been measured; `turn/interrupt`
is hard cancellation and is not a substitute.

The [issue #463](https://github.com/sakuraiyuta/kaoiro/issues/463) default-on
and per-agent dashboard controls are a later integration. This phase must
expose an effective-policy seam rather than freeze the current environment
opt-in into the host lifetime. The separate backend-default flip is scheduled
immediately before #463 lands, as the ADR-0058 amendment requires.

## Evidence and premise decisions

The following checks were made on this baseline, independently of the earlier
issue comments. Source locations are evidence of current wiring, not claims
about unobserved upstream behavior.

| Premise | Check on this baseline | Decision |
| --- | --- | --- |
| Production pin and transport | `wrapper/codex/package.json` and the lockfile select 0.156.1. The installed native executable returned `codex-cli 0.156.1` and SHA-256 `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`. | Bind the design's currently measured steer behavior to this artifact. A new pin requires new native evidence. |
| Current IA path | `cli.ts` joins with `interAgentDeliveryModes: {early:"none",yield:"none",stage_reports:true}`; `handleInterAgentMessage` passes injectable input to `CodexInterAgentTurnCoordinator.receive`; that coordinator holds a second batch from the same peer until its active token settles. `host.send` queues IA input. | Stage 2 reuse is limited to its transport and evidence state machine. A separate priority lease and host IA entry point are required. |
| Current operator steer | `host.ts` writes `turn/steer` inside the admission callback, tracks response, matching input item and terminal, and guards pending settings and reset. `app_server_steer.ts` records the two-sided outcome. | Reuse the transport and outcome primitive, with source-specific admission and settlement. Never route an IA envelope through `host.send(... source:"operator")`. |
| Current handoff and lease | `cli.ts` acknowledges a root at `onTurnStart`, reports `turn_start_accepted` after a valid `turn/start`, and resolves exactly the root token's pending conversations at turn end. `InterAgentTool.notePendingInjection` owns one unresolved CID per token and rejects replacement by another token. | A steer cannot call `onTurnStart` again or overwrite the root batch. Give each steered envelope a distinct sequence record and attach new CID obligations to the current token only after confirmed handoff. |
| Production composition check | In this worktree, the existing tests `host_app_server_steer.test.ts`, `cli_operator_steer.test.ts` and `cli_app_server_lifecycle.integration.test.ts` ran with exit 0: 18 tests in 3 files. The last test uses the pinned native CLI, the production `runCodexCli` composition, and local provider/Phoenix fixtures; it confirms current queued IA behavior, not IA steering. | Preserve those paths as controls; they do not by themselves prove the proposed path. |
| Correlation surface | I generated the pinned binary's v2 schema. `ItemCompletedNotification`'s `userMessage` item has `clientId` and a `content` array whose text variant carries `text`. Current `app_server_projection.ts` emits only the started item's ID/client ID and drops completed content. | Extend the projection to validate a completed item's exact submitted text before activating IA tickets. Schema shape is available; runtime ordering and exact content still need a native probe. |

The [Stage 2 native record](../evidence/codex-app-server/stage2-steer-probes-2026-09-30.md)
observed on the same pinned binary that `turn/steer` can be accepted before a
running command completes, while the matching user-message item appears after
that command; an accepted steer interrupted before its item can remain
unobserved. I verified the artifact identity above, but did not independently
repeat those model schedules. Implementation must repeat the native probe
against its final pin and production composition. No design assertion equates
RPC acceptance with model inclusion or immediate preemption.

## Scheduling and ownership

1. `receiveInbound` keeps first authority over waiter consumption, stale and
   terminal classification. Consumed replies remain in the tool result and
   never also enter a steer. Only an ordinary injectable envelope with the
   server-stamped granted intent `early`, a negotiated `v1` echo, effective
   per-agent policy on, and the app-server backend enters the priority lane.
   Notices, missing authority, `normal`, disabled policy, and exec enter the
   existing root queue. The wrapper cannot upgrade a server-granted `normal`.
2. The priority lease holds the immutable envelope, delivery sequence,
   incarnation/generation, source peer/CID/turn, receive order and one local
   lease ID. It owns no SDK turn token while queued. Do not put it in
   `#activeTokenByPeer` or replace the root batch. Reclassify it immediately
   before admission, and retire a now-terminal/stale item without injecting.
   The server's pending limits remain the outer bound; the wrapper also bounds
   priority bodies and records overflow as a queue downgrade, never a drop.
3. One host dispatcher serializes operator and IA steer writes, root dispatch,
   reset, stop and policy changes. Earlier queued input of either source that
   is waiting for a boundary blocks a later steer; within one peer, a later
   early item never overtakes an earlier ordinary item. The common total cap
   is eight steer writes per active turn (the Stage 2 value); at most three
   admitted IA leases may consume it. Remaining inputs keep receive order for
   the next root. Operator inputs cannot reset the IA quota. This admits both
   sources under load without claiming global FIFO across independently
   accepted server deliveries.
4. At the synchronous `turn/steer` commit point, check the actual active
   thread/turn/token, matching join echo and delivery generation, effective
   policy, unfinished and unabandoned turn, no pending reset or new model,
   effort, sandbox, network or approval selection, no earlier blocking input,
   cap, and no unresolved CID owned by another token. During a pending
   `turn/start` response, wait once and recheck everything. No eligibility
   check made at receipt may stand in for this recheck. A failed check leaves
   the same envelope in its ordered root queue with a visible reason.
5. One `turn/steer` contains a bounded same-peer batch with a unique
   `clientUserMessageId`, exact text digest and all its delivery sequences.
   Batch only messages eligible for the same active token and reply policy;
   never coalesce different peers or overtake an older same-peer item. An
   explicit precondition rejection installs an order placeholder before a
   later steer can commit, then resolves it into the unchanged root input.
   An arbitrary RPC error is a refusal, not an infinite retry. A possibly
   written request with no conclusive response is `unknown` and is never
   automatically resubmitted.

The Stage 2 `SteerRecord` is suitable for the two-sided RPC/item/terminal
race, including item-before-response, contradictory turn ID, disconnect and
terminal-before-response. Its `SteerOutcome` must not directly settle IA:
operator `requeued` and `refused` only log or reject an instruction, while IA
must resolve each envelope's stage, delivery ledger and peer obligation. Keep
one record per steer request, with per-envelope leases underneath; source
policy interprets the common result. Keep the foreign-turn tripwire enabled
whenever either operator or IA steering is possible. A foreign turn freezes
new admission; it is not a reason to migrate a steered input to another turn.

## Handoff, reply basis and failure contract

| Event | IA outcome and accounting |
| --- | --- |
| Server accepts inbound | `accepted`, then `queued`; no delivery ack, reply basis, or turn-failure obligation yet. |
| Valid steer response for the captured turn | Report `submitted` with a new closed-vocabulary handoff `turn_steer_accepted`, then resolve that delivery sequence in the server ledger. Attach each sequence's failure obligation to the captured host token, even when another sequence has the same CID. Record an accepted-but-unobserved input separately. |
| Matching completed `userMessage` item before terminal, with the client ID and exact submitted text digest | This also proves app-server intake if the RPC response was lost. Report `submitted` with the distinct handoff `turn_steer_item_observed` if not already submitted, and attach that sequence's obligation. It is not a captured model request, does not publish the turn's default basis, and does not alone report `included`. An `item/started` without full content is only a correlation hint. Duplicate items do nothing. |
| Tool call spending the input's one-use ticket | Report optional `included(evidence:ticket_used)` and credit only that input to completed reply history. This proves that the call saw the authorization carried with the input; it does not prove the model followed the message. |
| Authoritative terminal | Close ticket activation and capture the host error. Reconcile the captured token after every written steer has a response or bounded timeout; a late response reconciles directly on its `SteerRecord`, without a second `onTurnEnd`. Release only that token's obligations before a later same-CID root can own them. Report `settled(turn_end)` only for corroborated input. An accepted response with no matching item ends as `unknown(not_observed)`, never `settled`, even though it already reported `submitted`. The notice decision is per sequence, as below. |
| Definite precondition rejection | Queue the original lease at its arrival position, report the rejection reason, and leave its delivery sequence unresolved until a later root handoff or intentional non-injection. |
| Lost response after a possibly delivered write, mismatched response, or contradictory item | Report `unknown` once, never queue or retry the same body, and retain the exact owner and sequence in the bounded diagnostic record. Do not mark it `failed_before_handoff` or send an ordinary failure notice that invites retry. |

The phase-3 failure ledger extends `notePendingInjection` from one CID slot to
one record per `(host token, delivery incarnation, generation, delivery_seq)`.
Each record contains the peer, CID, peer turn, batch ID, handoff evidence,
reply coverage and final uncertainty class. A second same-CID steer on the
same token does not overwrite the first record. `pendingConversationIdsForTurn`
and `resolveTurnEnd` become projections over these records; the old CID map
alone cannot settle this path. A successful or possibly-delivered reply
discharges **only** the input sequences named by its captured default basis
or activated ticket; a rejected reply discharges none. Ticket preparation
records its exact sequence coverage, not merely its CID. No reply basis
implicitly covers a later steer. Preserve the existing root
`notePendingInjection`/`resolveTurnEnd` API through a tagged local-root
adapter: a legacy or non-negotiated root without incarnation/generation/seq
gets a token-local ID, not a fabricated server sequence or a shared missing-ID
key. Its current one-obligation-per-CID, accepted-reply clearing and
turn-error fan-out semantics remain. Hold a same-CID steer behind such a root
until its token settles, so scoped and unscoped obligations do not merge.
Only negotiated phase-3 steers use the sequenced ledger and
`affected_deliveries`; an unhanded priority lease has no failure obligation.

At captured-token reconciliation, reduce unresolved records by `(peer, CID,
notice class)` in delivery-sequence order. Send at most one notice for each
class in a CID on that token, with a bounded `affected_deliveries` list of
`{delivery_seq, peer_turn_number, batch_id}` in `error`; split an oversized
list into ordered, non-overlapping chunks. The two classes are `classified`
(corroborated intake, host turn error) and `uncertain` (possible write or
accepted-but-unobserved input, `timeout` code). A classified notice carries
the host's classified error; an uncertain notice always says wait and do not
retry. A successful terminal clears corroborated obligations without notice,
but an unresolved uncertain sequence still gets its timeout notice. A reply
already sent for A cannot discharge B. One batch may own several sequences;
batch identity never replaces per-sequence accounting. Notice construction
and exact-token release happen once in the same reconciliation, before any
successor root can acquire the CID.

| Same-CID state at reconciliation | Notice and release |
| --- | --- |
| A corroborated, B unobserved, neither replied, host error | One classified notice naming A and one timeout notice naming B; release A and B. |
| A corroborated and replied, B unobserved, host error | No notice for A; one timeout notice naming B; release both. |
| A and B corroborated, neither replied, host error | One classified notice naming both; release both. |
| A and B corroborated, reply covers A only, host error | One classified notice naming B; release both. |
| B item before terminal, response after terminal | Keep B's captured-token record until the response or bounded timeout. A valid response plus the pre-terminal item corroborates B but cannot activate a post-terminal ticket; then apply the host's success/error rule. Invalid or missing response leaves B uncertain and gets a timeout notice. Release B immediately when that `SteerRecord` reconciles, without waiting for another turn-end callback. |
| Later same-CID root while the earlier token awaits a response | Keep the root behind the CID owner fence. Reconcile and release the earlier token first; the root then takes a distinct token and can never inherit the earlier notice or ticket. |

### Recipient notice contract

The sequence list in the table is a wire contract, not merely a producer log.
Extend `InterAgentErrorPayload` for `notice_type:"turn_failure"` with optional
`affected_deliveries: [{delivery_seq, peer_turn_number, batch_id}]`. Here
`peer_turn_number` is the original sender's outbound turn number, not the
failure notice's own turn number; the sender already knows it when
`wait_for_response` registers. `delivery_seq` is the recipient-local ledger
sequence, and `batch_id` is the captured steer request ID. Every covered
sequence appears in exactly one notice class. The server-first change to
`InterAgentReplyBasis.valid_notice?` permits this field only on
`turn_failure`, only with one to 16 entries, exact entry keys, positive safe
integer sequence/turn numbers, a nonempty bounded batch ID, and strictly
increasing sequence numbers. It retains the existing top-level/error-key
allowlists and canonical `code`/`message`/`body` checks; malformed lists,
unknown fields and coverage on `stale_delivery` are rejected. The producer
chunks longer lists into consecutive non-overlapping notices. Ship this
validator and protocol type before any wrapper emits the new field.

The sender's waiter stores `(CID, expected peer, sent peer_turn_number)`. A
scoped failure notice consumes that waiter **only** if its actual sender
matches the expected peer and one `affected_deliveries` entry has the exact
sent turn number; CID alone is insufficient. A notice covering A but not
awaited B follows the ordinary asynchronous injection path, unchanged and
visible to the model; it does not clear B's waiter or turn into a reply.
Ordinary replies retain the existing CID waiter behavior. A matching notice
returns `peer_error` with `affected_deliveries`, the awaited turn number and
guidance explicitly scoped to those entries. The asynchronous
`formatInboundMessage` prints each covered peer turn and sequence before
`errorGuidance`, and says that guidance applies only to those inputs. A
notice never grants reply authority or consumes a peer reply ticket.

Use a negotiated `notice_attribution:"v1"` sender join capability and echo.
The server stamps the sender's negotiated support onto each relayed ordinary
peer input; a receiver must use that immutable stamp, not a possibly stale
directory entry, when deciding its notice format. If the original sender did
not negotiate support, the receiving wrapper sends **one** legacy CID-wide
notice per `(token, CID)`: whenever any unresolved input of that CID is
uncertain, its code is `timeout` and the model-visible guidance says wait and
do not retry any
input from that failed token; otherwise it uses the existing classified
notice. It does not send two indistinguishable same-CID notices with
conflicting retry advice. Conversely, a new sender treats an unscoped legacy
`turn_failure` from an older receiving wrapper as unattributed: it does not
consume a specific-turn waiter, injects it with conservative wait/no-retry
guidance, and lets the waiter continue until a matching reply or timeout.
The server strips any client-supplied capability stamp and issues its own;
older servers do not echo the capability, so wrappers retain the legacy
format and conservative receiving behavior. This rollout does not change
ordinary replies or server turn-zero notices.

The active turn's default reply snapshot remains fixed (ADR-0062 D7). Before
writing a steer, use `InterAgentTool.prepareFoldInput(activeToken, envelopes)`
as a *ticket primitive*, with a Codex-specific activation condition: a
completed `userMessage` item on the captured thread/turn carries the matching
`clientId` and the full submitted text digest before terminal, with no
contradictory RPC response. The steer text carries the same per-peer/CID
single-use authorizations, formatted as untrusted peer text. Until both facts
item and valid matching RPC response are both observed, the tickets are
provisional and cannot authorize a send. If the item precedes the response,
retain it until that response arrives. A matching completed item alone can
establish delivery bookkeeping after a lost response, but grants no same-turn
reply ticket; a contradictory response instead makes the delivery `unknown`.
If the response arrives but no matching item does, the delivery is submitted
but the ticket remains provisional. A call whose
request predates ticket activation retains its frozen old basis. Activation
cannot retroactively authorize it. Ticket use is checked again at the send
sink, and tickets retire with the active turn. A matching item after the
terminal is too late to activate.

Use explicit transitions: `SteerWriteAttempted` captures the write state and
owner; `SteerResponseValidated` and `UserMessageCompletedMatched` latch the
two facts; `SteerTicketActivated` occurs only after both latches and before
terminal; `SteerTerminal` irrevocably closes activation. On
`SteerTicketActivated`, call `prepareFoldInput.activate()` (which invokes
`onTicketPrepared`) and then `retainSteeredBody`. Supersede an older unused same-CID
ticket only at this event, never on `SteerWriteAttempted`, response alone,
item alone or `submitted`. The new ticket's exact sequence becomes the reply
coverage; the old ticket is retired atomically with activation. If activation
fails, keep the old ticket while its owner remains live. A valid response
arriving after `SteerTerminal` may still settle delivery evidence but cannot
activate or replace a ticket.

`prepareFoldInput` currently credits a fold only on ticket use, and the
root default snapshot never inherits an uncredited fold. Carry the same
bounded retained-body recovery rule to Codex steers **only after**
`SteerTicketActivated`: after a stale-basis rejection, re-hand that body with
`folded_earlier: true` and a fresh ticket when it fits. Retire it on ticket
use, a newer confirmed input from the same peer/CID, or session ledger reset;
count capacity evictions. Inputs whose item or valid response is missing at
reconciliation never enter this retained-body store because
`onTicketPrepared` is not called for a provisional ticket. Their sender gets
the sequence-specific timeout notice, and operator recovery uses the bounded
server stage record and the
sender's original body; there is no automatic body replay or fabricated reply
authorization. After that record expires, only the aggregate uncertainty
counter remains. Root successors cannot borrow an earlier turn's ticket.
`reply_authorization` remains absent for server turn-zero status notices.

The current server resolves out-of-order `submitted` sequences but **does not
resolve `unknown`** (`DeliveryStates.report_stage` on this baseline). Phase 3
adds one narrow, server-first resolution path for a possibly written steer
without a valid response. The wrapper may emit the tuple
`{stage:"unknown", mode:"early", handoff:"turn_steer_write_uncertain",
reason}` only when the captured `RpcTicket.writeState()` was `writing` or
`written` at a terminal/error boundary, no valid response was latched, and no
matching completed item already proved intake. The closed reasons are
`turn_steer_timeout`, `turn_steer_disconnected`, and
`turn_steer_invalid_response` (including a wrong turn ID), plus
`turn_steer_item_conflict` for contradictory item evidence. `unwritten` and
`failed` are never eligible; a definite precondition rejection stays queued,
while an item-only case uses `submitted(turn_steer_item_observed)` instead.
The wrapper snapshots the write state at the transport boundary before
classifying, so a later callback cannot turn a never-written input into an
uncertain one. A contradictory completed item after a valid response may
produce `unknown(turn_steer_item_conflict)` for diagnosis, but its sequence
was already resolved by `submitted` and cannot use this resolution path.

The server validates the current channel owner, ledger incarnation,
generation and issued sequence as it does for other reports; additionally it
requires the persisted sequence's granted mode `early`, last stage `accepted`
or `queued`, no earlier `submitted`/`settled`/`lost`/qualifying `unknown`, the
exact handoff and one of the four reasons above, and a valid timestamp.
Only this exact report atomically records `unknown`, adds that sequence to the
out-of-order resolved set, releases its metadata and early slot, and
increments `uncertain_count` once. It does **not** increment `lost_count`,
claim dispatch, or change the stage to `settled`; a duplicate exact report is
idempotent and conflicting later reports are rejected. The server cannot
independently prove the stdin write from these fields: it trusts the
authenticated, owner-fenced wrapper's observation. The wrapper's
`writing`/`written` guard, not server validation, is the evidence boundary.
Legacy root/Claude `unknown` reports and any report lacking this exact
handoff retain their existing history-only behavior; they do not resolve a
gap or increment the new counter. A later skip or generation retirement can
still count such a legacy gap as lost. `submitted` already resolved a sequence,
so an accepted-but-unobserved steer can end with
`unknown(turn_steer_not_observed)` without resolving it twice; record it in
`uncertain_count` once when it becomes terminal. An item-observed steer whose
response never validates similarly ends
`unknown(turn_steer_no_valid_response)` after its earlier `submitted` and is
counted once. A submitted input with contradictory item evidence uses
`unknown(turn_steer_item_conflict)` and is likewise counted once. For these
post-submission reasons, require the same
owner/incarnation/generation/sequence checks, persisted mode `early`, an
earlier `submitted` with the appropriate `turn_steer_accepted` or
`turn_steer_item_observed` handoff, no prior terminal stage, and the exact
reason. They cannot resolve an unsubmitted gap. Other reason/handoff
combinations, including legacy free-string `unknown`, remain history-only.

`acked_seq` remains a resolved prefix, never a dispatch certificate.
`lost_count` remains the count of server-classified ledger retirements in its
existing generation scope. Add durable `uncertain_count` and
`last_uncertain` to the recipient ledger and `inter_agent_delivery` status.
They aggregate phase-3 uncertain outcomes for the **recipient ledger
lifetime**, persist across same-owner reconnect and process-generation or
incarnation replacement, and reset only on ledger deletion. The report still
must carry its current incarnation/generation fence; preserving the aggregate
does not preserve an old recovery incarnation. On `bind_resync`, carry these
two fields from the old entry into the new incarnation. When loading an older
persisted entry without them, initialize to `0` and `nil`, not a fabricated
history-derived value. Persist an increment atomically with that sequence's
terminal outcome. Once history expires and the sequence is retired, a replay
cannot recreate or recount it. `last_uncertain` contains
`{at, incarnation, generation, delivery_seq, reason}`, with no message body,
so its origin remains intelligible after replacement. `whoami`, `list_agents`
and the operator delivery status expose the aggregate. A zero
`lost_count` and no pending gap can therefore coexist with nonzero
`uncertain_count`; neither proves delivery. Per-message stage history is
queryable only within its existing one-hour terminal retention and 2,000
record cap. After eviction, `message_status` returns `expired`; the durable
aggregate is the remaining operational signal, not a per-message recovery
record. The sender's original body and its own conversation record are needed
for any later human recovery; the server never reconstructs or replays it.
The server handoff enum and status schema must land before the wrapper; rolling
that server back requires rolling the wrapper back.

## Permission, lifecycle and version review

- Permission and approval are captured for the existing `turn/start`
  reservation. A steer cannot change sandbox, network, model, cwd, schema or
  approval policy; pending selections block it. An in-flight approval request
  remains under the policy captured for that turn. An IA message may be
  admitted while a tool or approval is pending, but it cannot answer the
  operator's approval dialog. Test both orders with allow/deny and timeout;
  do not infer a new permission decision from steer acceptance.
- `turn/completed`, not a final-answer item, ends ownership. Stage 2 observed
  multiple final answers in one steered turn. On interrupt, watchdog fail-stop,
  close, reset, EOF or foreign-turn failure, first classify every root and
  steer lease by the actual write/response/item facts, then settle or retain
  uncertainty once. Release a submitted CID only for its own host token.
  Retire never-started queued sequences through existing skip-v1 paths. Do
  not replay uncertain input after app-server to exec rollback or restart.
- [Version-sensitive, 0.156.1] Stage 2's rejection strings, compact error
  shape, command/item ordering, and steer-before-interrupt result are measured
  on the binary above. Review turns are schema-only. Re-run the L0–L5 native
  probes and the full default-composition path on the final implementation
  pin. [Version-sensitive, 0.157.0+] Conditional interruption is a **review
  trigger**, not evidence that kaoiro's hard-interrupt RPC became conditional:
  issue #462's 0.159.2 source check found `turn_interrupt_inner` submits
  `Op::Interrupt`; `Op::InterruptIfNoPendingInput` is a distinct operation.
  Its reconstructed offline probes passed on both binaries, including an
  accepted/unobserved steer followed by hard interrupt. Issue #462's
  [paired live evaluation](../evidence/codex-app-server/pin-0.159.2-evaluation-2026-10-01.md#authenticated-comparison-and-stage-3-denial)
  reports both pins passing its L1/L2/resume/L3/L3b and P2 samples with
  negative controls and recommends adopting the new pin later. That
  evaluation is under independent review and does not prove the new IA path
  or decide pin adoption. [Version-sensitive,
  0.159.0+] Issue #462 found
  `instant_interrupt` and `defer_mailbox_preemption` false by default in its
  candidate source; verify the final effective configuration. The
  [issue #462](https://github.com/sakuraiyuta/kaoiro/issues/462) evaluation
  is not yet a pin change on this baseline. Its result is an input gate, not
  evidence to assume ahead of time.

## Dependency and end-state route

The phase-1 protocol and server pieces from [issues #430](https://github.com/sakuraiyuta/kaoiro/issues/430)
and [#431](https://github.com/sakuraiyuta/kaoiro/issues/431), plus shared
wrapper issue #432, are present on this baseline. Phase 3 uses their intent,
echo, sequence, stage and reply-basis contracts; the server-first uncertain
resolution, steer handoff enum, attributed-notice validator and negotiated
sender capability are new prerequisites. The Claude phase-2
implementation from [#434](https://github.com/sakuraiyuta/kaoiro/issues/434)
is a design precedent for priority lease and ticket recovery, not a runtime
dependency; Codex must pass its own native evidence and default composition.
Dashboard work-record views in [#435](https://github.com/sakuraiyuta/kaoiro/issues/435)
do not block this wrapper phase. They will expose the already recorded stages.

The current join declaration is a frozen request and a boolean echo. A live
dashboard switch cannot truthfully change server intent stamping or directory
advertisement by changing only a local closure. For #463, split *supported
mechanism* from *effective per-agent policy*: the server and wrapper need a
revisioned, acknowledged live capability/policy update tied to the current
channel owner and generation. Apply an opt-out locally before its ack (so no
new steer escapes), then publish `early:none` to the server. Apply an opt-in
only after the server acknowledges the new effective mode; until then queue
and report the downgrade. Rejoin must restate the latest effective revision;
stale updates cannot re-enable a newer opt-out. The dashboard launch setting
seeds that state, and the live switch changes it without replacing the Codex
thread. An old server without this update keeps the phase-3 launch-time mode;
the UI must show live switching as unavailable, not pretend it succeeded.
The later protocol's linearization point is the server's durable compare-and-
swap of `(owner, generation, policy_revision, effective_mode)`, acknowledged
by the wrapper with the applied revision. A dashboard toggle becomes
confirmed only after that applied-revision receipt, not when its request is
sent. Opt-out first installs a local no-new-write fence, so an in-flight steer
whose synchronous commit preceded the fence remains owned by the old revision
and cannot be retracted; all later commits queue. Already server-stamped
`early` inputs still queued at the fence retain the original grant in their
audit record but are downgraded to root with a visible `local_policy_disabled`
reason. Opt-in keeps the local fence until the server revision is acknowledged
and the wrapper applies that same revision; only later commits steer. If an
ack is lost, the wrapper queries the authoritative revision and keeps the
safer local fence until reconciliation. A delayed opt-in ack with an older
revision cannot clear a newer opt-out fence. Rejoin binds the current owner
and generation before adopting the latest revision; an old owner cannot
publish or acknowledge a new policy. These races belong in #463's protocol
tests, not in a UI-only toggle.
This is the proposed alternative to treating the join-time `v1` echo as
mutable. It belongs to #463, with a separate protocol/server/runner/dashboard
review. The app-server to exec opt-out is a launch/resume backend choice, not
the live delivery toggle; exec always reports queue fallback.

There is also a semantic limit for #463: no measured Codex primitive yields
*after* the current tool without hard cancellation. The concrete alternative
is default-on early steer with `yield:none`; a director's `yield` request is
stamped as downgraded to `early`, and the dashboard shows that effective mode.
If #463 requires a true cut for Codex, its Codex default flip must wait for a
separate native boundary measurement and design. A silent claim that steer
implements yield would contradict ADR-0063 D2 and D9.

## Verification and documentation work for implementation

Use the production `runCodexCli` path with the pinned native binary, a local
model provider and local Phoenix peer. Hold a tool in the provider, send an
ordinary peer envelope with `early`, and record `turn/start`, `turn/steer`,
the accepted turn ID, the correlated user-message item, the next model
request, delivery stages, reply-ticket use and terminal. Repeat during model
generation. Confirm one native turn and no tool cancellation. Treat a missing
provider correlation as *unmeasured*, not proof of inclusion. Run the same
input with exec, opt-out and absent echo: each must queue and issue no steer.
Run these schedules with approvals `never`, `on-request` and `untrusted`, and
with a pending permission selection, live dialog, reset and watchdog.
Run the wrapper test suites with `env -u CODEX_HOME` because the inherited
runner environment may point at the production Codex home; give native
probes their own explicit scratch `CODEX_HOME`.

Deterministic tests cover item-before-response, terminal-before-response,
precondition rejection and placeholder order, rejected compact/review, wrong
turn ID, write timeout/disconnect, accepted-but-unobserved interrupt, same-CID
second generation, different peer, waiter-consumed reply, same-peer root
precedence, quota and fairness, stale delivery generation, late item after
terminal, foreign turn and close. For every new guard or stage wire, remove
only that guard/wire once and confirm its corresponding test fails, then
restore it. In particular: removing the steer `clientId` match must fail the
ticket test; cutting the server uncertain-resolution branch must fail the
ledger test; moving lease attachment to receipt must fail the same-CID test.
For uncertainty, test queued/unwritten and write-callback failure remain
unresolved, a `writing`/`written` no-response report resolves without loss,
old-owner/generation and malformed reason/handoff reports fail, a legacy root
`unknown` does not take the new path, exact duplicates do not recount,
generation/incarnation replacement preserves the ledger-lifetime uncertainty
summary, server restart loads both old-format and new-format persisted entries,
ledger deletion resets the summary, and stage-history expiry returns
`expired` while the aggregate persists.
As the wrapper is the only observer of the write, also mutate the **wrapper
write-state guard** to accept `unwritten`; the production-composition negative
test must then fail by detecting an `unknown` report or premature resolution
for a request that never crossed the write boundary. Restore the guard and
repeat the positive path. A server-only invalid-report test cannot establish
that property.

For same-CID settlement, test A observed/B unobserved with and without an
accepted reply to A; A and B observed with a reply covering only A; B item
before terminal with a valid response or timeout after terminal; and a later
same-CID root. Assert the exact notice classes and affected sequence lists,
one release per captured token, and no notice or ticket transferred to the
successor. Mutate the per-sequence reply-coverage check and the late-response
reconciliation callback separately; each must turn its respective test red.
Drive the actual server `InterAgentReplyBasis.valid_notice?` path before any
producer-only fixture: accept bounded sorted coverage, reject unknown keys,
empty/oversized/duplicate or malformed entries, and reject coverage on
`stale_delivery`. Test A observed/B unobserved with B's waiter active and
both arrival orders. A-only classified notice must leave B's waiter alive
and become an asynchronous A-attributed model message; B's timeout notice
must return from the waiter with B's original peer turn and wait/no-retry
guidance. Repeat for chunked coverage, the old-sender one-notice fallback,
and a new sender receiving an unscoped old-wrapper notice. Remove the
receiver's peer-turn coverage-match guard: this A-before-B test must fail
because A incorrectly consumes B's waiter. Test both waited `peer_error`
projection and asynchronous `formatInboundMessage` output; a producer
assertion alone cannot establish recipient behavior.

When changing the shared obligation API, retain the named baseline tests:
`wrapper/codex/test/inter_agent_lifecycle_glue.test.ts` cases for queued
same-peer batches, actual-turn acknowledgement, and the same-CID successor;
`wrapper/codex/test/inter_agent_turn_coordinator.test.ts` cases for exact
delivery sequence ownership and stale-token settlement;
`wrapper/agent-common/test/inter_agent.test.ts` cases for legacy root
`resolveTurnEnd`, accepted/rejected/unknown reply clearing and CID waiter
behavior; `wrapper/claude-code/test/inter_agent_turn_coordinator.test.ts`
cases for root/fold ordering and same-CID obligation; and
`wrapper/antigravity/test/inter_agent_turn_coordinator.test.ts` cases for
queued proposal recheck and stale-token isolation. These are compatibility
controls, not evidence that Claude or Antigravity gains Codex steering.
The no-injection default composition must reach a real first IA handoff.
Report every gate's exit code and warnings and bind native evidence to the
final binary SHA and code commit. Repeat evidence after any pin or relevant
implementation change.

Update on implementation: [delivery](../reference/inter-agent/delivery.md),
[messages](../reference/inter-agent/messages.md) for the affected-sequence
notice field, [reply basis](../reference/inter-agent/reply-basis.md),
[send and wait](../reference/inter-agent/send-and-wait.md),
[channel capabilities](../reference/protocol/channels.md),
[Codex app-server](../reference/engines/codex-app-server.md),
[wrapper configuration](../reference/configuration/wrapper.md), and the
operator delivery-status display and version-bound evidence under
`docs/evidence/codex-app-server/`. Update
ADR-0058's Stage 2/IA status and issue #346 only when the code lands. #463
owns its own dashboard and backend-default documentation.

Out of scope: implementation in this design branch; hard cancellation or
automatic reset; Codex cooperative yield without a native boundary probe;
Claude and Antigravity implementation; changing work-grant authority or
revision checks; cross-work resource exclusion; making tickets proof of model
obedience; replacing the current backend default before #463's gate.
