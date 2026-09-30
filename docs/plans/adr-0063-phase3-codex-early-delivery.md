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
| Valid steer response for the captured turn | Report `submitted` with a new closed-vocabulary handoff `turn_steer_accepted`, then resolve that delivery sequence in the server ledger. Only here attach any new CID's failure obligation to the active host token. An existing same-token CID retains its original obligation. Record an accepted-but-unobserved input separately. |
| Matching completed `userMessage` item before terminal, with the client ID and exact submitted text digest | This also proves app-server intake if the RPC response was lost. Report `submitted` with the distinct handoff `turn_steer_item_observed` if not already submitted, and attach the obligation. It is not a captured model request, does not publish the turn's default basis, and does not alone report `included`. An `item/started` without full content is only a correlation hint. Duplicate items do nothing. |
| Tool call spending the input's one-use ticket | Report optional `included(evidence:ticket_used)` and credit only that input to completed reply history. This proves that the call saw the authorization carried with the input; it does not prove the model followed the message. |
| Authoritative terminal | Resolve all attached unresolved CIDs by exact host token before allowing a later same-CID root to own them. Report `settled(turn_end)` only for corroborated input. An accepted response with no matching item ends as `unknown(not_observed)`, never `settled`, even though it already reported `submitted`. On turn error, fan out one classified failure notice per corroborated unresolved CID; an uncertain input gets a `timeout`-class peer notice instructing the sender to wait, not retry. No duplicate notice follows a reply already sent. |
| Definite precondition rejection | Queue the original lease at its arrival position, report the rejection reason, and leave its delivery sequence unresolved until a later root handoff or intentional non-injection. |
| Lost response after a possibly delivered write, mismatched response, or contradictory item | Report `unknown` once, never queue or retry the same body, and retain the exact owner for operator recovery. Do not mark it `failed_before_handoff` or send an ordinary failure notice that invites retry. |

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

`prepareFoldInput` currently credits a fold only on ticket use, and the
root default snapshot never inherits an uncredited fold. Carry the same
bounded retained-body recovery rule to Codex steers: after a stale-basis
rejection, re-hand the steered body with `folded_earlier: true` and a fresh
ticket when it fits. Retire it on ticket use, a newer confirmed input from
the same peer/CID, or session ledger reset; count capacity evictions. A
same-CID second steer on the same active token supersedes the older unused
ticket only after its own handoff, never at queue receipt. Root successors
cannot borrow an earlier turn's ticket. `reply_authorization` remains absent
for server turn-zero status notices.

The current server resolves out-of-order `submitted` sequences but **does not
resolve `unknown`** (`DeliveryStates.report_stage` on this baseline). A
possibly-written steer that loses its response would otherwise remain an
unresolved sequence and could later be counted as a definite loss. Phase 3
therefore requires a server-first change: a validated `unknown` stage for a
possibly-delivered write closes delivery bookkeeping as *uncertain*, without
claiming dispatch, incrementing `lost_count`, or changing the stage to
`settled`; its history remains queryable. `acked_seq` already means a resolved
prefix rather than proof of dispatch. A negative control must show that a
never-written queued item cannot use this path. The server stage-kind update
for `turn_steer_accepted` also lands before the wrapper; rolling the server
back requires rolling the wrapper back.

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
  pin. [Version-sensitive, 0.157.0+] Conditional turn interruption may change
  whether a pending steer survives an interrupt. [Version-sensitive,
  0.159.0+] Issue #462 identifies `instant_interrupt` and mailbox preemption
  as opt-in upstream; verify the effective default and that kaoiro does not
  enable them. The
  [issue #462](https://github.com/sakuraiyuta/kaoiro/issues/462) evaluation
  is not yet a pin change on this baseline. Its result is an input gate, not
  evidence to assume ahead of time.

## Dependency and end-state route

The phase-1 protocol and server pieces from [issues #430](https://github.com/sakuraiyuta/kaoiro/issues/430)
and [#431](https://github.com/sakuraiyuta/kaoiro/issues/431), plus shared
wrapper issue #432, are present on this baseline. Phase 3 uses their intent,
echo, sequence, stage and reply-basis contracts; the server-first uncertain
resolution and steer handoff enum are new prerequisites. The Claude phase-2
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
The no-injection default composition must reach a real first IA handoff.
Report every gate's exit code and warnings and bind native evidence to the
final binary SHA and code commit. Repeat evidence after any pin or relevant
implementation change.

Update on implementation: [delivery](../reference/inter-agent/delivery.md),
[reply basis](../reference/inter-agent/reply-basis.md),
[send and wait](../reference/inter-agent/send-and-wait.md),
[channel capabilities](../reference/protocol/channels.md),
[Codex app-server](../reference/engines/codex-app-server.md),
[wrapper configuration](../reference/configuration/wrapper.md), and the
version-bound evidence under `docs/evidence/codex-app-server/`. Update
ADR-0058's Stage 2/IA status and issue #346 only when the code lands. #463
owns its own dashboard and backend-default documentation.

Out of scope: implementation in this design branch; hard cancellation or
automatic reset; Codex cooperative yield without a native boundary probe;
Claude and Antigravity implementation; changing work-grant authority or
revision checks; cross-work resource exclusion; making tickets proof of model
obedience; replacing the current backend default before #463's gate.
