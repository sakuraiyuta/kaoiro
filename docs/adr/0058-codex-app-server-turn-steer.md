---
title: Codex app-server transport and in-flight turn steering
status: accepted
date: 2026-09-14
opened: 2026-09-14
supersedes: []
superseded_by: null
related_specs: [codex-sdk-events, protocol, protocol-inter-agent]
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
contract changes until they are accepted.

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
   **Blocking gate:** before Stage 1 completes, either measure app-server schema
   and transport compatibility against the current production pin, 0.153.4, or
   update the production pin to the selected artifact and repeat those
   measurements against that exact artifact. Record its resolved binary path,
   SHA-256, generated schema, successful start/steer/terminal trace, and negative
   controls. Appendix A satisfies the current-pin primitive measurement with
   0.153.4; the adapter parity requirements above remain implementation gates.
   A later binary/pin change invalidates this artifact-specific evidence.
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

### Artifact and procedure

- Baseline repository: `1715de067a5701c2bbaa0c99e9be7606b8b6ccf4`.
- Production entry: `wrapper/codex/node_modules/@openai/codex/bin/codex.js`.
  Its platform-package resolution selects `@openai/codex-linux-x64/package.json`
  and the `vendor/x86_64-unknown-linux-musl/bin/codex` binary below. The resolved
  binary was executed directly; `--version` returned `codex-cli 0.153.4` and
  `initialize` reported 0.153.4.
- Executed binary:
  `/home/yuta/git/kaoiro/node_modules/.pnpm/@openai+codex@0.153.4-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex`.
- Binary SHA-256:
  `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`.
- Generated schema: `<binary> app-server generate-json-schema --out <scratch>/schema153 --experimental`.
  Compared the request/response schema including nested definitions with
  schema generated by the 0.154.0 binary using the same command.
- Scratch: `/tmp/fuji346-production.HyLj2N`; removed after evidence extraction.
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
| Tool | command started 4.952 | 5.954 | 16.838, after command completed 16.835 | `STEERED_TOOL_346` at 19.170 | 19.195 |
| Thinking | reasoning started 22.497 | 22.499 | 26.473 | `ORIGINAL_THINKING 333833500` at 26.462; `STEERED_THINKING_346` at 28.119 | 28.130 |

All four negative requests returned error code `-32600`: mismatched turn IDs
while active, and `no active turn to steer` after completion. Negative-control
text did not occur in either case's assistant output.

A disposable log check asserted matching acceptance IDs, one start/completion
per case, correlated input before the last answer, and all four rejections.
Removing the valid tool acceptance record made that check fail. This validates
the captured trace, not delivery guarantees under untested scheduling or failure.

Full capture SHA-256:
`dd93b8b825ceddcc507a22801d5ad738021a1505e93f2abfc4ffc7f2ac147ebe`.
Driver SHA-256:
`d08b315234d44a4a8052b02558770a5655647712c215886fc5acc24b82069b2a`.
The hashes identify the discarded scratch inputs; retained evidence consists of
the exact selected capture lines below. Reproduction uses the procedure above,
not an assumption that those temporary files remain available.

### Raw capture excerpts

Each line contains the driver's timestamp/direction wrapper and the unmodified
JSON-RPC message. Unselected notifications are omitted, including token deltas;
no selected message is shortened or rewritten.

```jsonl
{"t": 0.75, "direction": "send", "message": {"id": 3, "method": "turn/start", "params": {"threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "input": [{"type": "text", "text": "Execute exactly one shell command: sleep 12. Wait for its completion, then answer ORIGINAL_TOOL. Do not perform other work.", "text_elements": []}]}}}
{"t": 0.763, "direction": "recv", "message": {"method": "turn/started", "params": {"threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "turn": {"id": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "items": [], "itemsView": "notLoaded", "status": "inProgress", "error": null, "startedAt": 1789327121, "completedAt": null, "durationMs": null}}, "emittedAtMs": 1789327121329}}
{"t": 4.952, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "exec-f81f4875-3b43-4c59-953c-0c3b262f6f40", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'sleep 12'", "cwd": "/tmp/fuji346-production.HyLj2N", "processId": "95005", "source": "unifiedExecStartup", "status": "inProgress", "commandActions": [{"type": "unknown", "command": "sleep 12"}], "aggregatedOutput": null, "exitCode": null, "durationMs": null}, "threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "turnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "startedAtMs": 1789327125516}, "emittedAtMs": 1789327125518}}
{"t": 5.952, "direction": "send", "message": {"id": 4, "method": "turn/steer", "params": {"threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "expectedTurnId": "wrong-turn-id", "input": [{"type": "text", "text": "NEGATIVE_CONTROL_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 5.953, "direction": "recv", "message": {"error": {"code": -32600, "message": "expected active turn id `wrong-turn-id` but found `01a09c35-1ba6-77d0-aa2b-a4446c189b40`"}, "id": 4}}
{"t": 5.954, "direction": "send", "message": {"id": 5, "method": "turn/steer", "params": {"threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "expectedTurnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "clientUserMessageId": "fuji346-tool", "input": [{"type": "text", "text": "Change the final answer to exactly STEERED_TOOL_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}}}
{"t": 5.954, "direction": "recv", "message": {"id": 5, "result": {"turnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40"}}}
{"t": 16.835, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "commandExecution", "id": "exec-f81f4875-3b43-4c59-953c-0c3b262f6f40", "pluginId": null, "scriptPath": null, "command": "/bin/bash -lc 'sleep 12'", "cwd": "/tmp/fuji346-production.HyLj2N", "processId": "95005", "source": "unifiedExecStartup", "status": "completed", "commandActions": [{"type": "unknown", "command": "sleep 12"}], "aggregatedOutput": null, "exitCode": 0, "durationMs": 11884}, "threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "turnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "completedAtMs": 1789327137401}, "emittedAtMs": 1789327137401}}
{"t": 16.838, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "userMessage", "id": "01a09c35-5a7c-7600-b4aa-0828beedcc3a", "clientId": "fuji346-tool", "content": [{"type": "text", "text": "Change the final answer to exactly STEERED_TOOL_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}, "threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "turnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "startedAtMs": 1789327137404}, "emittedAtMs": 1789327137404}}
{"t": 19.17, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg_0f7beb21454f3d96016aa6f7246c9c87d0b86239cf2533af55", "text": "STEERED_TOOL_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}, "threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "turnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "completedAtMs": 1789327140641}, "emittedAtMs": 1789327140641}}
{"t": 19.195, "direction": "recv", "message": {"method": "turn/completed", "params": {"threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "turn": {"id": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "items": [{"type": "agentMessage", "id": "msg_0f7beb21454f3d96016aa6f7246c9c87d0b86239cf2533af55", "text": "STEERED_TOOL_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}], "itemsView": "summary", "status": "completed", "error": null, "startedAt": 1789327121, "completedAt": 1789327140, "durationMs": 18440}}, "emittedAtMs": 1789327140667}}
{"t": 19.195, "direction": "send", "message": {"id": 6, "method": "turn/steer", "params": {"threadId": "01a09c35-1b93-7840-82ef-cc1fe17641e8", "expectedTurnId": "01a09c35-1ba6-77d0-aa2b-a4446c189b40", "input": [{"type": "text", "text": "IDLE_NEGATIVE_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 19.197, "direction": "recv", "message": {"error": {"code": -32600, "message": "no active turn to steer"}, "id": 6}}
{"t": 19.264, "direction": "send", "message": {"id": 8, "method": "turn/start", "params": {"threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "input": [{"type": "text", "text": "Without tools, reason through the sum of squares of integers from 1 to 1000, checking it two ways. Then answer ORIGINAL_THINKING followed by the result.", "text_elements": []}]}}}
{"t": 19.288, "direction": "recv", "message": {"method": "turn/started", "params": {"threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "turn": {"id": "01a09c35-6783-78f1-ae31-66d4f723b21d", "items": [], "itemsView": "notLoaded", "status": "inProgress", "error": null, "startedAt": 1789327140, "completedAt": null, "durationMs": null}}, "emittedAtMs": 1789327140760}}
{"t": 22.497, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "reasoning", "id": "rs_0e70d333d781f155016aa6f72822d887d0aaa027c154d18695", "summary": [], "content": []}, "threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "turnId": "01a09c35-6783-78f1-ae31-66d4f723b21d", "startedAtMs": 1789327143969}, "emittedAtMs": 1789327143969}}
{"t": 22.497, "direction": "send", "message": {"id": 9, "method": "turn/steer", "params": {"threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "expectedTurnId": "wrong-turn-id", "input": [{"type": "text", "text": "NEGATIVE_CONTROL_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 22.498, "direction": "recv", "message": {"error": {"code": -32600, "message": "expected active turn id `wrong-turn-id` but found `01a09c35-6783-78f1-ae31-66d4f723b21d`"}, "id": 9}}
{"t": 22.498, "direction": "send", "message": {"id": 10, "method": "turn/steer", "params": {"threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "expectedTurnId": "01a09c35-6783-78f1-ae31-66d4f723b21d", "clientUserMessageId": "fuji346-thinking", "input": [{"type": "text", "text": "Change the final answer to exactly STEERED_THINKING_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}}}
{"t": 22.499, "direction": "recv", "message": {"id": 10, "result": {"turnId": "01a09c35-6783-78f1-ae31-66d4f723b21d"}}}
{"t": 26.462, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg_0e70d333d781f155016aa6f72c0c8887d08cc2ae06fe7c0ec5", "text": "ORIGINAL_THINKING 333833500", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}, "threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "turnId": "01a09c35-6783-78f1-ae31-66d4f723b21d", "completedAtMs": 1789327147934}, "emittedAtMs": 1789327147934}}
{"t": 26.473, "direction": "recv", "message": {"method": "item/started", "params": {"item": {"type": "userMessage", "id": "01a09c35-83a9-7dc2-b2ab-e1eccfddbb0e", "clientId": "fuji346-thinking", "content": [{"type": "text", "text": "Change the final answer to exactly STEERED_THINKING_346. This replaces the earlier answer instruction; do not run any additional commands.", "text_elements": []}]}, "threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "turnId": "01a09c35-6783-78f1-ae31-66d4f723b21d", "startedAtMs": 1789327147945}, "emittedAtMs": 1789327147945}}
{"t": 28.119, "direction": "recv", "message": {"method": "item/completed", "params": {"item": {"type": "agentMessage", "id": "msg_0e70d333d781f155016aa6f72da95887d098251ed5f2d2c6e7", "text": "STEERED_THINKING_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}, "threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "turnId": "01a09c35-6783-78f1-ae31-66d4f723b21d", "completedAtMs": 1789327149591}, "emittedAtMs": 1789327149591}}
{"t": 28.13, "direction": "recv", "message": {"method": "turn/completed", "params": {"threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "turn": {"id": "01a09c35-6783-78f1-ae31-66d4f723b21d", "items": [{"type": "agentMessage", "id": "msg_0e70d333d781f155016aa6f72da95887d098251ed5f2d2c6e7", "text": "STEERED_THINKING_346", "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null}], "itemsView": "summary", "status": "completed", "error": null, "startedAt": 1789327140, "completedAt": 1789327149, "durationMs": 8848}}, "emittedAtMs": 1789327149602}}
{"t": 28.13, "direction": "send", "message": {"id": 11, "method": "turn/steer", "params": {"threadId": "01a09c35-6749-7002-aa02-9864cfd02b41", "expectedTurnId": "01a09c35-6783-78f1-ae31-66d4f723b21d", "input": [{"type": "text", "text": "IDLE_NEGATIVE_MUST_NOT_APPEAR", "text_elements": []}]}}}
{"t": 28.131, "direction": "recv", "message": {"error": {"code": -32600, "message": "no active turn to steer"}, "id": 11}}
```

## Appendix B — Host 0.154.0 comparison

This is the host TUI installation, not kaoiro's current production package.
The same model, effort, isolated-home setup, prompts, trigger events, and
negative controls were used. Both versions showed the same behavior in these
cases: tool completion preceded the steered input item; reasoning produced the
original final answer before the steered input and revised answer; each case
retained one turn; wrong-ID and idle requests were rejected. This observation
is not a guarantee about every scheduling interleaving or protocol method.

- Entry: `/home/yuta/.asdf/shims/codex --version` → `codex-cli 0.154.0`.
- Executed binary:
  `/home/yuta/.asdf/installs/nodejs/24.3.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
- Binary SHA-256:
  `3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022`.
- Driver exited 0; only the temporary-home PATH-alias warning appeared.
  Scratch `/tmp/fuji346-spike.OCjjFH` was removed after extraction.
- Full capture SHA-256:
  `47dc7bb3a507dbebf625d4bbd289ba005c1b70633137cec0c7695a40a67332c5`.
- Driver SHA-256:
  `b5b273b558992d6108de7aab582235009d152f3a7b2d53ee9681940634939b7f`.

The two versions' generated `TurnSteerParams.json` and
`TurnSteerResponse.json`, including nested definitions, have no differences
(byte-identical). Their shared SHA-256 values are respectively:

- `2e0cdcea6a90d6c8bc584fdc2ff838e824754b1eef0d2d16aa71bec4276fef44`
- `866ba9a77c12b5d570c837d58f73bf40b24e50fa93404bdf792dd984d313b1aa`

The request requires `threadId`, `expectedTurnId`, and `input`; optional fields
include `clientUserMessageId`, `additionalContext`, and
`responsesapiClientMetadata`. This comparison covers these two generated schema
files, not the entire app-server protocol. The original 0.154.0 TypeScript
schema inspection also covered `NonSteerableTurnKind`, `TurnStartParams`,
`UserInput`, and `CodexErrorInfo`.

### Comparison trace

The exact selected 0.154.0 capture lines are retained below.

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

## Appendix C — Stage 1 compatibility gate, 2026-09-18 JST

### Decision boundary and artifact

The current production artifact supports the measured app-server transport
surface without a pin update or `experimentalApi` opt-in. This clears the
initial compatibility probe for issue #348, not the adapter parity gates.
No adapter or launch selection is implemented by this evidence update;
`codex exec` remains the default. Operator and inter-agent steering remain
disabled in the planned transport adapter. The isolated external-message
experiment below does not authorize either feature.

- Repository baseline: `d19dad9834e3fa87984c8f793c3c9e9a8ada17f8`.
- Package: `@openai/codex@0.153.4`, resolved through its installed Linux x64
  platform package, not the user's global CLI.
- Executed binary:
  `/home/yuta/git/kaoiro/node_modules/.pnpm/@openai+codex@0.153.4-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex`.
- Binary SHA-256:
  `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`.
- `--version`: `codex-cli 0.153.4` (exit 0).
- `initialize` response, with `experimentalApi: false`:

```json
{"userAgent":"fuji_348_probe/0.153.4 (Ubuntu 24.4.0; x86_64) unknown (fuji_348_probe; 1)","codexHome":"/tmp/fuji-348-probe/offline/home-run","platformFamily":"unix","platformOs":"linux"}
```

The response has no `serverInfo`; clients must not require that newer shape.
The version is present in `userAgent`. The reference Python client's fallback
handles this shape.

Schema generation used this exact binary with
`app-server generate-json-schema --out <directory>`, once without flags and
once with `--experimental` (both exit 0). For each directory, sort relative
POSIX paths of all `*.json` files lexicographically and concatenate
`SHA256(file) + "  " + relative_path + "\n"`. The table hashes that UTF-8
manifest, without including the output directory name.

| Generated bundle | JSON files | SHA-256 of manifest |
| --- | ---: | --- |
| Stable | 304 | `2a24eb10034dcb9b7cfab65ab9160cb53350e66a3668829461bcb9c8c7a1e0aa` |
| Experimental | 416 | `60c1b926bc9720e7695c23bcc6f8cb1dd7dcfa92601dd3e9d7b9267804f28c87` |

The stable `ClientRequest.json` SHA-256 is
`25bc001b5dfe3b35785597b8f9ad9e5aaf7e437331fa9921f041c9e0e03fc9f3`;
`ServerNotification.json` is
`b3e76cf11842f3e8b3270c05e000212b56eabafb0152fc38e8f920e2ef902991`.
These are whole generated files, including nested definitions. A different
binary invalidates this compatibility evidence.

### Reference SDK and required surface

Reference: OpenAI's [Python SDK at commit
9fd29dfd8c583e93855aeb2a51e1725346765162](https://github.com/openai/codex/tree/9fd29dfd8c583e93855aeb2a51e1725346765162/sdk/python/src/openai_codex),
the commit selected by tag `python-v0.154.0`. Inspection covered `client.py`,
`_message_router.py`, `_approval_mode.py`, `_inputs.py`, `api.py`, `_run.py`,
and `_runtime_requirements.py`. Its runtime minimum alone is not a
compatibility proof.

| TS adapter surface | Python reference | Fixed CLI schema / measurement |
| --- | --- | --- |
| `initialize`, then `initialized` | Client initialization and reader startup | Stable; measured with experimental capability false |
| `thread/start` | Thread creation | Stable `approvalPolicy`, `approvalsReviewer`, `developerInstructions`, `config`, `sandbox`; startup measured |
| `thread/resume`, `thread/read` | Resume and persisted history access | Stable `threadId`, `excludeTurns` / `includeTurns`; new-process resume and full read measured |
| `turn/start` | Run input conversion and turn submission | Stable `threadId`, `input`, `clientUserMessageId`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`; sequential start/terminal measured; client message correlation and all setting overrides remain adapter gates |
| `turn/interrupt` | Turn interruption | Stable `threadId`, `turnId`; runtime interruption remains a later gate |
| `thread/compact/start` | Explicit compaction | Stable `threadId`; runtime compaction remains a later gate |
| `model/list` | Model discovery | Stable method; integration remains a later gate if required by the existing catalog path |
| Responses, server requests, notifications | `client.py` reader and `_message_router.py` | Separate response `id`, server request `method` + `id`, and notification `method`; response-before/after-event races require adapter tests |
| `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/started`, `turn/completed`, `thread/tokenUsage/updated` | Turn event subscription and `_run.py` result collection | Stable notifications; observed from the real CLI using fixed local model responses |
| Command/file/MCP/reasoning progress, `thread/compacted`, error | Notification dispatch | Present in stable schema; runtime parity is not established by the text-only probe |
| `turn/start.toolOutput` | `_inputs.py` → `api.py` `ExternalMessage` conversion | Stable; isolated active-turn join measured below; excluded from the production adapter |
| `turn/steer` | Explicit steer helper | Excluded from the adapter; Appendix A retains its separate primitive measurement |

The TS implementation must retain notifications that arrive before the
`turn/start` response binds a turn id, and drain retained events before ending
a per-turn consumer. The persistent process reader must survive that consumer's
completion. Thread id, app-server turn id, host turn token, JSON-RPC request id,
and client user-message id remain separate identities.

Do not copy the Python client's default command/file approval acceptance
handler. Keep approval `never` and reviewer `user`, and reject unexpected
approval requests with a diagnostic. Its default `experimentalApi: true` is
also unnecessary for the surface measured here. Account login, goal management,
fork, and archive APIs are not migration requirements merely because the
reference SDK exposes them.

### Isolated procedure and observations

The temporary Node driver launched the resolved binary directly with
`--config approvals_reviewer="user" --config approval_policy="never"
app-server --listen stdio://`. Each child had an isolated `HOME` and
`CODEX_HOME`, no `auth.json`, and only `PATH`, `HOME`, `CODEX_HOME`, and `LANG`
in its environment. Its fixture `config.toml` deliberately retained
`approvals_reviewer = "auto_review"`; a local Responses provider and
`[analytics] enabled = false` were configured, with shell snapshots disabled.
The thread used a read-only sandbox. The driver was configured to reject unexpected server
requests; none occurred.

The final run used `unshare --user --map-root-user --net`, enabled only `lo`,
and had no network route. The fake provider ran inside that namespace at
`127.0.0.1`, returning fixed Responses SSE events. Thus this run required
neither external model service nor authentication. It proves protocol and
routing behavior, not model reasoning or real tool execution. It does not
prove the CLI never attempts outward traffic: startup behavior, including
update checks, must still be disclosed in future integration tests. Analytics
was explicitly disabled. This host allowed unprivileged network namespaces;
CI runners need not do so.

Observed results (driver exit 0, checker exit 0):

- One child completed two sequential ordinary turns, then exited 0 on stdin
  close. A second child resumed the same persisted thread, completed another
  ordinary turn and the isolated external-message experiment, then exited 0.
- Four distinct `turn/started` / `turn/completed` pairs, all completed without
  error; five local provider requests and 60 notifications. All four recorded
  rollout turn contexts had approval policy `never` and reviewer `user`.
  The fixture config still contained `auto_review`, and no auth file existed.
- No `turn/steer` request was sent. Each ordinary `turn/start` followed the
  prior terminal event. This demonstrates the probe's serial admission only;
  the production queue/lease behavior is still an adapter implementation gate.
- Initialize latency was 352 ms and 174 ms for the two children. RPC/event
  waits used a 25-second bound and shutdown a 5-second bound. These two samples
  do not establish a CI latency bound.
- Stderr contained only the known temporary-home PATH-helper warning; no
  unknown-config warning, unexpected protocol error, or unhandled exception
  occurred.
- A nonexistent thread id returned error `-32600` and created no extra turn.
  Removing all terminal notifications from the captured trace made the same
  checker exit 1; the conditional subsequent phase executed zero times.

Final evidence retained for review under `/tmp/fuji-348-probe`:

| Artifact | SHA-256 |
| --- | --- |
| `probe.mjs` | `c606d56e627143a342330d38283581dff07cfcc0aaa45066bbe3a3a92a00458f` |
| `check.py` | `ff1c31475fa0ff3f644bd60152f38cd8687ca8c081731d2031a26a948f0375d9` |
| `offline/trace.json` | `ad7a0cb9101670f80cbcf3cbbc8a313a9015c7f85c361a2f24f28451c6337088` |

The driver/checker are disposable probe tools, not shipped adapter code.
The selected capture below preserves the important wire facts after scratch
cleanup. Schema regeneration uses the commands and manifest definition above.

### Selected final capture and ExternalMessage boundary

The first ordinary turn and the isolated external-message experiment used
thread `01a0b08c-d1d7-7403-831e-1ac09eeea395`. The latter withheld the provider's
response, submitted `input: []` with `toolOutput`, then released the response.
The RPC returned the **existing** turn id. The CLI emitted a
`functionCallOutput` item between two `agentMessage` items with phase
`final_answer`, followed by one terminal notification. `thread/read` with
`includeTurns: true` retained all four items: user message, first answer,
function output, second answer. The terminal's `itemsView: "summary"` contained
only the last answer. It cannot replace the accumulated item stream when
projecting results or restoring history.

This is tool-level external content, not user authorization. The experiment
shows the wire representation and active-turn membership; it does not enable
IA steering or prove that an in-flight model request was interrupted.

```jsonl
{"direction":"send","message":{"id":3,"method":"turn/start","params":{"threadId":"00000000-0000-0000-0000-000000000000","input":[{"type":"text","text":"invalid","text_elements":[]}]}}}
{"direction":"receive","message":{"error":{"code":-32600,"message":"thread not found: 00000000-0000-0000-0000-000000000000"},"id":3}}
{"direction":"send","message":{"id":4,"method":"turn/start","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","input":[{"type":"text","text":"first","text_elements":[]}],"approvalPolicy":"never","approvalsReviewer":"user"}}}
{"direction":"receive","message":{"id":4,"result":{"turn":{"id":"01a0b08c-d1e7-72a1-932d-3fc02902981d","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0b08c-d24c-7a02-afa5-141a933cff15","clientId":null,"content":[{"type":"text","text":"first","text_elements":[]}]},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-d1e7-72a1-932d-3fc02902981d","completedAtMs":1789668414028},"emittedAtMs":1789668414033}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_1","text":"LOCAL_OK_1","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-d1e7-72a1-932d-3fc02902981d","completedAtMs":1789668414214},"emittedAtMs":1789668414218}}
{"direction":"receive","message":{"method":"turn/completed","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turn":{"id":"01a0b08c-d1e7-72a1-932d-3fc02902981d","items":[{"type":"agentMessage","id":"msg_1","text":"LOCAL_OK_1","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1789668413,"completedAt":1789668414,"durationMs":300}},"emittedAtMs":1789668414232}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"userMessage","id":"01a0b08c-e798-79c1-981b-9fdd13545165","clientId":null,"content":[{"type":"text","text":"external observation base","text_elements":[]}]},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419480},"emittedAtMs":1789668419486}}
{"direction":"send","message":{"id":11,"method":"turn/start","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","input":[],"toolOutput":{"name":"probe_external","output":"UNTRUSTED_EXTERNAL_348"}}}}
{"direction":"receive","message":{"id":11,"result":{"turn":{"id":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_4","text":"LOCAL_OK_4","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419519},"emittedAtMs":1789668419523}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"functionCallOutput","id":"fco_01a0b08c-e7bd-7010-9455-ac6128828227","name":"probe_external","namespace":null,"output":"UNTRUSTED_EXTERNAL_348"},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419534},"emittedAtMs":1789668419537}}
{"direction":"receive","message":{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg_5","text":"LOCAL_OK_5","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null},"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turnId":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","completedAtMs":1789668419716},"emittedAtMs":1789668419720}}
{"direction":"receive","message":{"method":"turn/completed","params":{"threadId":"01a0b08c-d1d7-7403-831e-1ac09eeea395","turn":{"id":"01a0b08c-e77c-7dd0-a1fe-830bcefae88c","items":[{"type":"agentMessage","id":"msg_5","text":"LOCAL_OK_5","phase":"final_answer","memoryCitation":null,"delivery":null,"questions":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1789668419,"completedAt":1789668419,"durationMs":278}},"emittedAtMs":1789668419735}}
```

### Stage 1 implementation increment (3): internal session composition

`AppServerSession` now owns the persistent transport, an optional `ToolHost`,
and thread configuration for start/resume. It uses the existing bridge and
`ToolHost.listen` socket construction unchanged. The closed input conversion
accepts text and local-image paths; developer instructions are sent as the
thread's `developerInstructions`, outside user content. Approval remains
`never` / `user`, and `experimentalApi` remains false.

These settings reproduce existing `CodexHost.run` configuration, rather than
introducing new privileges or timeout defaults:

| App-server configuration | Existing exec configuration |
| --- | --- |
| `mcp_servers.kaoiro.default_tools_approval_mode = "approve"` | Same value in `CodexHost.run` |
| `mcp_servers.kaoiro.tool_timeout_sec = 310` | `BRIDGE_TOOL_TIMEOUT_SEC`, allowing the 300-second inter-agent wait to finish |
| `features.multi_agent = internalSubagents ?? true` | `codex_internal_subagents ?? true`, explicitly enabled or disabled |
| MCP command, bridge path, private socket environment | `process.execPath`, `dist/bridge.js`, `ToolHost.listen` |

The stable generated `ThreadStartParams` / `ThreadResumeParams` schemas above
permit `config` and `developerInstructions`; `TurnStartParams.UserInput`
provides `text` and `localImage`. The Python reference's thread start/resume
and local-image conversion map to these same fields. Its default approval
handler is not reused.

The real-CLI session test uses the default executable resolution and the same
pinned 0.153.4 binary recorded above. A local Responses endpoint emits a
code-mode `exec` call invoking the actual kaoiro MCP bridge handler, then a
terminal answer. After closing the first session, a new child resumes the
persisted thread with a new private socket. Both turns execute their handler,
send decoded image data in order between user text, and include exactly one
copy of the developer instruction marker. Both rollout contexts retain
`never` / `user` despite `auto_review` in the isolated host config; no auth file
or approval request is needed. Internal subagents are explicitly true in the
first session and false in the resumed session. No subagent is spawned by this
fixture, so its observation is configuration delivery, not subagent behavior.

The test requires no external model/auth service or network namespace. Analytics
is disabled; outward CLI startup attempts remain possible, as in the original
compatibility gate. This is not a measurement of model reasoning, long-running
inter-agent waits, cancellation/watchdog handling, or non-Linux socket behavior.

This increment is still internal: `CodexHost`, package exports, and normal
launch selection remain on exec. Result/usage/compaction/history projection,
host lifecycle and inter-agent integration, and launch parity acceptance are
separate remaining increments. No steering or external-message input has been
enabled, and this increment does not change the ADR's status.

### Increment (4a): result and progress projection

The internal `AppServerSession.startProjectedTurn` wraps one raw turn stream
with `app_server_projection.ts`. Thread/turn identity gates precede item
projection; started/completed item ids deduplicate within that turn. Known
assistant, reasoning, command, file-change, MCP and web-search items reuse
the exec adapter after closed shape conversion. File-change `inProgress`
has no exec SDK counterpart, so its start is projected explicitly rather
than cast into a completed SDK item. Textual `functionCallOutput` content has
an explicit display-only mapping; unsupported item kinds are not inferred.
Plan updates use the existing bounded `normalizeTasklist` implementation.

Completed assistant items each produce a log. `turn/completed.itemsView=summary`
does not overwrite those logs. Only the matching terminal notification yields
one result, retaining completed/failed/interrupted status. The last
`final_answer` supplies result text, or the last unphased message when no final
answer exists. EOF without a terminal is an error; a retry notification is
not itself terminal. Log and result bounds reuse agent-common, including the
error-detail boundary used by `makeResult`; envelope emission remains the
future host's responsibility.

External shape references are the same pinned stable schema artifact as the
compatibility gate above: `ItemStartedNotification`, `ItemCompletedNotification`
(`ThreadItem`), `TurnStartedNotification`, `TurnCompletedNotification` (`Turn`,
`TurnStatus`), `AgentMessageDeltaNotification`, reasoning/command output delta
notifications, `McpToolCallProgressNotification`, `TurnPlanUpdatedNotification`,
and `ErrorNotification`. The schema's deprecated `FileChangeOutputDeltaNotification`
also maps to tool progress; its schema explicitly says the server no longer
emits it, so coverage is fixture-only. Final-answer selection
also follows the recorded Python reference's `_run.py` phase fallback.

The default-session integration test now takes an attachment produced by
`materializeLocalImages` and verifies its exact PNG bytes at the local Responses
endpoint. Relative paths are rejected before RPC to avoid ambiguity between
the process and thread working directories. Session close
does not remove the caller-owned materialized image.

For both start and resume, the real 0.153.4 child executes the kaoiro MCP probe
and projects its call/result logs. The local provider then supplies two ordinary
assistant messages with `phase=final_answer` in one response: both completed
rows survive, and exactly one terminal result uses the second answer. This
requires neither steering nor external-message input. Malformed/duplicate
notifications, foreign identities, interruption/failure, and missing terminals
are tested with fixtures, not claimed as live model behavior.

Telemetry/compaction (4b) and history (4c) are separate review/landing units.
Normal launch, `CodexHost`, IA lifecycle, capabilities, protocol version, and
this ADR's status remain unchanged.


### CI follow-up: required bridge startup

After (4a), the fixed local response could finish a resumed turn without an MCP
item. CI run 35274497630 attempt 4 captured `TypeError:
tools.mcp__kaoiro__probe is not a function` in the code-mode tool output;
the first turn had called the bridge successfully. The model turn still
completed. This is distinct from a sandbox failure: code-mode executed, but
its tool catalog omitted the bridge.

The same 0.153.4 binary (SHA-256 recorded above) reproduces that failure when
bridge startup is delayed 2.5 seconds. Upstream's
[optional MCP grace schema](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/config.schema.json#L6515)
defaults to 1000 ms; the
[tool catalog](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs#L173)
can omit an optional server still starting at that deadline. Both wrapper
transports had inherited that default.

The fix uses a shared `BRIDGE_MCP_POLICY` in the production exec host and
app-server session: `required = true`, `startup_timeout_sec = 30`. The
[required field](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/config.schema.json#L3211)
is supported by this pin, and 30 seconds explicitly preserves its
[existing startup timeout](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-mcp/src/rmcp_client.rs#L98).
[Required-server validation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-mcp/src/connection_manager/required.rs#L15)
waits for initialization and rejects startup on failure. No wrapper polling or
global change to other optional MCP servers is needed. Tool approval and the
310-second tool-call timeout are unchanged.

This is also a **normal launch behavior change**: exec now fails the turn if
the kaoiro bridge cannot initialize, instead of silently proceeding without
its tools. The existing `makeResult`/`error_detail` path presents that failure
to the operator; it is not a reason to retry a turn automatically. The
app-server session closes on failed thread opening and cannot submit a turn.
Its bridge-bearing thread/start and thread/resume requests allow 35 seconds
(30-second startup plus 5 seconds for the response); other RPCs retain their
25-second default. Explicit transport timeout overrides remain authoritative.

The real CLI tests use the actual SDK/exec host and app-server session with a
2.5-second delayed entry point into the built bridge. The policy still comes
from production composition. They check successful calls (including app-server
resume), and a shorter test-only startup timeout checks zero model requests
and the operator-visible exec error. Removing required is the negative control.
The 35/25-second boundaries and premature-turn rejection are tested with a
controlled child and fake clocks, rather than timing assertions on CI runners.

A separate observation was `ENOTEMPTY` during home cleanup: external plugin
clone processes could keep writing after the CLI child closed. The isolated
integration configurations now disable plugins as well as analytics.
Upstream [curated repository synchronization](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core-plugins/src/manager.rs#L693)
is gated by plugins_enabled; execve traces with plugins=false contained no
plugins-clone startup, unlike the preceding default-config capture. Production
plugin settings are unchanged. Update checks and other CLI startup traffic
remain possible. CI's PATH-alias and bundled-bubblewrap fallback warnings are
separate observations, not evidence of the missing-tool cause.

### Increment (4b): telemetry and compaction

`app_server_telemetry.ts` preserves native token counts (`last`, `total`, and
nullable `modelContextWindow`) without deriving a context percentage. The
projected turn retains its latest valid usage and emits detached snapshots.
Account notifications are routed before the transport's active-turn filter.
Start/resume performs one `account/rateLimits/read`; an RPC error means unknown
read availability, while independently observed notification buckets survive.
Connection failure is not converted to unknown. Newer reads and notifications
fence older read results. Buckets remain separate by `limitId`; credits, plan,
account identity, and opaque response fields are excluded. Only the numeric
window conversion is shared with `rollout.ts`, with exec routing and finite
out-of-range semantics pinned unchanged.

On the same pinned 0.153.4 binary (SHA-256
`56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`),
an isolated, unauthenticated home and loopback provider captured:

- One `contextCompaction` item start and matching completion, followed by that
  compaction turn's successful `turn/completed`.
- Zero `thread/compacted` notifications **in this capture**. Projection therefore
  requires only the item pair and successful terminal; a legacy companion is
  ignored as duplicate evidence, not required for completion.
- Four `account/rateLimits/updated` notifications without thread/turn ids.
  Provider headers produced `limitId=codex`, primary `usedPercent=12` /
  `windowDurationMins=300`, and secondary `34` / `10080`.
- Both `resetsAt` fields were null in this capture. The probe's reset-header
  names were not established as valid; no CLI reset-time behavior is inferred.
- `account/rateLimits/read` before and after a turn returned `-32600`,
  `codex account authentication required to read rate limits`.

Capture drained both stdout (including an unterminated final line) and child
close before saving. Probe and checker exited 0. Removing exactly the
`contextCompaction` item completion from a copy of the trace made the same checker
exit 1 (`compaction pair missing`, 1 start / 0 completions); the unchanged
original trace still exited 0. The retained notification subset in
`wrapper/codex/test/fixtures/app_server_compaction.json` is replayed through the
production projector, rather than a handwritten compaction shape.

Evidence hashes:

| Artifact | SHA-256 |
| --- | --- |
| Full trace | `a7642eb8629fc5e3ee95f21242ebcb4163100f4ff292dc7c4ce69f9f0602dc8a` |
| Probe | `b2183de9b6eccfe4021f8540fa3c3b76eb49329d944d694768b0d7aae3ab2973` |
| Checker | `4aa6c6236a5675ecfb0a29f6973bf66091a36fc8de42377a533c165fd052d47c` |

The default-session real-CLI test additionally verifies usage and account
notifications across start/resume. Successful account reads and multiple
meters remain unmeasured against a real account: tests use the generated
`GetAccountRateLimitsResponse` / `RateLimitSnapshot` schema. Invalid values and
stale-read races are also fixture tests. Manual compaction used a controlled
local response; automatic compaction and external model/account behavior are
not claimed. History (4c), host/IA integration, launch selection, protocol,
capabilities, and ADR status remain outside this increment.


### Increment (4c): display history

`app_server_history.ts` acquires metadata with `thread/read(includeTurns=false)`
before choosing a source. The generated schema defaults absent `historyMode`
to legacy and absent `itemsView` to full. Only a legacy full-item snapshot is
accepted directly; paginated mode or any summary/notLoaded turn causes a
complete switch to `thread/items/list`. Earlier full/summary rows are not mixed
with pages. Descending pages are restored to chronological order, deduplicated
by `(threadId, turnId, item.id)`, and limited by the existing exec reader's
exported `MAX_HISTORY` of 200 **display rows**, after filtering. Repeated/cyclic
cursors, pages without new identities, and a separate 100-page bound stop reads.
The last bound handles abnormal but continually changing cursors independently
of the display cap.

The returned coverage distinguishes full history, a bounded tail, and an
incomplete read with a closed reason. RPC rejection does not become an empty
full result. Disconnect/timeout remains a connection error. Live and history
share item-to-log conversion; history constructs log envelopes only. It reuses
`isFormattedInterAgentMessage`, retains both final-answer rows, and uses the
provided clock because ThreadItem/ThreadItemEntry contain no timestamp. No turn
result, lifecycle transition, acknowledgement, or compaction event is replayed.
History and live turn admission are mutually exclusive; a turn submitted during
history acquisition is rejected immediately. Close/EOF releases request waiters.

The pinned 0.153.4 binary (path and SHA-256 recorded in Appendix C above) was
measured with an isolated unauthenticated home, analytics/plugins disabled, and
a loopback provider. Three turns were persisted, the child was closed, and a
new child resumed the thread with `experimentalApi=false`. Metadata reported
`historyMode=paginated` and no embedded turns. A separate diagnostic
`includeTurns=true` read returned all three turns with `itemsView=full`, but the
reader still follows the paginated source selected by metadata.

`thread/items/list(limit=2)` worked in both ascending and descending directions:
three pages each, non-null progressing cursors on the first two, null on the
third. Each direction contained exactly the six full-read items in the expected
order. Thus pagination is measured on this pin, not merely fixture coverage.
The capture checker compared complete item/turn identities with the full read
and verified child/stdout shutdown. Removing one page item made that checker
exit 1; the original capture exited 0.

| Artifact | SHA-256 |
| --- | --- |
| `ThreadReadParams.json` | `dfe040c6ac71d30795b8be3f3ff232e66f362a37f883b491e5d1ea367f470db4` |
| `ThreadReadResponse.json` | `a76583d07f6096fee33045da2dc9caed84d858f8f2d39b37bb38528dbaf32511` |
| `ThreadItemsListParams.json` | `ff56040c327ecdd30ef02affac9bc71fab64031e8980f2b4fea9fd8a888160b4` |
| `ThreadItemsListResponse.json` | `886369490fec07067597460301b3d5c1dc9aedc41ea42522cae397d8babe6156` |
| Full history trace | `f7143042002ff87532dcca5aa45e06ace33652a846f896c7e98a4f6b7af9d1d0` |
| Probe | `462abd953953bdd5d36a587c225f7db687d68bf43c3d376b6108e0e6a5fc7195` |
| Checker | `29f33f9418c7c88bc2b3580c82120520aee3fbc03b0398a14fad542cd854cd42` |

Schemas were generated into `stable/v2` from the same pinned executable;
reference types are the corresponding v2 definitions in the official
[app-server protocol](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2.rs).
The default-session integration tests additionally read persisted assistant and
MCP output after resume, exclude injected IA text, and retain the last 200 rows
from a 205-answer local response. Legacy defaults/full views, summary/notLoaded
fallback, unknown/malformed responses, cursor failure, page-budget exhaustion,
and read/turn/close races are fixture cases rather than claimed real CLI faults.

Host and `HistoryReplayer` wiring remains stage (5); the latter's synchronous
transcript callback is not silently replaced with an asynchronous reader here.
Normal launch, protocol, capabilities, and this ADR's status remain unchanged.


The (4c) review found that the live converter's empty output conflated corrupt
known items with intentionally ignored ones. History now decodes display,
ignored, and invalid items before either snapshot or page admission. Known
assistant/user messages, commands, file changes, MCP calls, web searches, and
function outputs validate their stable display fields, including nested text
and tool result/error shapes. Invalid items report `incomplete/invalid_response`;
unknown item kinds and normal hidden items remain forward-compatible. This is
a display-boundary check, not a full schema validator for unused extensions or
MCP's explicitly arbitrary JSON content. The live converter remains unchanged.
Tests cover each known family through both history sources, retention of prior
page logs on a later invalid item, and ignored-item pagination progress.

### Increment (5a): internal turn control and settings

The transport accepts per-turn settings and a synchronous pre-dispatch admission
callback. Host token/client message id are captured separately from the RPC
request id and returned app-server turn id. Interrupts are host-token fenced:
a request before the start reply waits for the actual turn id, a buffered
terminal retires it, and repeated requests share one RPC. RPC acknowledgement
neither closes the event stream nor permits another turn. `CodexHost`, its IA
queue/lease/watchdog, and normal launch remain unconnected in this increment.

Pre-implementation measurement used the same pinned 0.153.4 binary and isolated
unauthenticated loopback provider as earlier increments. Five terminal turns
exposed their matching `turn_context` while the child stayed alive, without an
intervening history RPC. The first direct file read succeeded in each case;
this does not establish a universal flush deadline. Same-thread read-only,
workspace-write/network-off, workspace-write/network-on, then read-only policies
were observed with `never/user` throughout.

Effort is sticky: high followed by a changed model plus null or omitted effort
remained high in both provider requests and rollout. Exec with no explicit
effort used the config's medium value. Resuming the running thread with a
`model_reasoning_effort` override also retained high, even though the RPC
succeeded. Thread id/path and prior history were preserved, the next turn had a
new id, and the rollout retained its previous bytes. No MCP restart claim is
made for that probe, which configured no MCP server.

The accepted restricted contract samples `config/read(cwd)` at model-switch
submission, preferring explicit `model_reasoning_effort`, otherwise finding the
target model's `model/list.defaultReasoningEffort`, and sends a concrete effort.
It neither treats null as reset nor resumes to reset. Missing/malformed defaults,
RPC rejection, or exhausted/non-progressing catalog pages fail before dispatch
with the closed `default_effort_unavailable` reason; connection failures remain
connection errors. Host pending/rollback and operator switch-error projection
are deferred to the next increments. The exec path remains unchanged.

| Real CLI comparison | Resolved app-server effort | Fresh exec effort |
| --- | --- | --- |
| Config changed from medium to low before resolution | low | low |
| No configured effort, gpt-5.6-sol catalog default | low | low |
| Base medium; exec selects probe profile containing low | medium (base only) | low |
| Config changed medium to low after resolution | medium (sampled value) | low |

This is deliberately not universal exec equivalence. The pin rejects
`--profile` for app-server, and rejects legacy `profile`/`profiles` configuration;
its runtime profile option layers `<name>.config.toml`. Current CodexHost/SDK and
AppServerRpc do not expose/send that option, so the restricted contract removes
no current Host selection. **Profile support remains unsupported** and must be
addressed separately before exposing profile selection. The sampling-time
race in the final row is part of the contract, not an implicit reset guarantee.
The model/auth/account matrix beyond these local cases was not measured.

| Evidence / generated stable v2 schema | SHA-256 |
| --- | --- |
| Permission/sticky-effort trace | `e765a6a2695e8e85ebb02fb2ce1b3195324489896dd6f765f3c31af0b3956675` |
| Reset alternatives trace | `9c683566e3b44f736afd9137c74596fabdabd004bfca40cd6b12158768116d8c` |
| Reset probe | `c3c119a6bf49e89b9a2cb0ee3b75f2470e31e6c8011bf3fca80ea53263d1d980` |
| Reset checker | `9c3830b240eb69d37c492ed2a766c12d422499824bca9cf3f27a173bf8bea866` |
| TurnStartParams.json | `a3835e8c1e942e4b358e1a670939b89918b16c4d13105a579899892b7ade6dea` |
| TurnInterruptParams.json | `6dff382dae73d1dbc58406ed045605f647e7a49660e2540fbd2c6c24d60c5f2b` |
| TurnInterruptResponse.json | `531de6be06fe979b5963f249bab82498a175e614bf65ac12fb2e849dfe60bcf1` |
| ConfigReadParams.json | `257c54a423b47c1d209ff1076765a1564d82322fd5161670fd489a2874de1bac` |
| ConfigReadResponse.json | `bd72c94e2c7d49ead6a20bcf54afedc8db11044bf8cadb387e42135dd5d1e342` |
| ModelListParams.json | `de29a536c00a5b8f46f34dba417dabd93365305571a8ed200e33bea85db68b5a` |
| ModelListResponse.json | `c7b58b332f6cf18fd64235409a6daf27bb9e6c09d12dcd0daa2f3dc628b55f6f` |

The capture checker exited zero; replacing the observed resolved low effort
with high made it fail. The production-default session integration separately
exercises settings, rollout observation, interrupt, and subsequent turns on the
real CLI. Schema/error/race boundaries use fixtures. Shared HistoryReplayer,
protocol, capabilities, server/dashboard, and ADR status are unchanged.

### Increment (5b): permission and settings preparation

The accepted effort precedence retains an operator's explicit effort (including
compatible config effort) across model changes. The restricted default-resolution
contract above applies only to reset intent or model changes under default
intent. Successful reset records the concrete resolved receipt rather than the
catalog display default. A failed switch leaves the successful baseline intact;
rollback resends that model/effort, resolving default intent again. Initial
baseline comes from `thread/start` or `thread/resume` response model and
reasoningEffort. Unavailable baseline/default produces the existing closed switch
failure reason, never an implicit reuse of the thread's sticky settings.

Transport admission now permits asynchronous permission synchronization after
effort resolution, followed by a failure check and synchronous dispatch callback.
The latter captures the rollout cursor and independent execution id only if the
selected revision/requested axes still match `next` and the gate is unblocked.
`permission_superseded` occurs before RPC submission. The later Host integration
must prepare the same unstarted queued turn again, not retry a sent turn.
Close/EOF releases an outstanding synchronization wait.

App-server observation requires the terminal's turn id, thread id and Host token,
and fences the result against the current submission's revision/requested axes
and execution id, including after a delayed flush. Newer pending selections do
not erase valid current-execution evidence. Assessment and diagnostic strings
are shared with exec; exec's optional expected-turn-id behavior and existing
permission transitions/audit payload remain unchanged. No RPC success is
promoted to applied policy.

The production-default local-provider test observes terminal policy while the
same real child remains alive, switches workspace-write network access between
turns, rejects a prior turn id, retains explicit high effort despite a changed
config default, then restores model/effort after a provider-rejected switch. It
also resets to a changed config and re-resolves default intent on rollback.
The initial thread/start response can precede creation of the rollout file:
only the first dispatch of an explicitly fresh thread uses a fresh boundary.
The existing missing-resume-baseline rejection is retained and fixture-tested.
Fixtures additionally cover asynchronous synchronization, obsolete execution
completion, malformed/missing settings, conflicting/partial rollout records,
close/EOF, and response metadata for resume. No external model/auth/profile
behavior is claimed. Host app-server execution, queue, watchdog, history replay,
and normal launch selection are still deferred; protocol and ADR status stay
unchanged.
