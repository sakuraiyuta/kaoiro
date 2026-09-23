---
title: Codex app-server transport and in-flight turn steering
status: accepted
date: 2026-09-14
opened: 2026-09-14
supersedes: []
superseded_by: null
related_specs: [codex-exec-events, protocol, protocol-inter-agent]
related_adrs: [22, 32, 33, 34, 35, 51, 55]
---

# ADR-0058 — Codex app-server transport and in-flight turn steering

## Status

Accepted (operator decision 2026-09-14, on kohaku's recommendation) for
[issue #346](https://github.com/sakuraiyuta/kaoiro/issues/346): option A in
stages. Stage 1 is tracked by
[issue #348](https://github.com/sakuraiyuta/kaoiro/issues/348), which names the
official Python SDK (`sdk/python/openai_codex`, an app-server JSON-RPC client)
as the reference implementation for the TypeScript adapter; hosting the Python
SDK itself was rejected (ADR-0023 D3, ADR-0057: no second language). Accepting
this ADR authorizes Stage 1 only. Steering (Stage 2) and approvals (Stage 3)
remain separate decisions, and no current permission or inter-agent delivery
contract changes until they are accepted. The operator approved publication of
an explicit optional Stage 1 backend selector on 2026-09-18; exec remains the
default and rollback target. Stage 1 is implemented with this opt-in surface;
this is not approval to replace the default.

## Context

At baseline `1715de067a5701c2bbaa0c99e9be7606b8b6ccf4`,
[CodexHost](../../wrapper/codex/src/host.ts) puts incoming instructions in
`#queue`. Its run loop awaits `#runTurn` before dequeuing another entry.
`#wake` wakes an idle loop; it cannot inject into the active execution.
The repository dependencies are pinned in `pnpm-lock.yaml` to
`@openai/codex-sdk` 0.156.1 and `@openai/codex` 0.156.1 (moved from 0.153.4 on
2026-09-23, issue #399 -- see the note at the end of the Stage 1 blocking gate
below). The existing SDK path uses a new `codex exec` process per execution. A
transport replacement is required to use app-server's bidirectional input
path.

[ADR-0033](0033-permission-model-dual-axis.md) rejected direct app-server
integration for approvals because of its experimental protocol and cost.
Issue #346 introduces another reason to reconsider that cost: instructions
received while the agent works should be eligible for the active turn.
This proposal is option B in
[codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md),
but option A in the comparison below.

Appendix A measures the production package's **0.153.4** binary directly.
Appendix B retains the host TUI CLI **0.154.0** as a comparison. The measured
steering cases behaved alike in both versions, and their generated
`TurnSteerParams.json` and `TurnSteerResponse.json` were byte-identical.
This establishes the tested transport primitives, not complete adapter parity.

## Options

| Option | Benefit | Cost and limit |
| --- | --- | --- |
| A: app-server over stdio JSON-RPC | In-flight input, explicit interrupt, and a future approval transport | Own process/session lifecycle, request correlation, event mapping, and version compatibility; migrate existing recovery and permissions behavior |
| B: wait for SDK steering support | Retain the current published SDK integration | No known delivery date; current queue latency remains |
| C: expose queued delivery and offer interrupt/resend | Makes current behavior understandable without transport replacement | Cannot meet in-flight delivery; interrupt does not undo tool effects, and resend can repeat work |

Recommend **A in stages**, subject to operator approval. C is a possible
separately scoped interim UX improvement, not a claim that steering exists.
Keep B as the default if the operator declines the migration cost.

## Proposed design

### Transport and ownership

Use one owned app-server child with stdio JSON-RPC per CodexHost lifetime.
Initialize once, start or resume the thread, and keep reading both notifications
and server requests while turns run. Do not use `codex app-server proxy` to
attach to a shared daemon. Keep the current exec adapter available as an
explicit launch-time rollback choice; never replay an ambiguously delivered
input automatically through the other adapter.

Track these identities separately:

- Thread ID: persistent Codex conversation identity.
- App-server turn ID: correlation and `expectedTurnId` precondition.
- Host turn token: existing immutable local ownership lease.
- JSON-RPC request ID and client user-message ID: correlate an input submission
  and its observed user-message item; neither replaces a lease.

Serialize input admission, turn completion, interrupt, and shutdown decisions
through one host-owned dispatcher. Keep at most one active app-server turn.
Retain a pending input until acceptance or explicit rejection is known.
Distinguish queued, submitted, accepted, observed as input, and terminal states;
acceptance does not establish that the model has already acted on the input.

The measured CLI schema and the
[official app-server documentation](https://learn.chatgpt.com/docs/app-server)
provide `turn/steer` with `threadId`, `expectedTurnId`, and `input`, plus optional
`clientUserMessageId`; success returns `turnId`. Steering does not start a
second turn. It is not a channel for changing model, cwd, sandbox, or output
schema. Keep model/effort/permission changes at the next execution boundary,
with requested/submitted/effective distinctions from ADR-0033 and ADR-0035.
Do not steer an instruction that must run under a pending new configuration.

### Queue and steering admission

| Incoming work or state | Proposed behavior |
| --- | --- |
| Operator input, ordinary active turn, eligible configuration | Submit `turn/steer` for the captured thread/turn pair |
| No active turn | Dispatch the oldest eligible queue item through `turn/start` |
| Inter-agent injection | Keep the existing coordinator and host queue path initially |
| Review/compact active turn | Queue with a non-steerable reason |
| Input requiring a new model, permission, cwd, or schema | Queue for the next turn; never silently apply it under the old settings |
| Closed host, watchdog fail-stop, or shutdown | Use existing rejection/cancellation policy; no new steer admission |

Preserve arrival order among operator inputs with a single submission lane.
If an older operator input is already queued for a boundary, queue later
operator inputs behind it. Eligible operator steering may intentionally precede
queued IA; disclose that priority rather than promising global FIFO.

On explicit no-active-turn or expected-turn mismatch rejection, retain the input
and re-evaluate through the dispatcher; do not retry against an arbitrary newer
turn. A review/compact rejection must retain the original input and expose the
reason. The generated `NonSteerableTurnKind` is `review | compact`, and the
error type includes `activeTurnNotSteerable`; these are schema observations,
not live coverage of those two modes. Other explicit rejections must report
the actual reason; malformed input must not be retried indefinitely.

A timeout, EOF, or lost response means delivery is unknown, not rejected.
Do not both enqueue and blindly resend it. Reconcile using correlated input
items or supported history APIs; if outcome cannot be established, report the
unknown state for operator recovery. `clientUserMessageId` is useful for
correlation, but this spike did not establish idempotent retries. A successful
steer response whose turn ID differs from the requested one is a protocol
violation and must not acknowledge delivery.

Keep local-image files alive through the owning turn's terminal boundary,
including steering. Map SDK `local_image` to app-server `localImage` explicitly.
Handle notification/response races and cleanup once, with the host lifecycle
generation preventing uploads from re-entering a closed dispatcher.

### Inter-agent lease contract

The initial implementation keeps IA queued, an explicit allowed choice in
issue #346. It does not advertise mid-turn IA injection. This preserves
[issue #131](https://github.com/sakuraiyuta/kaoiro/issues/131) and
[issue #221](https://github.com/sakuraiyuta/kaoiro/issues/221) semantics:

1. [CodexInterAgentTurnCoordinator](../../wrapper/codex/src/inter_agent_turn_coordinator.ts)
   owns same-peer batches and immutable `turnToken`s; it does not coalesce
   across peers or overwrite a previous pending generation.
2. [CLI dispatch](../../wrapper/codex/src/cli.ts) registers pending injections
   for exactly the batch entering the host queue. Queue receipt alone does not
   acknowledge actual engine delivery.
3. At actual turn submission, retain the existing delivery acknowledgment
   semantics and contiguous sequence watermark. Map app-server execution to
   the existing host callbacks without synthesizing a new IA turn start for
   an operator steer.
4. Reply and terminal settlement use the exact token and conversation list.
   An unrelated active operator turn, stale tool callback, or reused conversation
   ID cannot clear a queued batch. Fan out failures only to its owned unresolved
   conversations; settle before dispatching the next batch for that peer.
5. Preserve the direct `wait_for_response` waiter path: a reply consumed as a
   tool result is not also enqueued or steered.

See [send and wait](../reference/inter-agent/send-and-wait.md) for batching and
reply semantics, and
[delivery_ack.ts](../../wrapper/agent-common/src/delivery_ack.ts) for watermark
wiring. App-server turn completion must settle an active IA batch exactly once,
even if operator steering produced multiple assistant final-answer items.

Future IA steering needs a separate ownership design: one active app-server
turn would contain several independently leased inputs, whereas the current
host exposes one active token and immutable conversation list. Simply appending
text, reassigning a queued token, or calling `onTurnStart` again is insufficient.
That design must cover lease attachment, reply attribution, accepted-but-not-
consumed input, same-CID generations, delivery acknowledgments, watchdogs, and
failure fan-out before IA steering is enabled.

### Completion and visible behavior

Use `turn/completed` as the terminal boundary, not an `agentMessage` whose phase
is `final_answer`. Appendix A observed two final-answer messages within one
steered reasoning turn. Preserve both messages in order; do not discard the
first or create a second host result prematurely. Adapt stream and transcript
projection consistently so reconnect does not duplicate or omit either item.

Present steer acceptance separately from model response. The tool probe
accepted the update while a command was running, but observed its input item
only after command completion. The reasoning probe emitted the original answer
before the steered input item, then a corrected answer in the same turn.
Neither result proves immediate interruption of an in-flight model generation
or cancellation of a tool. Emergency stop remains a separate interrupt action.

### Stages and issue split

1. **Transport migration, separate implementation issue.** Add the app-server
   adapter behind explicit selection with steering disabled. Establish parity
   for startup/resume, MCP bridge, persona/instruction injection, attachments,
   turn progress/results, usage, compaction, history restoration, error and
   watchdog handling, and permission synchronization. Keep approval `never`.
   Revisit exec-specific rollout repair rather than copying it mechanically.
   Reproduce the event-drain regression covered by the repository SDK patch;
   the replacement must not lose buffered terminal events.
   **Blocking gate:** before Stage 1 completes, either measure app-server schema
   and transport compatibility against the current production pin, 0.156.1, or
   update the production pin to the selected artifact and repeat those
   measurements against that exact artifact. Record its resolved binary path,
   SHA-256, generated schema, successful start/steer/terminal trace, and negative
   controls. Appendix A satisfies the current-pin primitive measurement with
   0.153.4; the adapter parity requirements above remain implementation gates.
   A later binary/pin change invalidates this artifact-specific evidence.
   **Pin moved 2026-09-23** (issue #399, unrelated to Stage 1/2/3 work): the
   production pin is now 0.156.1. Appendix A's 0.153.4 artifact-specific
   evidence does not apply to the current pin. `codex app-server
   generate-json-schema` was re-run offline against both binaries as part of
   #399's own verification; the diff is confined to definitions Stage 1's
   adapter does not consume (function-call-output/user-input discriminated
   unions, MCP app UI, `ThreadEnvironment`, an `originator` field) -- every
   notification `app_server_projection.ts` reads (`ItemStarted/Completed`,
   `TurnStarted/Completed`, `ContextCompacted`) is byte-identical at the top
   level between the two versions (recorded in
   [stage1-compatibility.md](../evidence/codex-app-server/stage1-compatibility.md#appendix-d--01561-pin-identity-and-schema-parity-2026-09-23)).
   This closes the schema-diff half of this gate for the 0.153.4 -> 0.156.1
   move specifically; it does not substitute for the full start/steer/terminal
   trace this gate still requires before Stage 2/3 or a default-adapter switch.
2. **Operator steering, follow-up implementation issue for issue #346.** Add
   the admission table, correlation, pending/accepted display, rejection
   fallback, and terminal semantics above. Keep IA queued and make that limit
   explicit. Test both thinking and tool-running delivery with the selected
   production CLI, not only synthetic streams.
3. **Approval requests, separate implementation issue and decision.** Only
   after transport/steer parity, design server-request correlation, operator
   authorization, pending-permission state, expiry/disconnect/cancellation,
   and response delivery. Preserve ADR-0022's authoritative state rule. Then
   propose the necessary ADR-0033 F3 change and close or revise the upstream
   approval question. A bidirectional transport alone does not enable approvals.

An IA-steering extension is a separate optional workstream after its ownership
design is accepted; it is not bundled into the transport migration. No stage
changes the Claude engine. An accepted version of this ADR would supersede only
ADR-0033's rejection of direct app-server **as an approval transport**, solely
as a reason to exclude it from this steering transport choice. This does not
approve an approval flow: its two-axis model and F3's fixed approval `never`
remain until the separate Stage 3 approval decision is accepted.

## Risks and acceptance gates

- The CLI labels app-server and schema generation experimental. Pin the actual
  executable version, generate its bindings, and check protocol compatibility
  on upgrades. The official API also distinguishes stable and opt-in
  experimental fields; do not assume every method has the same stability.
- This spike used an isolated Codex home, default stdio connection, no
  `experimentalApi` opt-in, read-only sandbox, and approval `never`. It does
  not prove production MCP, hooks, resume, approval, or recovery parity.
- Long-lived process state can differ from exec's per-turn reset. Configuration
  capture, account/model defaults, hooks, credentials refresh, and compaction
  must be measured before changing the default adapter.
- Synthetic tests must cover terminal races, explicit non-steerable rejection,
  lost acknowledgments, FIFO fallback, attachment cleanup, and unchanged IA
  leases. Include production composition paths and negative controls.
- Before rollout, repeat both live steering probes on the chosen production
  artifact and exercise review/compact fallback, resume, and interruption.
  The comparison result for 0.154.0 does not substitute for the selected
  production artifact or establish compatibility with a future upgrade.

## Appendix A — Production 0.153.4 live spike, 2026-09-14 JST

Moved to the [preserved evidence](../evidence/codex-app-server/transport-spikes-2026-09-14.md#appendix-a--production-01534-live-spike-2026-09-14-jst).

### Artifact and procedure

Moved to the [preserved evidence](../evidence/codex-app-server/transport-spikes-2026-09-14.md#artifact-and-procedure).

### Observations

Moved to the [preserved evidence](../evidence/codex-app-server/transport-spikes-2026-09-14.md#observations).

### Raw capture excerpts

Moved to the [preserved evidence](../evidence/codex-app-server/transport-spikes-2026-09-14.md#raw-capture-excerpts).

## Appendix B — Host 0.154.0 comparison

Moved to the [preserved evidence](../evidence/codex-app-server/transport-spikes-2026-09-14.md#appendix-b--host-01540-comparison).

### Comparison trace

Moved to the [preserved evidence](../evidence/codex-app-server/transport-spikes-2026-09-14.md#comparison-trace).

## Appendix C — Stage 1 compatibility gate, 2026-09-18 JST

Moved to the [preserved evidence](../evidence/codex-app-server/stage1-compatibility.md#appendix-c--stage-1-compatibility-gate-2026-09-18-jst).

### Decision boundary and artifact

Moved to the [preserved evidence](../evidence/codex-app-server/stage1-compatibility.md#decision-boundary-and-artifact).

### Reference SDK and required surface

Moved to the [preserved evidence](../evidence/codex-app-server/stage1-compatibility.md#reference-sdk-and-required-surface).

### Isolated procedure and observations

Moved to the [preserved evidence](../evidence/codex-app-server/stage1-compatibility.md#isolated-procedure-and-observations).

### Selected final capture and ExternalMessage boundary

Moved to the [preserved evidence](../evidence/codex-app-server/stage1-compatibility.md#selected-final-capture-and-externalmessage-boundary).

### Stage 1 implementation increment (3): internal session composition

Moved to the [preserved evidence](../evidence/codex-app-server/session-and-bridge.md#stage-1-implementation-increment-3-internal-session-composition).

### Increment (4a): result and progress projection

Moved to the [preserved evidence](../evidence/codex-app-server/projection-and-history.md#increment-4a-result-and-progress-projection).

### CI follow-up: required bridge startup

Moved to the [preserved evidence](../evidence/codex-app-server/session-and-bridge.md#ci-follow-up-required-bridge-startup).

### Increment (4b): telemetry and compaction

Moved to the [preserved evidence](../evidence/codex-app-server/projection-and-history.md#increment-4b-telemetry-and-compaction).

### Increment (4c): display history

Moved to the [preserved evidence](../evidence/codex-app-server/projection-and-history.md#increment-4c-display-history).

### Increment (5a): internal turn control and settings

Moved to the [preserved evidence](../evidence/codex-app-server/settings-and-permission.md#increment-5a-internal-turn-control-and-settings).

### Increment (5b): permission and settings preparation

Moved to the [preserved evidence](../evidence/codex-app-server/settings-and-permission.md#increment-5b-permission-and-settings-preparation).

### Increment (5c-1): internal Host execution runtime

Moved to the [preserved evidence](../evidence/codex-app-server/host-composition.md#increment-5c-1-internal-host-execution-runtime).

### Increment (5c-2): internal Host selection and serial execution

Moved to the [preserved evidence](../evidence/codex-app-server/host-composition.md#increment-5c-2-internal-host-selection-and-serial-execution).

### Increment (5d): internal Host history replay

Moved to the [preserved evidence](../evidence/codex-app-server/host-composition.md#increment-5d-internal-host-history-replay).

### Increment (5e): CLI, watchdog, IA and Supervisor composition

Moved to the [preserved evidence](../evidence/codex-app-server/host-composition.md#increment-5e-cli-watchdog-ia-and-supervisor-composition).

### Increment (6): explicit launch selection and rollback

Moved to the [preserved evidence](../evidence/codex-app-server/backend-rollback-artifact.md#increment-6-explicit-launch-selection-and-rollback).
