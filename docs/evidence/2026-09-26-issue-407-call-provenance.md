---
title: Tool-call provenance at engine ingress
description: Pinned Claude and Codex loopback observations and Antigravity source limits for issue 407 design round four.
status: measured
last_updated: 2026-09-26
---

# Tool-call provenance at engine ingress

Kogane performed this investigation at repository baseline
`ba696b503261db5c3af9f4806a5579b9f8f8d995`. This is separate from the previously
reviewed interrupt report. No peer has yet reviewed these new observations.
The [captured events](2026-09-26-issue-407-call-provenance.json) retain actual SDK
callback metadata and CLI events, with probe/output hashes. Model responses came
from local HTTP mocks, not a real model API. This establishes transport behavior
under the stated conditions, not the correctness of the proposed product guard.

## Artifacts and method

| Executed artifact | Version | SHA-256 |
|---|---|---|
| Claude SDK sdk.mjs | 0.3.280 | ef4c2c0fc286d8c7dab7771516cf95206f9f670e99e74dc62f245b7fc8224955 |
| SDK's linux-x64 Claude executable | 2.1.280 | 1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b |
| Codex linux-x64 executable | 0.156.1 | 0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f |

Claude used an actual `query`, in-process SDK MCP server, `canUseTool`, and
PreToolUse callback. The first mock response emitted A and B; a later response
emitted C. A's handler returned a recovery-shaped timing marker, not a real
kaoiro rejection. B awaited a manually held permission promise. The marker does
not establish actual recovery delivery/ack correctness. The second model request
occurred after A/B results, before C was emitted.

Two successful Claude runs are retained, one per configuration: default MCP tool
annotations (serial), and `readOnlyHint: true` (parallel probe only). The latter
allows B to enter permission while A's handler is still open; it does not propose
marking production send_to_agent as read-only. Both runs ended with SDK success,
process exit 0, and no stderr. Times below are milliseconds since probe start,
not latency distribution estimates.

| Observation | Serial | Parallel |
|---|---:|---:|
| B assistant tool_use observed | 380 | 352 |
| B canUseTool entered | 401 | 362 |
| A recovery marker | 393 | 366 |
| B MCP handler entered | 496 | 469 |
| C assistant tool_use observed | 509 | 482 |
| C MCP handler entered | 515 | 488 |

In each run and for A/B/C, assistant `tool_use.id`, PreToolUse `tool_use_id`,
`canUseTool.toolUseID`, and MCP handler
`extra._meta["claudecode/toolUseId"]` matched exactly. MCP `extra.requestId`
was instead 2/3/4; permission `requestId` was a different UUID. Neither request
ID is the model tool-use ID. The metadata's spelling/case is observed, not
promised by the SDK's `extra: unknown` declaration. Missing or malformed metadata
therefore cannot justify guessing a match.

The serial run is also a negative example for capture at permission alone: B's
assistant event preceded A's marker, but B's permission callback followed it.
The parallel run supplies the requested real SDK permission-wait ordering:
B issued -> B permission wait -> A result marker -> B handler; C issued later.
The current product has no new guard, so these are ordering/correlation probes,
not a claim that B was rejected and C admitted by kaoiro. That implementation
test must exercise the actual shared guard and adapters after design approval.

## Codex observations

One successful exec run and one successful app-server run used the actual pinned
binary, a loopback Responses API, and a minimal stdio MCP server that recorded
incoming JSON-RPC requests. The mock first discovered the tool, then emitted
`function_call {id: fc_kogane_A, call_id: call_kogane_A,
namespace: mcp__probe, name: send_to_agent}`. No user account/API credentials
were used. Both runs reached the actual MCP tool and completed their turn;
process exit 0. App-server was then stopped using its own spawned PID. Both
emitted the warning that helper PATH aliases cannot be created under `/tmp`;
exec also printed its stdin-reading notice. No successful-run router error.

Both MCP requests contained `_meta.callId = call_kogane_A`,
`_meta.itemId = fc_kogane_A`, and thread/session/turn metadata. These values are
distinct from MCP JSON-RPC `id: 2` and `progressToken: 1`.

- Exec JSON `item.started` exposed `item.id = item_0`, with tool name/arguments,
  but no native `callId` or native output-item ID. This run does not establish a
  mapping from item_0 to call_kogane_A. Equal arguments or arrival order cannot
  safely match concurrent identical calls.
- App-server `item/started` exposed `item.id = call_kogane_A`, with matching
  threadId/turnId. The ID join to MCP `_meta.callId` is established for this run.
  Ordering across app-server stdout, the separate MCP process, and the host
  socket was not measured. A common ID alone does not establish a snapshot at
  the earliest observation across those channels.

During harness setup an open stdin caused a timeout and early requests used an
undiscovered/incorrectly qualified tool name. Those runs did not reach tools/call
and are not evidence of missing correlation metadata. Final recorded runs used
tool discovery plus the namespace field and reached tools/call. The retained
artifacts identify those successful runs; no production code was patched.

## Source observations and remaining limits

At the baseline, Claude host.ts passes only `options.signal` from canUseTool
(1823-1824), dropping toolUseID; inter_agent_sdk.ts (65-72) drops MCP `extra`.
The SDK d.ts documents toolUseID (275-277), but leaves extra unknown (5074-5080).
Claude's host iterator (1853 onward) has a tasklist-refresh await before ordinary
event processing. Capture must run ahead of that await as well as ahead of the
permission broker, rather than only at InterAgentTool.invoke.

Codex bridge.ts passes only name/arguments to ToolHost; its `request()` awaits
socket connection before allocating a local numeric ID. ToolHost awaits its
descriptor handler, then writes the result. app_server_transport.ts (257-272)
queues notifications in beforeResponse or the async event stream. Capturing at
the projected host event is later than RPC ingress. The source does not currently
carry the observed MCP metadata into the shared handler.

Antigravity was source-reviewed only in this investigation. Its PreToolUse hook
passes stepIdx/toolCall through hook_client.ts to GateServer; gate.ts (644-659)
records the step and then awaits a permission decision. Its CLI bridge receives
tool name/base64 arguments, a per-epoch nonce, and independently allocates a local
request ID after connecting. Neither stepIdx nor a native tool-call ID is carried
to that bridge invocation (bridge.ts, customization.ts). `nonce` identifies an
epoch's endpoint, not an individual call. The eventual DONE event cannot establish
pre-permission provenance. No live Antigravity ordering/correlation claim is made.

Strict first-observation binding is therefore supportable for the measured Claude
path with explicit adapter changes and failure on missing correlation. Codex
app-server has a usable ID but still needs cross-channel boundary proof; Codex
exec and Antigravity have unresolved ID joins on current paths. A later ToolHost
snapshot does not satisfy the stronger requirement. These limits require an
operator decision in the design; they are not silently treated as solved.

The captured-event checker passed with exit 0. Removing the observed Claude MCP
tool-use ID from an in-memory copy made the same checker fail with exit 1. It
checks observed ID joins and the B/marker/C ordering, not a reimplementation of
the future admission guard. No product typecheck/full-suite claim is made for
this investigation.

The disposable probes live in `/tmp/kogane407-call-provenance.CqZxHc` during the
review so source/raw-output hashes can be checked. Kogane removes this scratch
after the review/decision closes. Probe code is not a product deliverable.
