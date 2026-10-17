---
title: Launch-bound Claude native continuations
status: implementation-in-progress
last_updated: 2026-10-17
baseline: 6ea69f479c6e3033932c24468e5cdfbb2b1e38dc
---

# Launch-bound Claude native continuations

Accepted design for [issue #426](https://github.com/sakuraiyuta/kaoiro/issues/426),
including [issue #674](https://github.com/sakuraiyuta/kaoiro/issues/674).
The director [approved the design](https://github.com/sakuraiyuta/kaoiro/issues/426#issuecomment-6206887089)
with the Agent completion addendum reviewed in round seven. The approved source document has SHA-256
`10715ff3ccdb9108ce4c62c0fe5d01daf5a00609f81e4a3e0b17e96ca4edae7d`.
This public rendering retains the normative contract and acceptance obligations;
private evidence locations and review correspondence are omitted.

Implementation acceptance, independent implementation review and the exact-candidate
landing gate are pending. The operator made the mode the default on 2026-10-17;
`KAOIRO_CLAUDE_NATIVE_CONTINUATIONS=0` selects legacy. Production rollout is a
separate operator gate. No SDK upgrade, server authorization change,
dashboard feature or frozen [issue #214](https://github.com/sakuraiyuta/kaoiro/issues/214) integration is part of this unit.

The operator accepted same-host/same-OS-user trust (O1=A), including the bearer-copy,
model-compliance and mixed-basis-batch limitations recorded in
[ADR-0063](../adr/0063-layered-delivery-authority-and-continuations.md).
The [prerequisite evidence](../evidence/issue-426/stage2-prerequisites.md) is bounded
preimplementation evidence, not final product acceptance.

## Selected mechanism and exact protection

Use a wrapper-issued launch capability **AND** a B transcript opener/occurrence
proof **AND** a live root owner. The capability selects the accepted launch by an eligible peer-report marker or
Agent completion native call/task/run tuple and retains its frozen default reply basis. B joins it to this root's
actual opener or a fold. No whole-prompt token search, latest-task lookup,
arrival-order heuristic, transcript-only grant or fallback after a failed
token proof is permitted.

This replaces the former all-native J2 requirement for token report sources
under O1=A. It does not discover a native run key. P0 and .301 findings remain
true. Native run-aware completions retain their separate existing proof
constructor, feeding the same owner reducer and final validation gate.

| Situation | Protected property | Limit |
| --- | --- | --- |
| Invented/mistyped token | No live entry, no report-derived origin | Entropy is not producer authentication |
| Two launches return in reverse order | Exact capability, source and task consistency select the issued snapshot | Deliberately copied valid bearers are not cryptographically authenticated |
| Task resumes; old token was unspent | Confirmed new run retires previous-run records and unresolved claims | Strict delayed-old-delivery scheduling remains product acceptance |
| Marker occurs only in later fold | Existing owner stays fixed; foreign root is not promoted | Model context still contains the folded content |
| Agent peer hand-back omits/duplicates marker | No new report-derived right | No universal model-compliance promise |
| Active Monitor repeats identical content | Same delivery is idempotent; each fresh root uses the same launch basis | Shared launch token cannot universally distinguish replay from a genuine identical event |
| Explicitly canceled or claim-retired token | No new claims; late input cannot revive the capability | Already proved leases keep their original rights until their root terminal |
| Host authority canceled or SDK restart | Host lease epoch invalidated; dependent sends fail | Host/session/reset/fail-stop cancellation is distinct from stopping a producer |
| Transcript truncate/replace/restore or changed committed bytes | Detect at grant/dispatch checks and invalidate affected authority | No atomic file/network transaction or detection of every transient change |
| Content lies, prompt injection, human/work permission | Existing tool/server/work policy remains | Marker does not authenticate content or approve work |
| Intentional coherent same-UID manipulation | Outside O1=A | Registry memory/code and visible tokens are not protected from their OS user |

The bounded claim is: a d4-derived default basis equals its issued launch
snapshot and cannot advance to later confirmed input. It is not universal
replay prevention or a claim that tampering cannot create another opportunity
to use a live bearer. Explicit recovery tickets retain their separate checks;
the launch capability cannot create or copy one.

## Root ownership and reply-basis policy

For d4 sources, copy the launching owner's immutable confirmed default map.
Do not read the completed/delivered ledger at return time, union maps from
different launches, borrow folded-input tickets, or inherit the source turn's
AbortSignal. Add narrow internal detached export/import support to ReplyBasis;
do not reuse a retired root token as a live ReplyOrigin. Normal source-root
completion cannot kill the background capability.

An independently opened return root gets one fresh owner/lease with that exact
map. A fold into wrapper or admitted native root grants no new default right
and never replaces its owner. A marker in a later fold of a foreign/unmarked
opener cannot become that root's opener. A fresh unexplained root ID overlapping
another owner remains ambiguity and uses the existing fail-closed barrier.

Native Bash/Workflow completions keep their existing opener-time completed-map
policy, frozen at the first verified opener boundary before waiting. This
asymmetry is intentional: d4 bearers are bounded to issuance, while this work
preserves already-landed run-aware completion behavior. The bounded-launch
claim applies to d4, not retroactively to every source. General unification of
basis policy is not slipped into this fix.

Long-running Monitor roots may therefore attempt a stale default reply after
a requester sends newer confirmed input. The server can reject it. Document
that visible limitation and test the actual outgoing in_reply_to. Do not
silently refresh the map, fabricate a recovery ticket or open a new conversation
to force success. The director determines whether acceptance of this behavior
needs a further operator decision in the existing scope gate.

## Launch registry and source classification

Maintain separate structures; source observation is not capability issuance:

- A launch capability stores random token, generation/session, root prompt and
  call ID, source kind and Monitor command/ws subtype, original/effective input digests, detached basis,
  accepted task/run/call witness, lifecycle state and occurrence claim state.
- A lightweight source index stores observed tool-call kind and its native
  task/run relation even when no token was issued: capacity overflow, child
  launch, unsupported form or failed instrumentation. Retain classification
  independently of the 64-record capability bound; deletion cannot turn a
  Monitor into an ordinary Bash. Keep bounded generation-scoped history and
  reject unknown classification instead of evicting it into a permissive path.

Initial capability capacity remains 64 prepared/armed/draining records. Never
evict a valid record to issue another. On overflow the original tool may still
run, with no marker and no new report capability, but source classification
remains recorded. Emit an operator-visible diagnostic through existing warning
surfaces: capacity reached and return instrumentation suspended, without raw
tokens. Continuous busy periods can pause the draining clock and reach this
bound; this is visible degradation, not authority to use a newer snapshot.

In unified mode, a known uninstrumented Agent/Monitor cannot fall through to
ordinary Bash/Workflow completion. Unknown local_bash classification grants
no native completion origin. A child callback may supply classification or claim-closure evidence but
cannot issue a root capability. Positive ordinary Bash
cases must include the real source evidence required by this rule.

## Issue, accepted launch and reactivation

1. Validate root PreToolUse: exact live session/prompt/owner, confirmed source
   input, no agent_id, unique native tool-call ID, no taint/ambiguity/fail-stop.
   Root eligibility covers Agent, public command/ws Monitor and measured
   SendMessage reactivation. Generic assistant tool-use observation alone is not issuance.
2. Validate the pin's recognized canonical schema. SendMessage requires string
   to/message and a known local Agent of this generation, not an arbitrary
   teammate/name target. Preserve native recipient/recipient_kind/content
   observations, but use canonical to/message for target/effective-input checks.
   An observed contradictory recipient is a refusal, not a second target route.
   Alias-only, object-message and unsupported forms receive no preparation.
   SendMessage additionally needs a positively inactive/resumable task record
   and no pending start/resume. A running, waking, unknown or concurrently
   resuming target is sent the original input unchanged, without issuing T2.
   Preserve T1; this is ordinary messaging within run1, not a new execution.
   Positively inactive means the exact accepted Agent run has a matching native
   task_notification with completed/failed/stopped terminal status, retained
   after TaskRecord removal, and no newer/unknown run or pending resume/stop.
   Hand-back receipt, elapsed quiet time, task_updated(killed), or a TaskStop
   failure string alone is insufficient. Terminal status proves local inactivity,
   not native permission to resume: actual resumption success is still required.
3. Copy the confirmed default basis and generate 32 cryptographically random
   bytes as 43 base64url characters. Collision-check the live registry. Prepare
   one entry and return updatedInput. Prepared state cannot grant authority.
   Repeat of identical call/input is idempotent; conflicting call reuse rejects.
4. Arm only after both the actual successful tool outcome and a native accepted
   task-start witness join the exact call, task and run with matching effective
   input. Agent needs its actual async-launch success, Monitor its actual launch
   result/task, and SendMessage success=true/resumedAgentId. PostToolUse presence,
   outer permission metadata, broker allow or a success-shaped display alone
   is insufficient. Task-start can precede PostToolUse (recorded native ordering); keep it
   pending and reconcile either order. Early report/completion cannot bypass
   the successful join, nor delete its preparation. A closed claim state wins
   over a later join. A queued success without resumedAgentId (or any other
   unsupported success form, including an inline result without the required
   background join) discards T2 and grants nothing. It does not retire T1 or
   prove that a new run started. Never guess the current/most recent run.
5. Denial, failed launch or pre-launch cancellation invalidates the preparation;
   a late success-shaped observation cannot revive a revoked record. Another
   hook's input rewrite or deny is not overridden. Do not use permissionDecision
   allow as an instrumentation shortcut.

E9's independent SDK hooks receive original input even when registered after
the updater. Registration order is not an effective-input proof. Validate the
planned update inside the issuer: Agent/SendMessage may only append the defined
instruction to their canonical text, Monitor may only append description,
and all unrelated fields/tool identity remain exact. A later hook's allow or
success is never a certificate that these bytes reached native execution.
Before arming, independently compare the actual successful PostToolUse/native
accepted input and task/call witness with the registry's expected update; a
conflicting/missing marker or another hook's rewrite invalidates preparation.
Do not silently re-inject the marker over another hook or override its deny.

No inspected baseline hook decides native Agent prompt, Monitor description or
SendMessage message/content. Existing configured shell guards retain their
own normal path; SDK rejecting-hook probes do not claim to cover every shell
hook. If the deployment adds a policy depending on rewritten fields, repeat
that configuration's relevant premise checks before enabling this mode. Do
not add a token-checking sibling hook and assume it observes updatedInput.

For Agent, append an exact canonical final-report marker instruction while
preserving the original prompt. Only for the eligible reactivation case above,
append the new instruction to canonical SendMessage.message: the previous
marker is invalid; only the new marker belongs to this new execution.
Preserve to, summary and all other supplied fields.
E7 demonstrates that the effective message reaches the new child; it does not
synchronize content. Native backfillObservableInput makes content a short
preview (Io(g,50)) before rewriting, not an authority-equivalent full message.
Record original/effective canonical-message digests separately from that
historical preview. Do not validate a marker against content, copy content back
into message, or require equality to arm a legitimate E7-shaped resumption.

The stale preview may be visible in native hook logs/history or to another
hook. Document that effect; wrapper diagnostics must identify effective message
as the actual child input without exposing raw tokens. Continue all native/
broker/user-hook permission checks on their actual native path; do not rewrite
arbitrary hook policies or fabricate a synchronized alias. Permission controls
that depend on message/content must be measured in their actual configuration
before approval. Dual-field rewriting would add an unmeasured external premise
and is not the selected solution. Failure of the canonical-only policy returns
D9 to design; it is not hidden by passing the alias test.

History can contain old instructions; model compliance remains uncertain.
Peer hand-back old-only return rejects; old plus new rejects as multiple markers, even if the
old entry is retired. Never select the convenient live token and discard the
conflicting one.

A live target receives no marker-changing instruction, so its valid run1 report
can continue to use T1. The native agent-live branch queues a message for the
next tool round with success=true but no resumedAgentId. The already-waking
branch can do the same. Both paths are established statically from the actual
pinned artifact; E7 measured inactive-task resumption, not those live controls.

There are two explicit races. If a target judged inactive is actually waking,
the prepared T2 instruction can reach run1 before the queued result is known.
Discard T2, preserve T1, and do not treat queue acceptance as supersession. The
injected instruction cannot be retracted; a model that switches to T2 may lose
that report. Record this bounded liveness failure in the ADR and test it, rather
than claim no disturbance. Conversely, if a target judged running completes
and the uninstrumented message starts run2, native new-run evidence retires T1;
run2 has no new capability and a T1 report is refused. This race fails closed.
Do not repair either race by issuing after the fact, promoting an old token or
arming without an accepted background-run join.

### Confirmed execution replacement (M1)

Observe every native task frame that supplies a task/run relation, including
task_started, task_progress and task_notification, regardless of root/child
initiator. A recognized newer execution for an existing task immediately
retires previous-run Agent capabilities and unresolved claims, even if unused,
and independently of whether a new SendMessage token is issued. Retire before
admitting another claim. Run IDs are opaque: compare equality, not lexical or
numeric magnitude. Use the session/generation, observed task/call history and
accepted native ordering to distinguish executions.

Keep known retired run IDs in the source history. An exact duplicate or known
older-run frame cannot revert the active run or reopen a claim. A different,
previously unseen run ID on a progress/notification frame is sufficient to
close/quarantine the potentially superseded old claims immediately; it is not
by itself positive proof to arm a new capability. If the relative ordering or
call identity is contradictory/unknown, suspend new claims for the task and
fail closed rather than infer which run is newer. A later task_started cannot
revive a capability already closed by that evidence. Positive arming still
requires its own accepted call/effective-input and successful-outcome join.

Do not delete the new run's separate prepared record while retiring old ones.
Task completion's removal of an ordinary TaskRecord must not erase source/
capability history. Global child-initiated progress/completion can therefore
close an old capability even if its task_started was missed. Product acceptance
must verify that the real restart's relevant evidence reaches the gate before
a stale report can gain a new origin; seeing none is not repaired by token
text alone. Exercise start-missing, progress-first, completion-first and known
late-old-frame schedules.

Run1 and run2 reports carrying T1 after confirmed replacement both get no new
origin. Existing proved run1 report leases continue to their own root terminal;
that root may itself send the reactivation. Producer stop, supersession and
normal retirement only close claims. Host authority invalidation (generation/
session end, reset, fail-stop or owner terminal) remains the separate cause
that ends an already proved lease. Do not use producer state as that cause.

## Monitor description transport and permission boundary

Append the issued marker only to Monitor.description, in an exact registered
suffix. Keep command or ws URL/options, stdout/event payload, line count/EOF,
stderr, timeout and every other execution field unchanged. Classify the actual
public command/ws input and accepted task type (local_bash/monitor_ws) before
binding; monitor_ws never becomes an unknown Bash or a fourth legacy match. Introduce no wrapper process or runtime helper.
E6 establishes command event/completion/expiry transport. E9 establishes WS
text/normal-close transport and the shared native formatter supplies the static
full-description-copy premise. The final common suffix/encoding, maximum length
and each accepted input still need final-candidate acceptance; the WS live probe
used a prefix. Do not substitute a helper if those checks fail.

Use strict per-block parsing with the existing bound of 1–16 complete top-level
task-notification blocks per native prompt (recorded native ordering). Outside them,
allow only whitespace; reject nested blocks, duplicate/conflicting fields and
malformed/trailing material. Within each Monitor block its unique outer summary
precedes event, with task ID and optional completion fields in canonical
positions. Never search event text for another summary or split escaped payload
into blocks. Bash/Workflow use their existing strict field predicates.

Pin the actual native escaping prerequisite: Monitor event body, task ID and
description pass through Wt, whose implementation replaces &, < and > once
(recorded native ordering). Parse outer structure
before any scalar comparison/decoding; encoded block text remains payload.
Compare the expected escaped scalar, never recursively decode and reparse it.
A changed/missing escape contract fails acceptance; do not restore a permissive
multi-block search. P3 tests real block-looking payload through native execution,
plus a copied raw nested-block negative, and mutates escape and parser wiring.

For a new root, prove every block separately under its classified constructor,
registry/candidate, source/task/run, marker where required, common B opener and
live integrity checks. Monitor event/completion, Bash and Workflow may mix.
Prepare the whole proof/claim set before committing; if any block is unproved,
unknown, duplicate or conflicting, refuse the entire prompt without partially
consuming claims or starting an owner. Once all proofs and ownership agree,
commit the set atomically and idempotently as one receipt/owner/lease. A final
event inside a completion block still counts as one block/claim. Distinct
Monitor events may share a launch/token/task; their native row UUID plus block
position distinguishes occurrences. Reusing the same one-use completion claim
is a duplicate; identical payload bytes alone are not. A fold keeps its existing
owner/default rights even if the collection fails; only denial-only reservation/
quarantine bookkeeping may remain, with no partial positive consumption.

One owner still has one immutable basis: ordinary Bash/Workflow blocks share
the opener-time completed snapshot; each d4 block supplies its launch snapshot.
A new mixed root requires these maps to agree by confirmed entries, not object
identity. Different snapshots remain the existing attribution conflict: reject
atomically rather than union maps or pick the newest/first block. No additional
token, terminal, receipt or recovery ticket is minted per block. One SDK root
result settles the collection; any supplied source identity must agree with a
proved member, never a later unrelated completion. This preserves legacy
bundled completions with a common basis while keeping d4's issuance bound.
Different-basis refusal is a legacy regression accepted under R4-S1 option (a),
not merely an internal ambiguity. For example, Monitor launched at confirmed
input n plus a Bash completion whose opener map includes n+1 is refused;
legacy could admit both at n+1. Two Monitor completions launched at n and n+1
also refuse when coalesced. Report a visible batch-basis-conflict diagnostic
through the existing refusal surface; never silently discard the batch, refresh
the Monitor basis, split one root into owners or union snapshots to hide it.

Resolve each Monitor marker only as its registered description suffix in that
block's outer summary and compare the whole effective description/task context.
An escaped quotation of a notification is payload, not another source. A raw
nested block, event-injected summary, or any unproved sibling cannot authorize
a root. Unknown/conflicting metadata never selects a convenient live token.

Keep the original description unchanged and append one new issued suffix. Do
not strip historical markers in this design: that would be another input transformation
and a new permission/display premise beyond the measured description append.
The exact registered suffix is the sole eligible Monitor marker position; older
marker-looking text in the preserved description prefix is context, not another
authority candidate. Require a full registered-description match, never scan
that prefix for a convenient live token. Repeated re-arm can grow description;
warn/refuse instrumentation when the validated field/length contract cannot
be met, retain source classification, and never silently truncate or remove
text. A native truncation/mismatch also fails closed. Length/escaping and repeated
re-arm are acceptance cases; no universal transparency promise is made.

The description is visible in native notices/model context and can appear in
task display/history. This is a metadata change, not stdout rewriting or a
promise of byte-transparent display. E4's empty-line/final-LF changes are rejected
history. No early-exit/expiry helper shortens the native watch. Natural expiry
may acquire its own root through the same capability+B proof as an event; it
needs no task-id-only alternative constructor.

E6 preserves one command deny. E9 adds auto-mode Monitor allow/deny/ask and
independent hook controls with command/timeout unchanged, actual broker inputs,
no execution on refusal and exactly two allowed executions. Agent auto ask and
an independent reject also retain their outcomes; E6 retains typed Agent deny.
Whole-Agent deny receives the explicit exclusion/unchanged-selector disposition
above while its live before/after comparison stays unmeasured. The inspected
permission snapshot/defaults are the scope of this premise, not every policy.

No broad allowedTools, permission allow output, native-parser duplicate or broker
override may be introduced. Preserve the real native/broker/guard decisions;
any observed weakening returns to design. Scripted auto-classifier responses
prove neither real-model classifier invariance nor arbitrary content-sensitive
hook equivalence. Record that limit in the ADR rather than silently promising
universal permission-decision equality. The independent design review must
judge this bounded evidence; product P0/P8 still checks actual final wiring.

## Return proof and one reducer

Select one startup-only admission mode per Query: legacy, or unified native
continuations. KAOIRO_CLAUDE_NATIVE_CONTINUATIONS selects it: native is the
default (operator decision 2026-10-17), `0` selects legacy, and `1` is kept
for compatibility. No in-flight
switch, early/yield expansion, UI toggle or server comparison change is added.
All proof variants enter one reducer, root binder, final validator and terminal
settlement. Legacy matching cannot independently begin a turn in unified mode.

| Classified source/input | Proof in unified mode | Basis and disposition |
| --- | --- | --- |
| Agent initial/reactivated peer hand-back | Accepted current-run capability with claim eligibility (armed or draining), exactly one canonical report marker, native peer/task consistency and B opener | Launch snapshot; one shared report slot |
| Agent native completion | Accepted same-notification task/run/call capability, exact native report and B opener runId; result markers ignored | Same launch snapshot and report slot |
| Monitor event/natural expiry with eligible description marker | Live eligible capability, exact registered marker/description at native outer summary boundary, native local-task provenance, all available outer task consistency and B opener | Launch snapshot; repeated distinct occurrences, including expiry during normal drain |
| Instrumented Monitor normal completion, possibly containing final event | Exact claim-eligible registry/task/run/tool-use join to native completion frame, strict per-block structure, all-block atomic proof and B opener; final validator mandatory; explicitly canceled or claim-retired runs cannot create claims | Launch snapshot; one receipt for combined completion + last event, independent of final event or token presence |
| Uninstrumented/unknown/unsupported Monitor or Agent | No positive report capability; source classification retained | Never fall through to ordinary Bash |
| Ordinary explicit-background Bash, independent/fold | Exact native task/start/completion relation, current run/call and strict candidate match plus B occurrence | Existing opener-time completed snapshot; no command rewrite |
| Timeout-promoted Bash | Same, including [issue #595](https://github.com/sakuraiyuta/kaoiro/issues/595)'s same-run background update | Same existing completion policy |
| Workflow | Native completion proof with [issue #595](https://github.com/sakuraiyuta/kaoiro/issues/595) implicit-background rule and exact matching plus B occurrence | Same existing completion policy |

### Monitor completion and the last event (M2)

Treat a native Monitor completion as a typed use of the existing run-aware
completion proof, classified as Monitor before admission. Match generation,
session, registered task/run/tool-use, frame status/output/summary and the
native opener occurrence. It is not “token failed, so try Bash.” A source/call/
run mismatch cannot enter another proof variant. B's native root and final
integrity check are not replaced by producer tuple agreement.

When status completion and the final event share one native delivery,
reduce them atomically as one receipt: at most one root start/snapshot/lease,
and no second event claim or completion settlement. If the transport supplies
an eligible description marker, it agrees with the registered launch. Arbitrary
event payload strings are not that metadata. Contradictory eligible evidence
or task identity is not silently ignored. A fold of this delivery retains
the existing owner. The packet does not produce an extra root terminal merely
because its task has ended.

As confirmed by the director, a fully proved Monitor completion needs neither
a final event nor a marker. It uses existing native completion evidence, still
requiring the instrumented registry's frozen launch snapshot and B opener.
This avoids a silent legacy regression and is not an alternate constructor for
unproved inputs. E6-marked natural expiry uses the ordinary capability proof,
not this completion variant. Explicitly canceled or claim-retired runs cannot
create new claims even if a later packet has a full tuple or marker. Previously
proved return leases remain valid. Tests and ADR use this same rule.

Legacy eligibility is checked statically against real fields, with its idle/
candidate/occupancy conditions explicit. Existing generic local_bash tests are
not Monitor live delivery evidence. Product acceptance must exercise a true
independent Monitor completion root through final production composition and
requester receipt, including a combined last-event/failure notification.

### Native opener, waiting and live integrity

At a genuine root hook, record session/prompt and the hook-provided native
transcript path; capture file identity and committed-prefix evidence even if
the target row has not persisted. Select exactly one complete native root user
row with current session/prompt, non-sidechain provenance and promptIndex=0.
Source/turn origin must agree with native origin. A peer report requires the
expected senderTaskId/handback provenance and replay UUID consistency when
available. Monitor requires origin.kind=task-notification and the measured native
root shape plus registered description/summary or completion boundary. If
producer is present it must be session-task; its absence is not rejected by
itself because E9's genuine normal WS close omits it. Missing producer never
substitutes for a known instrumented Monitor, exact source/task/description
match, current native promptId and non-sidechain system root row. Other
producer values or missing kind fail closed. Compare available task identity
with the source index; outer task-id text alone grants nothing.

The opener's eligible field contains the marker for marked-report sources.
Do not search assistant output, tool arguments, previous rows, later folds or
ordinary peer/operator input. Multiple different Agent peer-report marker candidates
reject;
old+new Agent peer-report markers reject before selecting the live entry. Monitor
uses its exact registered-description suffix and strict per-block outer
summary contract per block; preserved description-prefix markers are not candidates. Unknown,
misspelled or absent marker cannot be repaired by similarity/timing. An
ordinary wrapper input containing a marker keeps only its ordinary rights.

Missing/not-yet-complete target data may wait for one acquisition budget of
5,000 ms with approximately 50 ms polling. This reuses the measured cutoff,
not a latency SLA. Include the origin resolver in that one budget, not a second
5-second wait. Cancel a new proof acquisition on root terminal, generation/
session change, claim retirement/suspension or fail-stop. Producer stop does
not cancel calls already belonging to a proved lease. A rejected/timed-out call
is tombstoned and cannot revive when a row arrives late. Definitive evidence conflict is not normal lag.

Use a generation/session-owned regular-file reader with strict complete JSONL
parsing; only a trailing partial line is pending. Keep file identity, committed
prefix length/hash and immutable selected rows. Before granting proof and each
ordinary native-origin dispatch, re-read/check the committed prefix and current
anchor. Append-only growth is allowed; truncation, replacement, restored stale
content, changed committed bytes, lost anchor or conflicting identity invalidates
the reader epoch. No mtime-only or watcher-only check is sufficient.

Await the mandatory final proof/lease validator in the actual send path, then
synchronously recheck owner/call, generation/session/epoch, host lease revocation,
admission state and ReplyBasis.beforeSend immediately before dispatch. Repeat
after conversation-lock/other waits. A missing validator rejects on that path.
A warning is not a gate. Locally refused sends do not settle reply obligations
as delivered. Wrapper origins and existing narrow internal-notice exceptions
keep their existing checks; no exception is expanded for d4.

Distinguish claim eligibility from a derived lease's liveness. Consumption,
normal drain expiry, confirmed supersession and attributed explicit producer
TaskStop/cancellation prevent new origins; they do not fail the final validator
of an already proved owner. Its admitted root remains legitimate even when it stops its own Monitor
and then reports to the requester. The same rule applies to a producer stopped
by another root: no special self-stop exemption or retroactive lease revocation.

Keep immutable launch/task proof and the host authority epoch in that lease,
independent of registry claim state. The final send validator checks the root/
lease, generation/session, reader integrity and host revocation epoch; it must
not require an active producer, unconsumed bearer, absence of TaskStop, or
continued registry presence. Host/session end, reset, fail-stop, root terminal
and actual root cancellation still invalidate affected leases/calls through
the existing host authority lifecycle. Stopping a background task is not that
host cancellation and cannot be used to settle the return root early.

Compaction is not by itself corruption/terminal if its attribution anchor stays
valid. Anchor loss blocks sends; no summary/recent row invents a new opener.
Recovery from a damaged epoch needs a new SDK generation and confirmed wrapper
root. An ordinary later root cannot repair the same unresolved origin. Use the
existing visible host fail-stop, preserve terminal diagnostics and barrier,
and do not force SDK close/abort to make ownership fit. Validation is
observational; file changes after a read are not an atomic network transaction.
Measure large-transcript prefix cost before setting a performance criterion;
the 50 MB class record is
[2026-10-16-transcript-reader-cost](../evidence/issue-426/2026-10-16-transcript-reader-cost.md).

## Fold reservations and immutable owners (S3 / E5)

Choose conservative reservation/quarantine now; remove E5 as a pre-design
external-availability prerequisite. A folded marker grants no origin. A known
live Agent peer marker or native tuple-bound completion observed in an unresolved
delivered input reserves or quarantines that capability against a different
root's claim. Completion result markers are never scanned. Denial-only
quarantine is distinct from a positive, consumed report occurrence. An
unproved source cannot grant rights merely because its text contains a token.

Native inclusion may be resolved later from a queued_command attachment with
source_uuid/delivery_id, native origin and proven relation to the root. These
are delivery identities, not task-run IDs. Missing attachment never authorizes
a fresh root or changes the current owner's basis. Proof failure/unresolved
quarantine does not release the token for reuse by a later root. Normal wrapper
calls under a valid owner do not wait for every folded attachment to persist.
The 5-second acquisition cutoff is for a call seeking new proof-dependent
authority, not a blanket pause on pre-existing wrapper rights.

Same delivery observed by hook/echo/file is idempotent. Agent can accept one
proved report occurrence; a different delivery cannot race for a second use.
Monitor can accept multiple native event occurrences per launch. Keep active
claims and validated reader position without an unbounded set of event payloads.
Repeated bytes in a genuinely new Monitor occurrence may still be legitimate;
do not claim a shared launch marker is a per-event anti-replay nonce.

| Root before return | Proven fold / candidate | Owner after processing |
| --- | --- | --- |
| Wrapper root | Marked or unmarked fold | Same wrapper owner/default; only reservation bookkeeping may change |
| Admitted native root | Another launch's fold | Same opener/default, no map union |
| Foreign/unmarked opener | Later marked fold | Foreign occupancy stays send-less |
| No owner, known genuine marked opener | Full current capability + B proof | One new native owner with selected snapshot |
| Live root plus unexplained fresh prompt ID | Any marker | Ambiguous; no retagging or additional authority |

P6 measures native scheduling and reservation resolution after implementation.
the prior folded-input probes's missing first-send fold rows are negative evidence for immediate
inclusion, not a reason to invent a saved row or add another prerequisite probe.

## Lifetime, retirement and cancellation

Registry state is memory-only. Raw markers necessarily enter native prompt/
report/description history and can be visible in existing native task metadata.
Do not persist a separate capability ledger or add raw-token wrapper diagnostic
logs. Use hashes/redaction in diagnostics and public evidence. Native session
resume never reconstructs an old registry.

| Event/state | New claims | Existing proved return owner |
| --- | --- | --- |
| Prepared / no successful launch join | None | None |
| Armed Agent | One report; same occurrence reobservation idempotent | Fixed basis lease once granted |
| Armed Monitor | Distinct repeated event occurrences | Each new root has its own fixed lease |
| Normal task completion, including Monitor exit 7 or natural WS close (native status may be stopped) | Draining with proposed 10 host-idle seconds; preserve queued eligible returns when there is no attributed explicit-stop evidence | Owner continues to its own native terminal |
| Natural Monitor expiry | Enter normal draining after valid marker/source/target consistency; eligible expiry may claim during that grace; never reopen an elapsed drain or explicit revoke | Same fixed-basis independent-root policy as an event; a fold changes no rights |
| Agent report consumed | No different report claim | Do not abort its already admitted owner |
| Same task confirmed new run | Previous-run Agent records/claims retire even if unconsumed; D9 choice does not change this | Already proved old report root is not retroactively canceled |
| Normal drain expiry | No further claims, no marker resurrection | Existing proved lease continues to its terminal |
| TaskStop pending exact known target | Suspend only claims for that named task and captured run; never project uncertainty to the Query | All already proved leases continue, including the root issuing TaskStop; pending stop alone does not block their sends |
| Named task stop or precise native explicit-cancellation witness | Close only the exactly attributed task/run claims with no drain; no Query-wide inference. A named attempt's matched terminal need not wait for PostToolUse; ambiguous natural Monitor stopped status keeps its reason-aware policy below | All already proved leases continue to their own terminal; later producer inputs gain no new origin |
| TaskStop definitely fails without cancellation | Remove only its pending claim suspension if otherwise eligible; reconcile intervening completion/expiry | Existing leases were not suspended; a refused new acquisition remains refused |
| Named stop with uncertain/contradictory run | Suspend only claims of the named task pending exact attribution; unknown task has no effect on unrelated records. No guessed newer run or timer-only restoration | Existing proved leases remain valid unless host authority/evidence independently fails |
| Query interrupt / watchdog / SIGINT control | Observe a bounded end-attribution window; neither close nor suspend background claims just because the control was called/ACKed/expired | Existing current-root retirement and buffered-result barrier stay; background claims/leases are not inferred stopped |
| Query.stopTask(taskId) dispatched | Close only the named, captured task/run claims before dispatch; unknown run stays limited to that task. ACK/error does not restore a closed target | Producer closure alone preserves proved leases; host cancellation is separate |
| SDK generation ends/restarts, session/reset, host fail-stop | Invalidate host authority, records and leases; no migration | All affected dependent calls lose authority |
| Launching wrapper root ends normally | Keep detached background record | Parent AbortSignal retirement is not background cancellation |

### Stop attribution principle (R4-M1 class correction)

R3-S2 and R4-M1 exposed the same class twice. Replace the Query-wide closure
rule, not just one table cell: a producer claim changes only for (a) a stop
naming that task, or (b) an exact native end/cancellation witness identifying
its accepted task/run. Query-wide controls never identify a stopped background
producer by themselves. The table above and every entry below use this rule.
Keep host close/reset/fail-stop authority invalidation as its separate stronger
transition; preserve normal completion/natural-close drain when no attributed
explicit stop applies.

| Source | Required scope/evidence and claim effect | Lease/root effect |
| --- | --- | --- |
| Root or child TaskStop tool | Capture the named task/run at the native attempt; suspend only it, close on exact success/terminal/typed stop notice. Definite failure removes only its own suspension | Producer stop does not revoke proved leases |
| SDK Query.stopTask(taskId), through any wrapper/adapter caller | Record the named task/current run before dispatch and close only that target. No direct caller may bypass the reducer. An unknown run can suspend only that named task until exact evidence resolves it | Producer-only control preserves proved leases |
| AgentHost.interrupt(), including operator, watchdog and SIGINT callers | Record an observation window and the currently accepted live task/run pairs; do not close or suspend them. Only a precise stopped/killed terminal witness in that window closes the matching pair. No witness means claims remain live | Existing interrupt retirement of its current host root is unchanged; ACK does not settle the buffered root result |
| Native typed cancellation/end evidence | Require generation/session, exact accepted task/run and available call identity. A reliable explicit-cancel witness closes only that pair, regardless of initiator. Normal completion/natural WS close drains under its known semantics | No producer event adds host/lease revocation |
| Host close/abort, reset, generation/session end or fail-stop, including SIGTERM and SIGINT's later close | Existing authority invalidation clears its records/claims; this is host lifecycle, not inferred producer cancellation | Existing affected-root/lease invalidation stays intact |

An interrupt window starts at the control call and ends 1,000 ms after ACK,
with a hard cap of 5,000 ms from the call; a definite control failure ends it
without changing any task. These are proposed bounded observation constants,
not measured native latency promises. Use monotonic elapsed time, do not pause
this window for busy roots and do not wait/block admission on it. Only task/run
pairs already live at that call qualify; new runs and known old/duplicate frames
do not inherit its scope. ACK/error must settle only their own tagged observation
record, not another overlapping request or a host root. Window expiry does not
close, suspend or restore claims.

A qualifying window witness is an actual terminal task_notification (or pin-
validated equivalent) with stopped/killed semantics and the exact captured
pair, not task_updated(killed) alone, event body text, ACK, elapsed time or
absence of output. Close only the witnessed task. Native interrupt may stop
just the turn: surviving background Agent/Monitor capabilities remain valid
and can prove later report roots after the interrupted root actually drains.
The narrow temporal attribution does not prove that interrupt caused a natural
WS stopped frame arriving in that window; disclose that ambiguity, never expand
it to other producers. Outside that window, natural WS stopped still drains
unless named-stop or reliable explicit-cancellation evidence applies.

The current pin's static interrupt path calls a turn abortController in the inspected native artifact; it does not
establish Query-wide background termination. The adapter documentation records
SDK .220 observations, not the current .293 behavior. Current-pin live controls,
window boundaries and witness matching remain P4 acceptance. Local attribution
must work whether interrupt actually terminates zero, one or several tasks.

For unlisted/unobservable producer termination with no attributed stop evidence,
keep normal drain with the full source/opener/claim proof. A queued report after
such an external stop may still be admitted within the idle grace, as disclosed in the accepted lifetime policy. Conflicting evidence suspends only a specifically named/matched task;
never all Query entries. New stop callers must pass the same target/witness
projection before use. Host-root cancellation still independently invalidates
its own calls; preserving producer leases does not undo existing interrupt
retirement or turn-boundary settlement.

Treat termination reason and producer state separately. E7 supplies actual
TaskStop target/success fields and frame-before-result ordering. At an observed
known-target stop attempt, including attributable child attempts, capture the
current task/run and suspend only its new claims. Existing proved leases and
sends continue. A matching terminal frame confirms that named stop before PostToolUse;
a matching success/typed native stop notice can also confirm it.
Close those claims with no drain. No late result/input restarts them. A failed
stop removes only its pending claim suspension if still eligible; it cannot
revive a refused acquisition or ignore an intervening actual terminal.

Raw status stopped is not a universal cancellation proof: E9's normal WS close
emits exactly that status before queued event B/close. For a classified Monitor normal terminal with neither named/explicit-stop
evidence nor a qualifying interrupt-window witness, enter normal drain and
retain queued event/close/expiry eligibility under the same capability+B proof.
Do not infer deliberate cancellation from raw status or a lifecycle event body.
Conversely, an observed explicit TaskStop/confirmed cancellation cannot be
reclassified as natural close just because a late marked event says "closed".
Unresolved conflicting stop/target evidence suspends only affected new claims;
it does not grant by timing, nor invalidate earlier proved leases.

Source history records named-stop intent/outcome and precise native end
witnesses independently of capability consumption. Query control windows are
observation records, not blanket explicit-stop flags. An outcome naming only task_id
must join an unambiguous recorded attempt/run, never a guessed newer run.
Trusted native stop notices still need native origin, strict outer structure
and existing source/run relation; arbitrary event body text cannot manufacture
or remove the stop reason. Global evidence may close exactly attributed claims
without root issuance; it never creates a basis. Host/session invalidation is
the separate transition that revokes already proved leases.

Both E7's explicitly stopped Monitor and E9's naturally closed WS producer
continue delivering queued input after their terminal frame. Distinguish them
by explicit-stop evidence, not by packet arrival order. Test them side by side:
TaskStop rejects later new claims while natural WS close drains event B/close;
in both cases leases proved before termination remain valid. The event root
can stop its own Monitor and then reply. Native producer termination is not
the reporting root's terminal, cancellation barrier or authority to settle it.

A pre-first-send WS reader, error/expiry/binary/suppression/re-arm schedule and
independent explicit-stop admission gate were not live-proved by E9. They are
final product acceptance obligations, using the same checked native formatter,
source classification and conservative lifecycle. Unknown source/reason
conflicts fail closed rather than becoming a new positive proof constructor.

The proposed 10 idle seconds pause during root occupancy/acquisition. Do not
close claims on an early normal-completion frame before its queued report arrives. No
arbitrary active Monitor wall TTL is added; a long-lived producer ends by
task/session/generation lifecycle. Completion loss may retain a bounded entry
until process end. Continuous busy accumulation/capacity/refusal/recovery is a
required test and visible diagnostic, not a silent unsupported mode.

Preserve one native terminal per root: exact session/generation, advancing
result_index, duplicate-retired-result handling, ambiguity and opener-origin
agreement. Peer terminal must name the opener sender, not a folded sender.
Monitor terminal remains local-task-notification origin, with producer optional
as in the matching measured WS close opener/result. Wrong present producer or
kind fails; an absent producer is not a run ID. It does not borrow a later task
completion's run ID. Token is not invented as a native result key.
Stop/StopFailure, reset notice, task completion and interrupt ACK alone do not
settle an unrelated root. End the owner's snapshot/watchdog/calls once on its
actual terminal; leave still-active Monitor capability records intact.

## External gates and implementation acceptance

The director's E1–E4 plan stopped at E4's first permission weakening. Separate
frozen E6, E7 and E9 plans then ran; they do not revive that abandoned budget.
E7 used seven SDK queries, E9 eight, and neither used a provider model call. This design/result
review adds no native queries, budget, configuration change or work assignment.
The director must freeze any additional premise measurement separately.

| External premise | Evidence and selected disposition | Remaining boundary |
| --- | --- | --- |
| Native variants / E1+E9 P4 | Actual public ws schema, accepted monitor_ws task and two text/normal-close notices; shared full-description formatter covers its constructed notices statically | E9 WS marker is a prefix, first-send reader/admission and error/expiry/binary/suppression/re-arm are not live results. P1/P3/P4/P5/P8 check final common suffix, shape, lifecycle and receipt; do not enable hidden variants |
| Resume / E7 + actual native live/waking branches | Inactive auto resume/new run/call measured. Active/waking queue semantics established in actual artifact; known live/waking/unknown target stays unmodified. Queued success cannot arm T2 | Preserve run1 report; disclose both registry/native state races. P3/P4 checks real live/waking/resume behavior and strict retirement. No alias-only/dual-field policy selected |
| Producer lifecycle / E7+E9 | Explicit TaskStop frame-before-result plus late input; natural WS stopped-before-event/close; producer absent on close native row | Stop evidence closes new claims, natural terminal drains, all proved leases continue. P4/P6 must pin both sides and host cancellation, not a raw-status heuristic |
| E4 command wrapping | Rejected after measured native deny→approvable ask/execution | No helper or repair path |
| Agent ask/hook / E9 P1 | Auto whole-Agent ask reaches real broker before/after prompt update; independent reject preserved on original input | Hook propagation, arbitrary policy and real-model classifier invariance not claimed. Preserve exact active policy/defaults; P0/P8 checks final wiring |
| Agent whole-tool deny / E9 P1 + E6 | Before/after live comparison remains unmeasured. Director's no-extra-probe disposition: whole-tool exclusion prevents the measured call/rewrite, d4 changes no availability/name/type/rules/allowedTools or permission allow; E6 tests typed deny after actual calls | Do not label the failed fixture green. Arbitrary unoffered/alias calls are not live-proved; no native permission-system completeness claim. Final P0/P8 rejects denied/failed arming and added-tool/bypass mutations |
| Monitor permission / E9 P2 | Auto allow/deny/ask/independent reject retain outcomes; actual command/timeout and broker/accepted input checked | Guard sees original description, not effective update. Actual product validates its planned/accepted inputs independently; new policies require applicable checks |
| SendMessage policy / E9 P3 | Installed/source settings inventories match apart from paths; actual files match recorded hash. No native message/content-sensitive rule or matching hook in inspected configuration | Other deployments/future policies/production DB outside scope. content stays historical preview; a new relevant policy requires rechecking |
| D8 scope | Director withdrew expiry-only question after E6; description mechanism includes natural expiry and public WS under its proof contract | Only a separately demonstrated variant inability returns for a new scope decision; unproved individual input never grants |

The E9 report correctly declines to claim the entire implementation gate passed.
The table records our separate bounded design dispositions, including the
whole-deny exception to further probing; it is not a live universal permission
or variant certificate. No additional prerequisite query is requested here.
The independent reviewer judges these dispositions before implementation.
Changes to pin, settings, default allowedTools, hook composition or native
variant placement invalidate the applicable evidence; re-establish affected
premises instead of silently broadening this scope. Implementation guard/race/
reader behavior is tested on the reviewed product candidate, not by this
post-hoc measurement checker.

Do not approve a design with unresolved external permission/placement semantics.
Do not demand final product implementation to prove its own design before
review either. The following are acceptance on the reviewed product candidate:

| Gate | Positive/control cases | Required negative/mutation |
| --- | --- | --- |
| P0 issue wiring | Final encoding in actual effective Agent/Monitor/SendMessage input; accepted root launch correctly arms; no-injection construction reaches first meaningful lifecycle | Cut updatedInput, accepted-launch join and root-only guard separately; denied/failed/child launch cannot issue. Conflicting repeated call ID cannot rebind |
| P1 whole class | Agent initial/resumed report and known-running message; explicit bg Bash independent/fold; timeout-promoted Bash; Workflow; command/WS Monitor events and natural expiry/close; independent command completion with/without event/marker | Record attempt/acceptance/requester receipt separately. Mutate common proof gate on an old source and a new source separately. No private cache condition becomes an unstated production default |
| P2 fixed basis | Different requester inputs/owners and reversed launch returns; after n+1 is confirmed, launch A still attempts n. Nested d4 launches do not advance the map | Mutate export/import to latest ledger/union/return-time completed state. Assert actual outgoing in_reply_to, including expected stale rejection. Recovery tickets remain separately checked |
| P3 report markers | Agent peer suffix; completion result markers ignored; each Monitor block has outer summary before event and registered description/source/task. Native escaped block-looking payload stays payload. Known running-target SendMessage stays unchanged and run1/T1 report is accepted | Wrong/omitted/copied peer marker/source, old+new Agent peer marker, raw nested block/event-injected summary, one invalid sibling among valid blocks, 17-block overflow and duplicate/conflicting claims refuse the whole prompt. Mutate native escape, per-block parsing, all-block gate/atomic commit and summary/source guards separately; wrong producer or unknown source refuses |
| P4 retirement/capacity | Event-derived root stops its own Monitor, then replies and requester receives it. Other proved leases continue through pending/successful command and WS TaskStop. Natural WS stopped frame then event B/close gains legitimate drained claims; same delivery, repeated Monitor, early drain, busy capacity/recovery | Hold run1 report, start run2, deliver T1 on run2 first and run1 later: zero new origins. Exercise progress/notification before missing start and known late-old frames. Queue success discards T2 without retiring T1; uninstrumented live→completed race refuses run2/T1. After explicit-stop intent plus matched frame before PostToolUse, and after success, late independent/folded input creates no origin/timer revival. Hand-back-only, killed-update-only and failed-stop-only records cannot prepare a new SendMessage token; an exact-run terminal can, subject to the real successful join. Removing the stop reason must not turn natural WS stopped into cancellation; removing explicit-stop matching must not reopen canceled claims. Interrupt with no matching task end leaves a running Monitor/Agent's capability usable: prove/send its later report and requester receipt after current-root drain. Exact in-window stopped/killed witnesses close only their captured task/run; completed/failed, wrong/new/old run and outside-window frames cannot blanket-close survivors. Test ACK/error/window bounds, overlapping-control ACK isolation and no-end expiry. Named stopTask blocks its target's late claims, while unrelated reports succeed. Mutate target/witness projection and every control entry, including the incorrect close-all-on-interrupt variant, for red/restored. Existing host root cancellation still blocks its lease. Unlisted cause follows the documented drain/contradiction policy. Mutate retirement and claim-vs-lease separation guards; cover unspent/reserved/child restart, post-grace, overflow, unknown source |
| P5 bounded wait | Natural delayed opener appears while first-send hook is held; source snapshot frozen before wait | Hide row to reach 5,000 ms then expose late; cancel/terminal while pending. No stacked resolver wait, transport or call revival. Remove deadline/tombstone wiring for red/restored |
| P6 fold/terminal | Native missing fold attachment remains denial-only. Accept 1/2/16 proved blocks, multiple Monitor completions/events and Monitor+Bash/Workflow with a common basis; one receipt/owner and atomic consumption. Completion+event within one block is one claim; WS close's optional producer settles once | Foreign opener then marked fold, second launch's fold, fresh-root overlap, wrong folded sender terminal, conflicting/regressing result index. Quarantined token cannot admit another root; late row cannot revive a refused call. Duplicate completion+event cannot double start/settle; 17 blocks, one unproved sibling, duplicate source occurrence or incompatible snapshots commit nothing. For Monitor(n)+Bash/Workflow(n+1) and Monitor(n)+Monitor(n+1), assert the accepted legacy control versus unified-mode visible batch-basis-conflict refusal, zero new owner/send and zero partial consumption. Mutate all-block/rollback and bound guards; mixed-map conflict never unions or selects a first/newest map. Two Agent completions with different run IDs in one prompt (same map) refuse the whole batch with zero origin and zero consumption, one Agent completion whose run matches the origin is accepted, and an Agent plus a Monitor completion with the matching Agent run is accepted; removing the `origin.runId` comparison turns the two-Agent refusal red |
| P7 live evidence | Append-only growth and actual compact boundary retaining anchor preserve legitimate owner | At binding and final dispatch separately truncate/delete/replace/restore/change earlier bytes/drop opener/conflict identity. Product gate sends zero. Cut validator wiring and integrity guard separately for red/restored |
| P8 description/permission | Command or ws URL/options and payload/EOF/stderr/status/lifecycle behavior unchanged; exact final suffix/description in notices/display, including native error/expiry/suppression/re-arm notices and binary handling when exposed; native/broker allow/deny/ask and original-input rejecting hook. Two hook orders do not assume update chaining | Refused original command remains unexecuted after metadata change; ask still reaches broker in the approved exact permission modes/settings. Canonical SendMessage message reaches the new child while stale content cannot select/arm a capability. Mutate command-preservation, actual-success join and native permission plumbing separately; compare effective inputs/execution marks and invalidate preparation when another hook overwrites marker/command/message. Mutation that arms from planned input alone or broadens allowedTools must fail; no native-parser duplicate or broker override |
| P9 landing | Recorded native peer row/hook golden independent of product constants; installed SDK version and Linux x64 native binary hash checked in CI, requiring review on pin updates; default on (`0` selects legacy, operator decision 2026-10-17) and startup exclusivity; affected wrapper full suites/typecheck/build and mandatory runner typecheck/test; reviewer gates exact final landing candidate; production-equivalent CI | Missing mandatory validator and oldMatch-or-newProof bypass must be caught through production entry point. Rebase/target changes require final evidence; no helper asset is part of description-only candidate |

M1's strict delayed-old-report negative is not measured by R301 or E7. R301
proves a new execution can reuse an old marker; E7 demonstrates fresh-message
transport, not enforced retirement. N301's two launches share one original
owner and do not establish cross-owner concurrency. Product race/integrity
acceptance is incomplete until its live gates run on the final candidate.

Test the bounded bearer claim directly: wrong/unissued/retired/generation tokens
create no origins; task B with A's marker conflicts; a marker only in a later
foreign fold cannot promote its root; a valid A report after newer input still
attempts A's map. Deliberately replay identical active Monitor payload under a
fresh real delivery: acceptance may be allowed but cannot acquire a newer map.
Content changed while retaining a valid bearer is not authenticated by d4;
it cannot change snapshot selection or mint recovery authority.

Native tests use final runClaudeCli/SDK/CLI/MCP plus isolated real server and
requester. Observation seams forward rather than substitute the production
path. A fake model must read actual updatedInput to prove transport; echoing a
predetermined token is a fixture assumption, not T1 evidence. No real-model
obedience claim follows from loopback scripting. A post-hoc parser is not a
live fail-closed gate.

Record exact target/verifier hashes, commands, exits, warnings/unhandled errors,
attempt/acceptance/receipt values, feature conditions and mutation red/restored
results. Relevant target/verifier changes expire native evidence. Run faults
only on owned temporary files/processes and retained direct PIDs. Measure the
large-transcript worst case before setting a performance bound. Do not add
review rounds to replace a missing check.

## Product unit and frozen integration touch points

One atomic product unit includes Claude host/CLI root hooks and typed reducer,
launch registry/source index, marker and native transcript reader, measured
Monitor description instrumentation, SDK-MCP handoff, narrow common ReplyBasis
detached snapshots/mandatory validator, focused unit/integration/native tests,
configuration and docs. Existing task display remains separate from authority.

Reviewable commits may split work inside that unit; they are not independently
landed producer subsets. All accepted cases pass with unified mode selected,
including the default (unset) path, and legacy (`0`) controls stay green, before
landing the reviewed candidate with native as the default.
Director follows exact-candidate/patch-id/reviewer/runner/CI rules.
No server auth change, dashboard feature, work grant, generic cross-session
admission, SDK upgrade or early/yield behavior is included. A newly necessary
independent product unit needs an explicit cost/scope decision and separate
issue before implementation. Production on remains separately operator-gated.

Future [issue #214](https://github.com/sakuraiyuta/kaoiro/issues/214) C6 rebase adapts root readiness/foreign occupancy, typed
owner/lease callbacks, early eligibility, shutdown/reset and unread integration.
It preserves frozen launch snapshots and one owner per root. Do not merge the
frozen server-queue branch as a prerequisite.

## Agent completion and peer hand-back

Agent reports have two proof variants with one shared capability/accepted-call/
task/run slot. This section takes precedence over peer-only Agent clauses above.
Permission mode never grants authority or changes the selected proof.

Peer hand-back binds the current hook's entire single `agent-message` frame
to the native descendant root row: the fixed CLI 2.1.293 preamble, that exact
frame, then the fixed descendant warning. Sender attribute escaping matches
the native formatter; only the outer opening and closing frame tags may occur
at column zero. Plain peer rows, missing or changed warnings, mid-turn wrappers,
extra frames and surrounding data refuse. No report sanitizer is duplicated;
`origin.body` remains the canonical-marker proof field. Task notifications
continue to require byte-equal hook/row bodies and never accept this wrapper.

Peer hand-back requires the canonical suffix marker and native peer sender,
handback and task consistency. Completion selects the capability through the
same recorded native task_notification's tool_use_id/task_id/run_id, with
source Agent, local_agent task type, current session/generation and accepted
background execution. SendMessage reactivation uses that call's ID. Normal
producer completion drains the capability; it does not spend the report slot.

Completion requires a known native output_file. Omission from the notice is
allowed; a supplied path must match. Compare the native frame summary to the
result scalar escaped once, never to the outer Agent-finished summary. Result
markers are content: missing, mistyped, stale, duplicated, another launch's
marker and old+new combinations neither grant nor refuse authority and never
select or quarantine a launch. In particular run2 may repeat run1's marker.

The complete native user opener must be non-sidechain, promptIndex=0,
promptSource=system, turnOrigin=task_notification, with the current hook's
session/prompt/path and byte-equal body. Its origin.kind is task-notification,
producer must be session-task, and origin.runId must equal the accepted run.
Every supplied task/call identity must agree. Monitor's absent-producer
exception and peer sender fields do not apply.

Parse canonical task-id, tool-use-id, optional output-file, status, summary,
optional note, optional fixed native relayed-Artifact warning, result, optional
usage and optional worktree metadata. Summary/result are unique required
scalars. Agent usage contains numeric subagent_tokens/tool_uses/duration_ms,
without Workflow agent_count. The exact warning is the native self-closing
artifact-content-authored-by-others tag and fixed relayed-content warning;
arbitrary text is rejected. Worktree contains worktreePath followed by an
optional worktreeBranch. Paths remain inert and branch escaping is native.
Available native metadata must agree. Unknown/duplicate/reordered fields,
raw nesting and trailing material refuse the collection. Encoded report tags
remain scalar data and are not recursively parsed.

All 1–16 blocks prove before any consumption, with compatible immutable maps.
Agent uses its launch map; Bash/Workflow use the opener-completed map. Duplicate
Agent slots refuse the batch. Peer and completion race for the same slot:
first valid atomic commit wins; a distinct delivery never creates another
owner. Reobserving the same decision is idempotent. A fold retains its existing
owner/map. An unresolved tuple-bound completion quarantines its identified
launch without examining result markers; a peer fold still uses its eligible
marker. Missing inclusion cannot later promote that fold or a foreign root.
Real root ambiguity/cancellation remains authoritative, and only the admitted
root's matching native result settles it once. Producer terminal frames and
task-display removal cannot settle or revoke an already proved lease.

Acceptance includes native unset/default completion and auto hand-back,
matched legacy/unified default controls, omitted-marker completion, and native
escaping. Worktree/Artifact grammar has pin inspection and focused parser/host
coverage; separate live variants are not claimed. Deterministic tests include
missing/wrong/old/duplicate marker positives, peer-marker negatives, native
tuple and opener-run mutations separately, both route orders and races,
fold reservation, duplicate slots, mixed maps, reactivation and actual-send
validator mutations for an old source and Agent. Auto-only evidence does not
establish whole-class acceptance. Final native acceptance and independent
implementation review remain pending.

Peer opener acceptance also measures a hand-back arriving while a root is busy,
then opening its own root after that root finishes. Record whether formatting
happens on arrival or dispatch; a mid-turn-shaped row must refuse, and an actual
fold follows the existing quarantine rule. Golden row/hook bytes come from the
recorded native run with only identities and working directory redacted. Mutate
one warning character, wrapper equality, frame sender/boundaries, single-frame
count and completion body equality separately; each relevant negative must
fail before restoring the guard. The installed-pin check must fail for a changed
native artifact; it does not claim compatibility with an unmeasured platform.
