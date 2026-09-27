---
title: Inter-Agent Delivery Timing and Turn Ownership (fundamental review)
description: Re-examine the turn-boundary delivery model and the fail-closed origin binding behind issues 407, 422 and 426, against the operator's preemption proposal, before any further patching.
status: open
urgency: high
blocks: [issue-426-agent-handback-admission, issue-412]
opened: 2026-09-28
decided: 2026-09-28
---

## Background

### The problem chain

- **Until 2026-09-25.** `send_to_agent` was not bound to a turn owner. Sends
  from any continuation went through. Message crossing (below) was the open
  problem.
- **2026-09-25.** Issue 407 filed: six crossing incidents in one afternoon.
  The operator allowed a non-surgical fix.
- **2026-09-26.** Issue 407 v1 landed (production `b71674a2`): sends bound to
  a confirmed live input turn; a call with no origin is rejected locally with
  `unbound_tool_call`. Continuations the host did not inject (CLI-internal
  prompts) have no owner and cannot send.
- **2026-09-26.** Issue 422 observed: a background task's `<task-notification>`
  continuation cannot send. Regression of 407.
- **2026-09-27.** Issue 422 landed (production `26e9f192`): notification
  prompts admitted; unknown markup still fails closed. Verified with background
  Bash and one Agent; the hand-back prompt shape was not among the observed
  shapes. Hand-back continuations still cannot send.
- **2026-09-27.** Issue 426 observed: four background Agents; each
  `SubagentHandback` arrives as an `<agent-message>` prompt, unknown markup,
  no owner, send rejected. Six design revisions followed (A, A2, A3, A4, A5',
  sanitizer withdrawn, A6 pending). A2 to A4 revised identity, timing and
  lifecycle assumptions; A5' and the sanitizer round tried to reproduce
  continuation text byte by byte. (Corrected 2026-09-28 per Kogane r1 M1.)

The CLI's hand-back feature is not new: the `SubagentHandback` implementation
string is present in every locally available CLI build (2.1.274, 2.1.278,
2.1.281) and absent from the 2.0.0-era build. The version that introduced it is
unverified. The trigger was kaoiro's own design change, not a CLI change.

### The shared root

The kaoiro host models the engine as "one injected input = one SDK turn = one
token". The Claude CLI does not behave that way: it folds a mid-turn user
message into the next model request at a tool boundary, and it starts
continuations on its own (task notifications, subagent hand-backs, child
`SendMessage(to=main)`). Both the 407 fixed-snapshot basis and the 426
provenance grammar are bookkeeping that fights the engine's native model, which
is why the premises kept breaking.

### The crossing mechanism, restated

A sends x to B. While B is mid-turn on x, A sends y (usually a supplement to x
or a revocation of it). Today the host holds y until B's turn ends. B replies x'
without having seen y, then processes y. A, reading x', assumes y was lost and
resends, or B has already acted on the stale view. The recorded incidents (issue
407) include a verdict issued on retracted evidence that lifted a merge hold, a
revoked decision implemented twice, and a `done=true` riding on a reply to an
older turn. Extra round trips were the mild symptom; acting on a stale view was
the severe one.

### What was rejected on 2026-09-26, and why

The operator proposed interrupting B's turn on receipt of y. The 407 design
recorded "unconditional interruption is rejected" because the measured
interrupts do not stop external effects reliably (a running tool is SIGTERMed;
grandchildren that ignore SIGTERM survive; accepted sends and started effects
cannot be undone), and because interrupting a peer-injected turn cascades as
`peer_error: interrupted` under the current `inter_agent.ts` contract. ADR-0036
F6 was cited; it forbids combining interruption with *reset* while busy, and it
does not forbid interruption on message receipt by itself. The engine-native
alternatives (fold, `priority: 'now'`, Codex `turn/steer`, Antigravity
`PreInvocation`) were measured and deferred to issue 412 because kaoiro's own
`#waitForTurnBoundary` barrier ties turn tokens, delivery acknowledgement,
settlement and the 407 basis to turn boundaries.

Assessment (kohaku, 2026-09-28): the rejection addressed the *mechanism*
(hard interrupt), not the *intent* (put y in front of B's model before B
acts further). The intent was sound. The immediate regression mechanism was
the newly imposed host restriction; per Kogane r1 M1 this does not isolate
every contributing cause (CLI version, hooks and ordering are separate
dimensions), and incidents 5 and 6 need mutation authority rather than
faster delivery.

## Invariants the design must keep

Safety:

- S1. A reply never claims a basis (`in_reply_to`) the model composing it has
  not seen.
- S2. A tool call from one turn never silently borrows another turn's live
  token.
- S3. An accepted message is never lost: it reaches the model's context
  eventually, and exactly once as an input.
- S4. Interrupting a tool never leaves the model believing the tool completed
  normally.

Liveness:

- L1. New input is placed before the model as early as the receiving engine
  allows.
- L2. The sender learns what happened to its message (interrupted, folded,
  queued), not only that the server accepted it.
- L3. Blocked sends are a failure too. Fail closed only where a wrong send is
  worse than no send. Issues 422 and 426 show the cost of treating every unknown
  continuation as hostile.

## Options

### O1. Current design (407 snapshot, origin binding, 426 grammar)

Keep the turn-boundary barrier. Prove the provenance of every CLI continuation
shape. Six revisions so far; the envelope-only correlation A6 is pending. Cost
is high and each CLI update can invalidate the grammar.

### O2. Operator's proposal, refined in the 2026-09-28 discussion

- P1. **Sender declares intent, not mechanism.** A new inter-agent field such as
  `supersedes: <turn>` or `urgency: preempt | normal`. Default is `normal`.
  Intent lets each receiving wrapper choose the engine mechanism, and gives the
  receiving model a reason ("turn 3 is superseded") to reason about partial
  work.
- P2. **Receiver's wrapper decides.** The sender's field is a request. Receiver
  policy: preempt requests from the same conversation, from the director, or
  from the operator are honoured; others are downgraded to fold or queue. This
  keeps a peer from stalling another peer's unrelated work.
- P3. **Interrupted work is the receiver's responsibility, given the facts.**
  Partial artifacts may remain. The wrapper injects, together with y: the
  superseded turn, "results of interrupted tools are unknown; re-verify state
  before relying on them", and the PIDs of processes it started that may still
  be running (shared host: kill by PID only).
- P4. **Hybrid timing.** Wait for the tool boundary up to T seconds, then
  interrupt. A tool that finishes within T keeps its real result (S4 satisfied
  trivially).
- P5. **Capability negotiation and two-stage notice.** The wrapper declares
  `preempt` / `fold` capability at channel join (precedent:
  `inter_agent_reply_basis: v1`). The server answers a send immediately with an
  advisory: capability, the receiver's current state (idle / thinking /
  tool_running / waiting_permission), the expected delivery mode, and guidance
  ("accepted; will be shown at the next boundary; do not resend"). The receiving
  wrapper later returns the authoritative `delivered_as: interrupted | folded |
  queued`. Advisory is advisory; the ack is the record. Directory /
  `list_agents` exposes capability so a sender can decide before sending.
- P6. **Operator input defaults to preempt.**
- P7. **Codex:** the exec backend has no steer. Evaluate switching to app-server
  (`turn/steer`, measured 2/2 under `sleep 2`) in a separate issue, keeping exec
  as a configured fallback; permission and lifecycle contracts differ (issues
  366 / 367).
- P8. **Antigravity:** no clean interrupt (`control_request` ends the session
  with ERROR). `PreInvocation` injection is the candidate (measured once, first
  invocation only); otherwise queue. The two-stage notice makes the downgrade
  visible.
- P9. **Keep the 407 basis as the detection layer.** Fold shows y to the model
  but does not force it to answer y before x'. `in_reply_to` plus the server
  comparison stays; the basis advances at an *observed* fold boundary instead of
  turn end.
- P10. **Continuations bind by ledger, not by grammar.** A fresh root prompt
  that starts while no wrapper turn is live gets its own token with a snapshot
  of the completed input ledger, regardless of markup. Only session / generation
  identity is checked (issue 426 M1 stays). This subsumes A6 and drops the hand-
  back / SendMessage grammar. Open question for the reviewer: what does grammar
  provenance protect that ledger binding does not?
- P11. **ADR-0036 F6 stays** (no automatic interrupt + reset compound). No need
  to overturn it.

### O3. Bind basis to the model request, not the root prompt

The CLI folds pending inputs before each model request, so the model request is
the natural "what has the model seen" boundary. Hooks (`PreToolUse`,
`PostToolUse` `additionalContext`) fire at that granularity. Notifications and
hand-backs become "inputs included in the next model request" without any markup
proof. Unmeasured; listed as an alternative to P9 / P10.

### O4. Hard interrupt on receipt, unconditional

Recorded as rejected 2026-09-26. Kept here for completeness; P2 / P4 are its
bounded forms.

## Per-engine facts (measured 2026-09-26, see issue 412)

- **Claude (SDK 0.3.280).** Mid-turn input: folded into the next model
  request at a tool boundary as a `system-reminder`; the tool completes.
  Preempt: `priority: 'now'` cuts the turn after the running tool. Interrupt:
  `Query.interrupt()` receipt in 3-14 ms; the tool_result becomes a refusal
  text. Blocker: kaoiro `#waitForTurnBoundary`.
- **Codex app-server.** Mid-turn input: `turn/steer` (measured 2/2; the
  command was not aborted; the next request contained both). Preempt: not
  measured. Interrupt: `turn/interrupt`. Blocker: production uses the exec
  backend.
- **Codex exec.** No mid-turn input (`run` / `runStreamed` only), no preempt,
  process-level interrupt only.
- **Antigravity 1.2.11.** Mid-turn input: `PreInvocation` `injectSteps`
  (measured once, first invocation only). No preempt. No clean interrupt
  (`control_request` ends the session with ERROR). Blocker: the hook route is
  not registered.

## Test cases the chosen design must handle

1. The six issue 407 incidents (decision crossing a design post; grant not seen;
   reply to an older turn with `done=true`; verdict on retracted evidence; two
   implementations of crossed decisions; cross-thread ambiguity).
2. Issue 422: background Bash, then `send_to_agent` in the notification
   continuation.
3. Issue 426: four background Agents, hand-back prompts interleaved with
   notifications, then `send_to_agent`.
4. Same-sender supersede while the receiver is inside a long Bash (interrupt
   path, artifacts left).
5. Different-sender preempt request while the receiver works for the director
   (downgrade path).
6. Interrupt while `git push` or `send_to_agent` is in flight (result-unknown
   path, S4).
7. Preempt requested against a Codex exec / Antigravity receiver (two-stage
   notice, L2).
8. Operator message to a busy agent (P6).
9. A child `SendMessage(to=main)` and a hand-back for the same task pending
   together (426 audit found two such cases).

## Impact

Scope touches the protocol (new field, capability negotiation, ack shape),
server delivery, all three wrappers, and possibly the Codex backend choice.
Issue 426 stays frozen until this question is decided. Issue 412 is absorbed or
closed by the outcome.

## Basis for judgment

- Which invariants each option keeps, with the test cases above as the check.
- Cost already sunk in O1 is not a reason to continue it.
- Engine differences are accepted; they must be visible to senders (L2), not
  hidden.

## Provisional policy

Decided 2026-09-28 by the operator after Kogane's two review rounds:
[ADR-0063](../adr/0063-layered-delivery-authority-and-continuations.md).
The invariants above are superseded by the outcome-based set proposed in
`tmp/reviews/fundamental-review/kogane-r1.md` and adopted in the ADR.
