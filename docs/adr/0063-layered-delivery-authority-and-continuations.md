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
  before this work merges into `develop`; an opt-out returns to exec, which
  has no in-flight input and therefore queues (ADR-0058).
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
