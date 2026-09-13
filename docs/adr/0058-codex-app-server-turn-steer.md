---
title: Codex app-server transport and in-flight turn steering
status: proposed
date: 2026-09-14
opened: 2026-09-14
supersedes: []
superseded_by: null
related_specs: [codex-sdk-events, protocol, protocol-inter-agent]
related_adrs: [22, 32, 33, 34, 35, 51, 55]
---

# ADR-0058 — Codex app-server transport and in-flight turn steering

## Status

Proposed for [issue #346](https://github.com/sakuraiyuta/kaoiro/issues/346).
The operator decides adoption. This document authorizes no implementation and
changes no current permission or inter-agent delivery contract.

## Context

At baseline `1715de067a5701c2bbaa0c99e9be7606b8b6ccf4`,
[CodexHost](../../wrapper/codex/src/host.ts) puts incoming instructions in
`#queue`. Its run loop awaits `#runTurn` before dequeuing another entry.
`#wake` wakes an idle loop; it cannot inject into the active execution.
The repository dependencies are pinned in `pnpm-lock.yaml` to
`@openai/codex-sdk` 0.153.4 and `@openai/codex` 0.153.4. The existing SDK path
uses a new `codex exec` process per execution. A transport replacement is
required to use app-server's bidirectional input path.

[ADR-0033](0033-permission-model-dual-axis.md) rejected direct app-server
integration for approvals because of its experimental protocol and cost.
Issue #346 introduces another reason to reconsider that cost: instructions
received while the agent works should be eligible for the active turn.
This proposal is option B in
[codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md),
but option A in the comparison below.

The live spike in Appendix A used the host CLI **0.154.0**, not the repository's
0.153.4. The director approved that measurement target. Compatibility with
0.153.4 is not established by this spike.

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

See [protocol-inter-agent](../specs/protocol-inter-agent.md) for batching and
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
ADR-0033's rejection of app-server as a transport choice; its two-axis model and
fixed approval policy remain until the separate approval decision is accepted.

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
  A 0.154.0 success must not be reported as a 0.153.4 verification.

## Appendix A — Live spike, 2026-09-14 JST

### Artifact and procedure

- Baseline repository: `1715de067a5701c2bbaa0c99e9be7606b8b6ccf4`.
- Host command: `/home/yuta/.asdf/shims/codex --version` → `codex-cli 0.154.0`.
- Executed binary:
  `/home/yuta/.asdf/installs/nodejs/24.3.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
- Binary SHA-256:
  `3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022`.
- Generated schema: `codex app-server generate-ts --out <scratch>/schema --experimental`.
  Inspected `TurnSteerParams`, `TurnSteerResponse`, `NonSteerableTurnKind`,
  `TurnStartParams`, and `UserInput` from that output.
- Scratch: `/tmp/fuji346-spike.OCjjFH`; removed after evidence extraction.
  An isolated `CODEX_HOME` used an auth-file symlink without copying credentials,
  no personal hooks/MCP configuration, `gpt-6-astra`, and medium reasoning effort.
  Each test created an ephemeral thread with minimal test instructions.
- The Python driver launched one owned `app-server --stdio` child, sent
  `initialize` then `initialized`, and created two threads sequentially.
  It denied any unexpected server request. Closing its stdin shut down the
  child. No other process was signalled.
- Tool case: start a turn requesting exactly `sleep 12`, then `ORIGINAL_TOOL`.
  On `item/started` for `commandExecution`, wait one second and send a wrong-ID
  negative control followed by the valid steer requesting `STEERED_TOOL_346`.
- Thinking case: request the sum of squares from 1 to 1000 without tools, with
  answer prefix `ORIGINAL_THINKING`. On `item/started` for `reasoning`, send the
  wrong-ID control and valid steer requesting `STEERED_THINKING_346`.
- After each `turn/completed`, send another steer to verify idle rejection.
  The driver exited 0. Its only stderr warning was refusal to create PATH
  helper aliases under a temporary Codex home; the requested command completed
  with exit 0. No unhandled error occurred.

### Observations

Times below are seconds from the driver's monotonic start, not API latency
benchmarks. Each case emitted exactly one `turn/started` and one
`turn/completed`, with the accepted steer ID matching that same turn.

| Case | Active event | Accepted | Steered user item started | Assistant output | Terminal |
| --- | --- | --- | --- | --- | --- |
| Tool | command started 5.096 | 6.098 | 16.990, after command completed 16.987 | `STEERED_TOOL_346` at 19.027 | 19.041 |
| Thinking | reasoning started 21.655 | 21.658 | 24.780 | `ORIGINAL_THINKING 333833500` at 24.769; `STEERED_THINKING_346` at 26.594 | 26.609 |

All four negative requests returned error code `-32600`: mismatched turn IDs
while active, and `no active turn to steer` after completion. Negative-control
text did not occur in either case's assistant output.

A disposable log check asserted matching acceptance IDs, one start/completion
per case, correlated input before the last answer, and all four rejections.
Removing the valid tool acceptance record made that check fail. This validates
the captured trace, not delivery guarantees under untested scheduling or failure.

Full capture SHA-256:
`47dc7bb3a507dbebf625d4bbd289ba005c1b70633137cec0c7695a40a67332c5`.
Driver SHA-256:
`b5b273b558992d6108de7aab582235009d152f3a7b2d53ee9681940634939b7f`.
The hashes identify the discarded scratch inputs; retained evidence consists of
the exact selected capture lines below. Reproduction uses the procedure above,
not an assumption that those temporary files remain available.

### Raw capture excerpts

Each line contains the driver's timestamp/direction wrapper and the unmodified
JSON-RPC message. Unselected notifications are omitted, including token deltas;
no selected message is shortened or rewritten.

```jsonl
{"t": 0.816, "direction": "send", "message": {"id": 3, "method": "turn/start", "params": {"threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "input": [{"type": "text", "text": "Execute exactly one shell command: sleep 12. Wait for its completion, then answer ORIGINAL_TOOL. Do not perform other work.", "text_elements": []}]}}}
{"t": 0.826, "direction": "recv", "message": {"method": "turn/started", "params": {"threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "turn": {"id": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "items": [], "itemsView": "notLoaded", "status": "inProgress", "error": null, "startedAt": 1789326691, "completedAt": null, "durationMs": null}}, "emittedAtMs": 1789326691295}}
{"t": 5.096, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "exec-46492a4b-4c88-4a3e-9886-e3f77205f6ee", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'sleep 12'", "cwd": "/tmp/fuji346-spike.OCjjFH", "processId": "35685", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "sleep 12"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null}, "threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "turnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "startedAtMs": 1789326695564}, "emittedAtMs": 1789326695565}}
{"t": 6.097, "direction": "send", "message": {"id": 4, "method": "turn/steer", "params": {"threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "expectedTurnId": "wrong-turn-id", "input": [{"type": "text", "text": "NEGATIVE_CONTROL_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 6.098, "direction": "recv", "message": {"error": {"code": -32600, "message": "expected active turn id `wrong-turn-id` but found `01a09c2e-8bd6-7b52-9413-f64f4136c571`"}, "id": 4}}
{"t": 6.098, "direction": "send", "message": {"id": 5, "method": "turn/steer", "params": {"threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "expectedTurnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "clientUserMessageId": "fuji346-tool", "input": [{"type": "text", "text": "Change the final answer to exactly STEERED_TOOL_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}}}
{"t": 6.098, "direction": "recv", "message": {"id": 5, "result": {"turnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571"}}}
{"t": 16.987, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "commandExecution", "id": "exec-46492a4b-4c88-4a3e-9886-e3f77205f6ee", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'sleep 12'", "cwd": "/tmp/fuji346-spike.OCjjFH", "processId": "35685", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "sleep 12"}], "aggregatedOutput": null, "exitCode": 0, "durationMs": 11891}, "threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "turnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "completedAtMs": 1789326707455}, "emittedAtMs": 1789326707455}}
{"t": 16.99, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "userMessage", "id": "01a09c2e-cb03-7b01-982f-de8f52636685", "clientId": "fuji346-tool", "content": [{"type": "text", "text": "Change the final answer to exactly STEERED_TOOL_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}, "threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "turnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "startedAtMs": 1789326707459}, "emittedAtMs": 1789326707459}}
{"t": 19.027, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg_0e68f579d63091a8016aa6f57605bc87d097612659a9c6ef16", "text": "STEERED_TOOL_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}, "threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "turnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "completedAtMs": 1789326710324}, "emittedAtMs": 1789326710324}}
{"t": 19.041, "direction": "recv", "message": {"method": "turn/completed", "params": {"threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "turn": {"id": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "items": [{"type": "agentMessage", "id": "msg_0e68f579d63091a8016aa6f57605bc87d097612659a9c6ef16", "text": "STEERED_TOOL_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}], "itemsView": "summary", "status": "completed", "error": null, "startedAt": 1789326691, "completedAt": 1789326710, "durationMs": 18219}}, "emittedAtMs": 1789326710338}}
{"t": 19.041, "direction": "send", "message": {"id": 6, "method": "turn/steer", "params": {"threadId": "01a09c2e-8bc5-7b93-a862-60f909726b00", "expectedTurnId": "01a09c2e-8bd6-7b52-9413-f64f4136c571", "input": [{"type": "text", "text": "IDLE_NEGATIVE_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 19.042, "direction": "recv", "message": {"error": {"code": -32600, "message": "no active turn to steer"}, "id": 6}}
{"t": 19.066, "direction": "send", "message": {"id": 8, "method": "turn/start", "params": {"threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "input": [{"type": "text", "text": "Without tools, reason through the sum of squares of integers from 1 to 1000, checking it two ways. Then answer ORIGINAL_THINKING followed by the result.", "text_elements": []}]}}}
{"t": 19.069, "direction": "recv", "message": {"method": "turn/started", "params": {"threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "turn": {"id": "01a09c2e-d65c-7092-b186-1de600beb988", "items": [], "itemsView": "notLoaded", "status": "inProgress", "error": null, "startedAt": 1789326710, "completedAt": null, "durationMs": null}}, "emittedAtMs": 1789326710366}}
{"t": 21.655, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "reasoning", "id": "rs_00fcd249cfa4290a016aa6f578ef7c87d099e592ece0e62cd4", "summary": [], "content": []}, "threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "turnId": "01a09c2e-d65c-7092-b186-1de600beb988", "startedAtMs": 1789326712952}, "emittedAtMs": 1789326712952}}
{"t": 21.656, "direction": "send", "message": {"id": 9, "method": "turn/steer", "params": {"threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "expectedTurnId": "wrong-turn-id", "input": [{"type": "text", "text": "NEGATIVE_CONTROL_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 21.657, "direction": "recv", "message": {"error": {"code": -32600, "message": "expected active turn id `wrong-turn-id` but found `01a09c2e-d65c-7092-b186-1de600beb988`"}, "id": 9}}
{"t": 21.657, "direction": "send", "message": {"id": 10, "method": "turn/steer", "params": {"threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "expectedTurnId": "01a09c2e-d65c-7092-b186-1de600beb988", "clientUserMessageId": "fuji346-thinking", "input": [{"type": "text", "text": "Change the final answer to exactly STEERED_THINKING_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}}}
{"t": 21.658, "direction": "recv", "message": {"id": 10, "result": {"turnId": "01a09c2e-d65c-7092-b186-1de600beb988"}}}
{"t": 24.769, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg_00fcd249cfa4290a016aa6f57bb8bc87d0b1b6f3a8e074234a", "text": "ORIGINAL_THINKING 333833500", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}, "threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "turnId": "01a09c2e-d65c-7092-b186-1de600beb988", "completedAtMs": 1789326716066}, "emittedAtMs": 1789326716066}}
{"t": 24.78, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "userMessage", "id": "01a09c2e-ecad-72a3-a0d1-3c2ba20450af", "clientId": "fuji346-thinking", "content": [{"type": "text", "text": "Change the final answer to exactly STEERED_THINKING_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}, "threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "turnId": "01a09c2e-d65c-7092-b186-1de600beb988", "startedAtMs": 1789326716077}, "emittedAtMs": 1789326716077}}
{"t": 26.594, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg_00fcd249cfa4290a016aa6f57dadf887d09bd27360ebfa3c97", "text": "STEERED_THINKING_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}, "threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "turnId": "01a09c2e-d65c-7092-b186-1de600beb988", "completedAtMs": 1789326717891}, "emittedAtMs": 1789326717892}}
{"t": 26.609, "direction": "recv", "message": {"method": "turn/completed", "params": {"threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "turn": {"id": "01a09c2e-d65c-7092-b186-1de600beb988", "items": [{"type": "agentMessage", "id": "msg_00fcd249cfa4290a016aa6f57dadf887d09bd27360ebfa3c97", "text": "STEERED_THINKING_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}], "itemsView": "summary", "status": "completed", "error": null, "startedAt": 1789326710, "completedAt": 1789326717, "durationMs": 7540}}, "emittedAtMs": 1789326717906}}
{"t": 26.609, "direction": "send", "message": {"id": 11, "method": "turn/steer", "params": {"threadId": "01a09c2e-d64a-7223-830c-69e00d3f9294", "expectedTurnId": "01a09c2e-d65c-7092-b186-1de600beb988", "input": [{"type": "text", "text": "IDLE_NEGATIVE_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 26.61, "direction": "recv", "message": {"error": {"code": -32600, "message": "no active turn to steer"}, "id": 11}}
```
