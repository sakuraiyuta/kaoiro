---
title: Layered inter-agent delivery, authority and continuation admission
description: Separate early delivery, causal reply basis and mutation authority; two-level interruption with accepted-assignment grants; revision-checked consequential actions; native-lifecycle admission of engine continuations gated by a bounded pilot.
status: accepted
date: 2026-09-28
opened: 2026-09-28
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent]
related_adrs: [36, 58, 62]
---

# ADR-0063 — Layered inter-agent delivery, authority and continuation admission

## Context

Issue 407 bound every inter-agent send to a confirmed live input turn and
rejected calls without an origin (ADR-0062). Issue 422 then had to admit
`<task-notification>` continuations, and issue 426 spent six design
revisions trying to admit subagent hand-backs by proving the provenance of
each continuation shape. The operator reopened the question on 2026-09-28:
the 2026-09-26 rejection of "interrupt the receiver when a newer message
arrives" addressed the mechanism (hard interrupt), not the intent (put the
newer message in front of the model before it acts further). The open
question
[inter-agent-delivery-timing-and-turn-ownership](../open-questions/inter-agent-delivery-timing-and-turn-ownership.md)
frames the problem; Kogane's two review rounds
(`tmp/reviews/fundamental-review/kogane-r1.md`, SHA-256 `bff6b0b3…`;
`kogane-r2-positions.md`, SHA-256 `78785de1…`) supply the constraints
adopted below. The operator approved the decisions on 2026-09-28.

## Decision

D1. **Three outcomes are kept separate**: (a) earlier availability of
input, (b) a truthful causal basis for replies, (c) authority to revise or
cancel work and to apply consequential effects. No single mechanism is
claimed to deliver all three. Issue 407 incidents 5 and 6 belong to (c).

D2. **Two-level interruption.** Every authenticated sender may request
*early delivery*: the receiving wrapper puts the message before the model at
the earliest supported cooperative boundary (Claude fold at the next tool
boundary; Codex app-server `turn/steer` per ADR-0058; Antigravity
`PreInvocation` once measured), cancelling nothing. *Stopping work*
(cooperative yield after the current tool, or hard cancellation) may be
requested only by the operator or by the director holding an accepted
assignment grant for that work (D3). The sender declares intent, not
mechanism; the receiving wrapper chooses the mechanism by engine and policy.
An engine that supports neither queues the message. Unrestricted hard
cancellation by priority alone is rejected.

D3. **Assignment grants.** Authority over work is a server-owned record
`(work_cid, director, assignee, resource scope, authority epoch, state)`
created when the assignee accepts an assignment request. The operator may
override or transfer it; transfer or revocation increments the epoch.
Opening a conversation confers no authority; consultation threads grant
nothing. The existing `owner` placeholder is not this record.

D4. **Work revision.** The revision unit is one canonical work conversation
(`work_cid`). Only the director of that work or the operator advances the
revision, through a typed control (for example `work_control` with
`expected_revision` and an `operation_id`) that the server applies with
compare-and-set and deduplication. The first guarantee covers one canonical
work conversation; cross-conversation resource conflicts (issue 407
incident 6) are recorded as not mechanically solved. Revision state is
separate from the reply basis of ADR-0062.

D5. **Consequential actions** (accepting or revoking a verdict, releasing a
hold, declaring work complete, starting implementation or transferring
writer authority, merge, push, deploy, landing) carry the expected work
revision and the subject artifact hash and are checked at the point where
the effect is applied, through controlled entry points. Arbitrary shell
effects outside those entry points are outside the guarantee; enforcement
there is cooperative. Progress reports and questions carry a causal basis
only and never advance a revision. An accepted revision check cannot undo
an effect that already committed.

D6. **Native continuations.** Admission of engine-internal continuations
(task notifications, subagent hand-backs, child `SendMessage`) moves from
body-grammar provenance to native lifecycle evidence (trusted host hooks,
session and generation, native call and result identity), conditional on
the pilot in D8. The completed-input ledger, immutable call bindings,
root/child isolation, retirement, and the same-ID fold principle are kept.
The opener-owned terminal rule is kept until a stronger native terminal key
is established. Per-task occurrence tracking and the candidate idle clock
cease to be send-admission authority once their replacement is proven and
remain for UI and diagnostics.

D7. **Reply basis.** ADR-0062 stays. The basis of a call is fixed by the
model request that generated it; it advances only for calls generated by a
request proven to include the newer input. If that correlation is not
observable in production, fixed snapshots and explicit ticket recovery
remain the rule.

D8. **Pilot I3 is authorized.** Owner: Kogane. Claude only, installed SDK
and CLI pinned by hash, loopback model endpoint, no real API, no shared
production server, at most 12 root SDK run attempts and 60 minutes in
total, schedule R0–R8 as written in `kogane-r2-positions.md`, one
documented scratch-only instrumentation delta at the host input seam
(hashed, never landed). Output: *available / unavailable / unmeasured*,
separately for call epochs and for terminal ownership. A successful pilot
does not by itself authorize removing issue 426 guards, hard preemption, or
a multi-engine rollout.

D9. **Unchanged and frozen.** ADR-0036 F6 (no automatic interrupt combined
with reset) is unchanged. Issue 426 stays frozen and its lifecycle guards
are not removed before the pilot establishes their replacement. Issue 412
is absorbed by this decision.

## Phasing

0. Pilot I3 (D8) and its evidence report.
1. Protocol design: intent field, capability declaration at channel join,
   staged delivery records (accepted, queued, submitted, included, unknown,
   settled), assignment grant, `work_control`.
2. Claude wrapper: early delivery through the native seam, grant-checked
   stop requests, native continuation admission per the pilot result.
3. Codex: app-server backend evaluation under ADR-0058 with exec kept as a
   configured fallback; permission and lifecycle contract review.
4. Antigravity: `PreInvocation` measurement; honest queue fallback until
   then.

Each phase lands through the normal design and implementation review flow.

## Alternatives and consequences

Continuing the issue 426 provenance path was rejected: the predicted
test-case matrix fails the four-Agent, supersede, downgrade-notice,
operator-input and child-SendMessage cases, and each CLI update can
invalidate a grammar. Unconditional hard cancellation on receipt was
rejected again: it cancels useful work on ordinary informs, cannot undo
committed effects, and differs across engines. Treating the conversation
opener as director was rejected: a worker opening a clarification thread
must not gain control over its director. Binding the basis to "the latest
observed hook" was rejected: a call authored before the newer input arrived
would falsely claim it.

Consequences: the protocol gains typed intent, capability, staged delivery
and control fields; the server gains grant and revision state with atomic
checks; wrappers gain per-engine scheduling policy and downgrade
reporting. Fairness (bounded queues, duplicate suppression, no automatic
preemption from synthetic notices) is a design requirement of phase 1.
Engine differences remain and are made visible to senders rather than
hidden.

## Amendment (2026-09-28, issue #429 design)

Approved by the operator on 2026-09-28 after the issue #429 design review
(Kogane, four rounds, must 0 at round 4). Source:
[issue-429-delivery-authority-protocol](../plans/issue-429-delivery-authority-protocol.md),
"Premise corrections adopted before design" and Appendix A.

- **D2.** In phase 1 the director holding an accepted assignment grant may
  request cooperative yield after the current tool; hard cancellation
  remains operator-only. Director hard cancellation may be added later
  together with an epoch-bound cancellation target. Operator instructions
  default to early, non-destructive delivery; stopping requires an explicit
  control.
- **D3.** The grant is part of a server-owned work record identified by a
  server-issued `work_id`. The conversation that carried the assignment is
  the record's origin attribute, not its identity.
- **D4.** The revision unit is one work (`work_id`), which may span several
  conversations in sequence or in parallel. Conversations reference the
  work. The first guarantee covers one work across all of its linked
  conversations. Conflicts between different works over one resource
  (issue 407 incident 6, resource part) are recorded as not mechanically
  solved; the server warns on declared-scope overlap.
- **D5.** In phase 1 the server atomically enforces the actions whose
  effect is server state (verdict acceptance and revocation, hold release,
  completion, transfer). Starting implementation, merge, push, deploy and
  landing are checked cooperatively through a wrapper tool immediately
  before the operation; conditional updates on the Git host are later work.

Reason: a conversation has a finite configured turn limit, holds at most two
agents, is reclaimed 24 hours after it started and lives only in server memory,
so one piece of work necessarily spans several conversations.

## Amendment (2026-10-01, default-on in-flight delivery)

Operator decision on 2026-10-01. Tracking:
[issue #463](https://github.com/sakuraiyuta/kaoiro/issues/463).

- **End state.** In-flight delivery is on by default for every engine
  (Claude Code, Codex, Antigravity), and an operator can opt out per agent.
  This covers operator early input (Claude fold, Codex `turn/steer`) and
  inter-agent early and yield delivery. The host-wide environment opt-ins
  (`KAOIRO_CLAUDE_PHASE2_DELIVERY`, `KAOIRO_CODEX_OPERATOR_STEER` and their
  `_PERSONAS` lists) are rollout controls, not the end state.
- **Operator control.** The dashboard exposes the setting per agent, both
  at launch and during a live session.
- **Feasibility.** Where an engine, backend or the join-time capability
  negotiation cannot meet this, the implementer presents an alternative in
  the design before implementing instead of narrowing the scope silently.
- **Codex backend.** The default Codex backend becomes app-server just
  before this work merges into `develop`; explicit exec remains available,
  with no in-flight input. Existing hosts use the
  [guarded fresh transition](../operations/codex-backend-switch.md#fresh-backend-migration)
  before changing backends; old IDs are not cross-backend resume targets (ADR-0058).
- **Unchanged.** The phasing order, the canary before the Claude default
  flip (issue #441), D2 (hard cancellation stays operator-only) and D9. Each
  default flip lands through the normal design and review flow with
  evidence.

## Amendment (2026-10-09, operator decision E3)

Operator decision E3 (2026-10-08,
[issue #463 comment](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-6063194859))
records that the production enablement of 2026-10-03 was intended: the Claude
phase-2 flag, the Codex operator-steer flag and `backend: app-server` have been on
for all peers since then.

- **Stages 4a to 4c.** They retire the existing opt-ins in favor of the
  `in_flight_delivery` default instead of flipping them for the first time.
- **Claude canary.** E3 dropped the stage 4c flip criteria, which include the
  canary named in the "Unchanged" item of the 2026-10-01 Amendment (issue #441).
  That canary is therefore not a gate for stage 4c. The rest of the item (the
  phasing order, D2, D9, and review with evidence for each default flip) is
  unchanged.
- **Antigravity.** Phase 4 is not waived. It is tracked at
  [issue #567](https://github.com/sakuraiyuta/kaoiro/issues/567), which waits for
  issue #541 and is coordinated with issues #416 and #412.

## Amendment (2026-10-16, launch-bound native continuations)

The operator selected the wrapper-issued capability design for [issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426), including [issue #674](https://github.com/sakuraiyuta/kaoiro/issues/674). The director approved the design after eight independent design review rounds (six must-fix findings in total, none remaining). This amendment records the accepted decision; final implementation acceptance and independent implementation review are pending. Landing remains default off, and production enablement requires a separate operator decision.

### D6 supplement: launch proof and native occurrence

Under the operator's O1=A decision, opted-in Claude Queries use
one native-continuation reducer with disjoint proof variants. Agent reports
and Monitor event inputs need a wrapper-issued accepted-launch capability
plus proof of the actual native root opener/occurrence. Accumulated prompt text
does not grant authority. This replaces the prior all-native task-execution
requirement for those sources; .293/.301 native J2 findings remain unchanged.

Run-aware Bash/Workflow and the accepted Monitor completion variant enter the
same reducer through strict native completion evidence. A failed token event
cannot fall back to Bash. Source classification survives missing instrumentation
and capacity refusal. Combined completion and last event are one receipt.
Monitor.description supplies the launch marker to the measured event, normal
completion and natural-expiry summaries. Natural expiry uses the same capability
and native opener proof as events, without a separate expiry constructor or
an expiry-specific send-less policy. The former D8 expiry limitation can be
withdrawn; unproved individual inputs still fail closed and unmeasured variants
are not declared covered. Fully proved eligible instrumented Monitor completion
is accepted with or without a marker/final event; frozen launch basis, B opener
and final validator remain mandatory. It is not an expiry substitute or Bash
fallback. Explicitly canceled or claim-retired runs cannot create new claims;
already proved leases continue until their root's terminal or host authority invalidation.

Agent peer hand-back retains its canonical marker and native peer proof.
Peer hand-back binds the current hook's entire single `agent-message` frame
to the native descendant root row: the fixed CLI 2.1.293 preamble, that exact
frame, then the fixed descendant warning. Sender attribute escaping matches
the native formatter; only the outer opening and closing frame tags may occur
at column zero. Plain peer rows, missing or changed warnings, mid-turn wrappers,
extra frames and surrounding data refuse. No report sanitizer is duplicated;
`origin.body` remains the canonical-marker proof field. Task notifications
continue to require byte-equal hook/row bodies and never accept this wrapper.

Agent native completion uses the same accepted launch capability, selected by
that completion's native call/task/run tuple and the B opener's matching
origin.runId with producer=session-task. This includes unset/default permission
mode; permission mode does not supply authority. Compare the frame report to
the once-escaped result scalar, not outer summary. A known output_file remains
required, but notice omission is allowed. Every result marker is ignored for
authority, refusal and quarantine, including missing, wrong, stale, duplicated
and another launch's marker. Native note/usage, fixed relayed-Artifact warning
and worktree metadata have strict source-specific grammar; they supply no
permission or reply basis.

### D7 supplement: issuance-bounded snapshots and lifecycle

A root accepted launch exports immutable confirmed default-basis data without
source AbortSignal or recovery tickets. Its proved standalone report imports
that map into a new owner lease. Folds keep their existing owner/default map.
Later confirmed input and persistence do not advance a d4 snapshot. Existing
Bash/Workflow opener-completed policy remains explicit and unchanged; this
work does not assert all sources use issuance-time basis. Long-running Monitor
default replies can be stale after newer requester input and are not refreshed
automatically to force acceptance.

Agent peer and completion share one report slot per accepted capability/call/
task/run, including atomic commit and fold reservation. The first proved route
spends it; another route or distinct delivery cannot obtain another owner.
Reobservation preserves the same decision. A fold keeps its existing owner;
unresolved tuple-bound completion quarantines only that launch and never a
marker quoted in result. Producer completion does not settle the report root.
Only its matching native result settles the owner once. Monitor capabilities can serve
multiple occurrences from the same launch. Source-root completion retains the
detached capability. Normal producer completion drains queued eligible reports
within the accepted idle grace. Consumed/drained records cannot create another
origin, while proved owner leases continue to their native terminal.
Attributed explicit TaskStop/cancellation closes new claims immediately without
invalidating those leases, including the root that stops its own Monitor and then reports. Host
session/generation end, reset/fail-stop and root lifecycle still invalidate
leases. Any native task frame establishing a newer run closes the old Agent
claims, even without task_started/new-token support; unknown order fails closed.
Opaque run IDs are never compared lexically. New-run preparation is not deleted by that retirement.

SendMessage instruments only a positively inactive/resumable target, updates
canonical message and preserves the historical content preview. Running/waking/
unknown targets receive unchanged input. Authority never derives from content.
A fresh token arms only after actual resumption success and its accepted new
background task/run/call/effective-message join. Queued success without
resumedAgentId discards preparation and does not retire the old capability;
broker acceptance/PostToolUse alone is not a new execution. Old instructions do not replace registry retirement.
Peer old-only and old+new markers fail closed; completion result markers do
not affect native-lineage admission. Unresolved folds use denial-only
reservation/quarantine; no positive grant is inferred before inclusion proof.
Reliable explicit-stop evidence closes the attributed run's new claims,
including before TaskStop success, but does not revoke a proved lease. Raw
Monitor status stopped can also mean natural WS close and then uses normal
drain; do not classify cancellation from that string alone. Native delivery
can continue after either terminal; an explicit-stop token cannot be revived
or reset by a late event, while natural close retains its queued reports. The reporting root's authority rests on its earlier proof,
not on whether its producer remains running. Explicit stop sources include root/child TaskStop,
named SDK stopTask calls and exact native explicit-cancellation witnesses. Query
interrupt/watchdog/SIGINT alone neither closes nor suspends background claims;
only precise ends for captured task/run pairs in its bounded observation window
are attributed. Surviving producers retain their capability. Named stopTask
closes only its target before dispatch. Existing interrupt cancellation of the
current host root and its buffered-result barrier remain unchanged. Unknown/unobservable termination
without explicit-stop evidence uses normal drain, so a late queued report can
still be admitted within grace; conflicts stay suspended. The old SDK 0.3.220
control observation does not establish current-pin delivery order or background
termination. P4 tests surviving reports as well as exact-task end attribution,
including ACK+1,000 ms / call+5,000 ms window boundaries. Natural WS
stopped frames arriving in that window can be temporally attributed;
this ambiguity never closes another task's claims. No raw killed/stopped status or ACK replaces the intent record. SDK generation/
session end clears records and dependent authority. Native session history
cannot reconstruct a capability.

### D9 supplement: boundary, concerns and rollout

Same-host/same-OS-user agents are trusted. Intentional coherent same-UID
tampering is outside protection; live accident detection remains mandatory.
The token is a model/native-description-visible bearer, not content authentication, human
approval or work authority. Copy/replay is not universally prevented, especially
identical Monitor payloads under a shared launch marker. The defensible
property bounds default authority by the issued snapshot. Real models may
omit/mistype a marker or return both old and new; those peer hand-backs gain no
right. Native Agent completion has no marker-compliance gate; it still requires
accepted instrumentation and exact native lineage, and cannot authenticate
report content or work permission.

Validate reader identity/committed evidence before grant and actual dispatch;
definite damage invalidates the epoch and uses visible fail-stop. Compaction
is allowed only while the attribution anchor stays valid. There is no atomic
filesystem/network guarantee. No arbitrary active Monitor TTL is added;
completion loss can retain a bounded record until process end. Busy-paused
draining can fill capacity; refusal is visible and does not erase source kind.

The command-wrapper strategy is rejected: E4 changed native deny into a broker
ask that could be approved and executed. No custom permission parser/broker
override repairs that strategy. The selected candidate carries the marker in Monitor.description, preserving
command/stdout and adding no helper process. E6 establishes measured transport
and one deny; metadata changes in notices/model context/display are intentional.
SendMessage content can show the original preview while effective message has
the instruction; that preview is not an authority surface. A registry/native
race can queue an already injected T2 instruction into run1: T2 never arms,
but compliant output can lose liveness. Conversely an uninstrumented message
can start run2 after run1 completes; old T1 is refused. Do not claim either
race is transparent or repair it with guessed authority. Monitor envelopes accept 1–16 strict top-level blocks, each independently
proved before atomic root admission/consumption; every Monitor summary precedes
its event. The pinned Wt escape of &, < and > keeps block-looking payload inert
and must be pinned by native acceptance/mutation. Raw nested/unproved sibling blocks
refuse the whole prompt. Mixed-source snapshots must agree; no basis union.
This is an accepted legacy regression: after a newer confirmed input, a Monitor
completion retaining its launch map and a Bash/Workflow completion using the
opener map can make the whole batch refuse. Two Monitor completions launched
under different maps can likewise refuse. Legacy treated all those completions
with the common opener-time map and could admit them. The director accepted this bounded regression under the approved design. P6 requires visible
batch-basis-conflict refusal without partial consumption; do not claim full
legacy compatibility or introduce multiple owners to hide the difference.
A second limit is not a basis conflict: a prompt carries one `origin.runId`, and
every Agent completion block must match it. Agent completions with different
run IDs in one prompt therefore refuse the whole batch even when their maps
agree, and nothing is partially consumed; legacy admitted them when every
candidate matched. Native may never batch Agent completions this way, which is
unmeasured. Relaxing the match needs a pin showing one row with several Agent
completions and an origin that names only one of them, as a separate design
change. Historical
Monitor suffixes are preserved; repeated re-arm can reach a length bound and
refuse instrumentation visibly, rather than silently strip/truncate text. E9 establishes applicable auto-mode explicit ask/deny/allow and independent
reject controls, with a bounded whole-Agent exclusion disposition rather than
a claimed live deny comparison. Other hooks can see only original input;
actual accepted-input checking remains the issuer's responsibility. Do not enable hidden Monitor features or claim
untested variants covered. A failed variant returns to a concrete design/scope
choice instead of silently falling back to Bash or tokenless admission.

The 2026-10-16 unfreeze permits design on develop independently of frozen [issue #214](https://github.com/sakuraiyuta/kaoiro/issues/214). It does not remove foreign occupancy or authorize production enablement.
Mode selection is startup-only, exclusive, default off; one class landing
follows complete acceptance and independent review. Agent acceptance includes
unset/default native completion and auto peer hand-back, compared with legacy
default behavior; an auto-only fixture cannot establish whole-class coverage.
Optional worktree/Artifact grammar is pin-inspected and tested structurally,
not claimed as separately live-measured. E9 permission/variant
dispositions are bounded to the inspected pin/configuration and constructed
native surfaces, and require independent design approval. Real-model classifier
invariance, arbitrary new content-sensitive hooks and every WS lifecycle
schedule are not claimed. A changed configuration requires new applicable
premise checks; final product acceptance/landing have their own later gates. Existing reserved reset behavior and ADR-0036 F6 remain unchanged.

Monitor acceptance is conditional on exposing Monitor in an isolated test
cache. The cache belongs only to the test's isolated home; no operator setting,
peer cache, production configuration or additional unpublished variant is
changed. Production Monitor distribution and availability remain unmeasured.

TaskStop outcomes are classified only as a thrown error (`PostToolUseFailure`
with `is_interrupt` false), which removes that call's pending suspension, and as
the `Successfully stopped task:` result for the exact target, which closes the
claims. The wording of any other `PostToolUse` result for the target was not
measured, so none is treated as a failed stop: the suspension stays and no new
claim for that task is offered. This fails closed and is a known limit, not an
oversight; a later pin that lists the non-stop results can add them. A natural
`completed` or `failed` terminal that arrives under a pending stop is not an
explicit stop, and drains once every pending stop has failed.

## Amendment (2026-10-17, native continuations on by default)

The operator decided that unified native continuation ownership is the
default for [issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426):
it is the base on which peers coordinate while each uses its own engine's
features. Off is a fallback for when native ownership must be withdrawn, not
the normal mode. This supersedes "default off" in the 2026-10-16 amendment and
its D9 supplement; the rest of those records stands.

- `KAOIRO_CLAUDE_NATIVE_CONTINUATIONS` keeps its name. Unset selects native,
  `0` selects legacy, and `1` selects native (the earlier opt-in value). Any
  other value selects native and writes one warning at startup, so a mistyped
  value never silently withdraws the mode. Selection stays startup-only and
  exclusive; there is no live switch or runner configuration field.
- The default does not expose native Monitor tools or change tool permission.
- Known limits are unchanged by the default. When a peer messages a running
  subagent and the child reports and ends at once, the first report cannot be
  answered; legacy behaves the same, so this is not a regression, and it must
  not be described as newly supported. Intentional same-UID tampering remains
  outside protection.
- The third native acceptance tranche is judged by people, not by the
  fixture's checker. Two readers of different model families, neither of them
  the implementer, independently compare the raw records (CLI events and
  transcripts, loopback requests, server acknowledgements and stderr) with an
  expectation table copied from the acceptance design. The fixture is a
  recorder; checker output is reference only and is not given to the readers.
  A scenario the readers find ambiguous is recorded here as unmeasured and
  does not block landing. Native runs with the variable unset and with `0` are
  part of this acceptance; every earlier native run set `1`.
- With native on by default, an evidence failure must not end ordinary work.
  The host fail-stops only while a native turn holds a lease, judged at the
  moment the failure is detected; that span lasts as long as the native turn.
  Any other failure, including one while an unowned root is still being
  proved, closes native continuations for the rest of the wrapper lifetime:
  the epoch is invalidated, the failed call is refused for good, and ordinary
  input continues. Completion reports, including Bash and Workflow, cannot
  send until the wrapper is relaunched, and the host says so in its warning
  and the operator log. Restoring native coordination in place, by a new
  epoch at a quiet boundary, is a separate design and not part of this
  change.
- Production rollout remains a separate operator gate. Once develop carries
  this default, the next runner update changes the behavior of production
  Claude peers, so the rollout follows the
  [high-risk change procedure](../operations/high-risk-change-release.md).

## Amendment (2026-10-17, third native acceptance result)

The third native acceptance tranche ran on candidate commit 1810be55 with
the method recorded above. Each run started a fresh test server, so no
conversation or delivery state crossed runs, and no run stopped on ambiguous
result ownership. Two readers of different model families judged the 41 runs
independently from the raw records and agreed on every run: 26 pass, 15
unmeasured, 0 fail. The director spot-checked the degrade, the lease-held stop
and a Monitor admission in the records. Unmeasured runs are not counted as
passes, and 0 fail does not mean every expectation was measured natively.

- Unmeasured:
  - Survival after an Agent interrupt (T3-3b, 3 runs). Each interrupt stopped
    the Agent task and cancelled the child's pending request, so no surviving
    child handed back a report.
  - Batched completions at the product entry (T3-4 to T3-6, 9 runs, including
    the legacy control). Completions reached the product's prompt hook one per
    prompt. In one run the CLI put two notifications in one model request, yet
    the product still received them as two prompts, so batch attribution and
    the batch-basis-conflict refusal were not exercised.
  - Monitor deny (T3-10, 2 runs). With Monitor denied, the CLI did not offer
    the tool to the model, so no call reached the permission-denied path.
  - One Monitor interrupt run (T3-3) in which the Monitor expired before the
    test released its output. The other runs of that scenario passed, two with
    `1`, three with the variable unset and the legacy control.
- Reading rules:
  - The automatic notice the host sends after an interrupt
    (`peer error (interrupted)`) is not a product send. Counts cover only sends
    from the event root under test; the notice adds one attempt, acceptance and
    receipt to the raw counts and cannot turn an unmeasured run into a pass.
  - A legacy control (`0`) passes on the difference it shows, not on native
    success. The ordinary event-root send is refused with `unbound_tool_call`.
    The ask control is denied by the test because its broker input carries no
    native marker, so it does not show that the product refuses a permitted
    Monitor event. The dispatch-tamper control damages the transcript only at a
    later completion, so it does not compare the same dispatch span.
- The lease boundary changed the expectation for tampering before a lease is
  held (T3-8): the run closes native continuations with `acquisition_failed`,
  refuses that call for good and ends the notification turn normally, instead
  of fail-stopping the host. Both runs matched. Tampering while a lease is held
  (T3-7) still fail-stops, and both native runs did. These runs add no ordinary
  input after the degrade; that is covered by a separate real-SDK probe, where
  an unreadable transcript with the variable unset gave one warning, no
  fail-stop and a normal turn.
- The second tranche measured the running-subagent limit above (T2-3). When a
  peer's SendMessage reaches the child only after run1 completes, it starts
  run2, which retires run1's capability; a reply from run1's report is then
  refused before sending (`unbound_tool_call`). This is the designed refusal,
  not a misdelivery. When the child's round has not ended (T2-3c), the message
  reaches the child within run1 and the reply is admitted. The refusal is not
  an evidence failure, so it does not close native continuations; that was read
  from the code of this build, not re-run on it.

## Amendment (2026-10-10, measured engine delivery semantics)

Operator decision 1 of 2026-10-10, recorded in
[issue #585](https://github.com/sakuraiyuta/kaoiro/issues/585): the proposal
to make engine delivery semantics a measured contract was adopted as
proposed.

- **Capability matrix.** The capability matrix per engine is a measured
  artifact under `docs/evidence/`. It is re-measured with a fixed set of
  loopback probes on every SDK bump.
- **SDK bumps.** An SDK bump is a release-class change and is gated by that
  probe set.
- **Unsupported semantics.** A semantic an engine does not guarantee is not
  emulated in the wrapper. The delivery policy declares it unsupported, and
  the server downgrades it.
- **Default-on in-flight delivery
  ([issue #463](https://github.com/sakuraiyuta/kaoiro/issues/463)).** Claude
  and Codex stay default-on. Antigravity
  ([issue #567](https://github.com/sakuraiyuta/kaoiro/issues/567)) is
  default-on only for what the probes guarantee. This narrows the end state
  of the 2026-10-01 Amendment for Antigravity.
