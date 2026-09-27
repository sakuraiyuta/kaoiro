---
title: Delayed inter-agent calls across SDK turn boundaries
description: Round-six actual-engine and adapter observations, origin-binding proposals, and unmeasured boundaries.
status: measured
last_updated: 2026-09-26
---

# Delayed calls across SDK turn boundaries

Design investigation at `ba696b503261db5c3af9f4806a5579b9f8f8d995`.
Kogane measured Codex; Kohaku investigated Claude and Antigravity. Product source
is unchanged. These are baseline observations, not tests of an implemented
reply-ticket or origin guard. No live model API was used in the recorded probes.
The [captured evidence](2026-09-26-issue-407-cross-turn.json) identifies executable,
build, harness and raw-output hashes. Findings do not estimate production frequency.

## Codex: actual host, CLI, bridge and shared tool

Built the isolated worktree with `pnpm --filter @kaoiro/codex... run build`
(exit 0). Used actual `CodexHost`, its default engine factories, the installed
0.156.1 binary, production ToolHost/bridge and InterAgentTool descriptors. Only
the model API and server acceptance sink were loopback/recording fixtures; the
startup rate-limit resolver returned an empty map to avoid account access.
This is not a no-injection default-constructor test. Separate fresh CODEX_HOME
directories contain no account credentials. Sandbox/network configuration is
explicit in the retained harness; model responses request only the IA tool.

An in-process test shim wraps ToolHost.listen, preserving its real server and
handlers but placing a transparent Unix socket proxy in front. tools/list passes
through. The first real bridge call_tool frame is held before the real ToolHost
receives it. A closed downstream closes its upstream; the proxy never reconnects
or replays a frame from a dead connection. The model's old body is OLD_T_REPLY.
The wrapper receives ordinary peer turns 1 and 3 on the same CID. The actual
second API request containing T2_PEER_NEW proves input reached the next engine
turn before a cross-turn release; that response stays open during release.
The recorded sink is the actual shared tool's sendInterAgent callback, with
token read from the actual host, not a manually advanced test label.

| Backend / condition | While held | Release condition | Old sends / actual token |
|---|---|---|---|
| Exec, ordinary successful completion | No terminal or next turn during 1,008 ms hold | Release in T; tool returns, T completes, then T2 starts | 1 / T, positive control |
| App-server, ordinary successful completion | No terminal or next turn during 1,007 ms hold | Release in T; tool returns, T completes, then T2 starts | 1 / T, positive control |
| Exec, interrupt | T finalizes; old socket survives | After actual T2 model request | 1 / T2: reproduced hole |
| App-server, interrupt | T finalizes; persistent socket survives | After actual T2 model request | 1 / T2: reproduced hole |
| Exec, native tool timeout followed by normal completion | Tool reports timeout; T ends with turn.completed | After T2 input; old socket is closed, so no replay | 0 |
| App-server, native tool timeout followed by normal completion | Tool reports timeout; T ends with turn.completed | After T2 input; old socket remains open | 1 / T2: reproduced hole |

Each final case is one retained run. Short controls demonstrate waiting in the
observed interval, not a universal no-timeout guarantee. The additional timeout
cases retain production's 310-second MCP setting; the actual error text is
"timed out awaiting tools/call after 310s". Observed T finalization was 334,991 ms
(exec) and 334,820 ms (app-server) after probe start. No interrupt was requested
in these two runs. The six captures end with probe completion records; the short
probe commands returned exit 0. The terminal tool session IDs for the two long
commands were unavailable at exit-code retrieval, so their shell exit codes are not
claimed; their real host turn.completed records and checker results are retained. Do not equate configured timeout with end-to-end elapsed time.

Cross-turn event times, in milliseconds since each probe's start:

| Case | T finalized | T2 model request | Old frame release | Old send |
|---|---:|---:|---:|---:|
| Exec interrupt | 950 | 1,640 | 1,647 | 1,658 |
| App-server interrupt | 959 | 1,044 | 1,047 | 1,053 |
| Exec timeout | 334,991 | 335,410 | 335,412 (closed) | None |
| App-server timeout | 334,820 | 334,863 | 334,865 | 334,868 |

The current ToolHost reads `turnSignal()` on arrival (toolhost.ts:131-175), and
the shared IA descriptor does not retain an originating engine identity. A
still-live old bridge is therefore enough to invoke a send during T2. Closing
connections when the host eventually shuts down does not prevent that send.
The server sink is recorded, not a live server admission: this experiment
establishes a wrapper send attempt, not delivery to a production peer.

### Why the timeout paths differ

Observed: exec's old bridge connection closed at 334,834 ms, before T finalized
at 334,991 ms, and a new bridge connected for T2 at 335,324 ms. App-server kept
one connection through T finalization and the late send, closing only at host
shutdown (335,394 ms). The proxy did not invent a new connection for the held call.

Source: the installed Codex SDK starts an exec child for each run and, on normal
stream exhaustion, awaits its exit (`codex-sdk/dist/index.js:262-315`). The host
resumes the same session with a fresh run for the next input. AppServerSession
instead retains its transport and ToolHost across startTurn calls; close() closes
those resources at session shutdown (`app_server_session.ts:111-146`). ToolHost
uses the signal of the turn active at arrival (`toolhost.ts:131-175`).

Inference: normal exec process/bridge teardown removed this particular old path,
whereas app-server's persistent bridge left it available. This is a lifecycle
difference, not a special check that a timeout call belongs to T. Native process
exit/PID timing was not instrumented in these runs, so the exact internal cause
of the bridge close is inferred from source plus socket observations. Exec's
interrupt run disproves a general teardown guarantee: T finalized at 950 ms,
but its old bridge stayed live through the late send at 1,658 ms and closed at
1,674 ms. Neither backend should rely on eventual process cleanup as origin
validation. A bridge timeout/result cancellation does not roll back a late side
effect in the shared handler.

### App-server native turn identity

One additional actual-host normal run records tools/call at the production
bridge's MCP SDK handler via a diagnostic preload, without altering arguments
or routing. Its `_meta["x-codex-turn-metadata"].turn_id` equals the authoritative
turn/start response ID for T, and differs from T2's. The metadata thread_id also
equals `_meta.threadId`. The existing bridge drops that metadata before ToolHost.
The response was observed before the held call in this run; arbitrary relative
ordering is not established. The design must handle MCP arriving before the
start response without assigning it to the latest turn by arrival order.

The ordinary probes' inherited diagnostic preload did not produce MCP traces;
only this additional run explicitly supplied it in the MCP child environment.
No metadata observation is inferred from the absent files. Its raw MCP frame
and native turn/start responses are retained in the evidence bundle.

## Claude: real SDK and registered tool, simulated host labels

Kohaku used SDK 0.3.280 and its CLI, the built production buildKaoiroMcpServer
and InterAgentTool, a recording send sink, and a loopback Messages API. Kogane
read the harness and updated raw captures, checked their reported SHA-256 values,
and ran Kohaku's six-record checker (exit 0); Kogane did not rerun these engines.
The two interrupt cases were repeated after correcting the release point.

| Condition | Observation | Limit |
|---|---|---|
| Normal, tools/call held | No T result or T2 start during the three-second observation; release then produced one send under T and successful completion | Claude MCP timeout path not measured |
| Interrupt, transport hold | T error result and cancellation arrived; T2 API response stayed open; old request released at 1,994 ms and send reached the sink at 1,997 ms; T2 finished afterward | Selective frame reordering; no production AgentHost |
| Interrupt, descriptor-entry hold | T2 API response stayed open; release at 1,349 ms, send at 1,351 ms, T2 finished afterward | Artificial await before the real descriptor, not an observed product wait |

In both revised interrupt cases, the pre-release checkpoint has one result (T),
zero sends and active label T+1. The post-release checkpoint still has one result
and active label T+1 but one send. Only afterward does T2 complete and the label
become null. The actual new user input appears in the captured API request.
The MCP metadata contains claudecode/toolUseId, not a native turn_id. CLI stderr
is empty. Each retained scenario has one final observation; no frequency claim.

The transport interposer holds only the tools/call line from CLI stdout and
passes later notifications/cancelled, tool_result and result frames. This is
intentional selective delay/reordering, **not FIFO pipe latency**. It establishes
that this SDK routes a request arriving after cancellation to the registered
handler; it does not establish a natural production path or frequency for that
reordering. Kohaku withdrew the earlier suggestion that a small pipe delay made
such an event rare. No FIFO control was added because no FIFO safety claim is made.

The in-handler wait is scaffolding inserted before the actual descriptor call.
getActiveInterAgentTurnToken is a manually managed label, cleared after results,
not the production AgentHost's active token. The production input barrier,
delivery ack and canUseTool permission broker are not exercised. Therefore this
is an actual-SDK/registered-tool observation of late execution, not the actual
host lifecycle reproduction performed for Codex. Neither scenario verifies the
proposed origin registry or the final pre-send guard.

## Antigravity: adapter observations, native measurement unmet

Kohaku's three earlier records use real ToolHost, real dist/bridge.js and the
shared InterAgentTool. They do not start agy. A manually advanced label names T2.

| Adapter-only case | Actual result | What it cannot establish |
|---|---|---|
| Same epoch endpoint left open after manual turn change | One send; bridge exits 0 | Whether native agy permits an old call to outlive normal completion |
| Endpoint closed before starting the bridge | No send; ENOENT, bridge exits 1 | Native interrupt/process cleanup ordering |
| Descriptor already waiting when endpoint closes | One late send; bridge loses its result with socket closed | Whether agy can produce this scheduling in the actual host |

Closing a socket does not cancel an already executing JavaScript descriptor.
Its epoch nonce cannot distinguish two turns in a surviving epoch. Those are
adapter facts, not an engine guarantee. No loopback model-endpoint override has
been established for the installed agy CLI; its help/reference omission does
not prove none can exist. The director authorized at most five live-model
executions through actual wrapper interrupt/epoch termination/respawn, with
usage/conversation-ID reporting and immediate stop if ordering was uncontrollable.

Kohaku's final report (conversation bec3dc8d-5b87-4ad7-abbf-fd4160ddfcfa,
turns 10 and 12) states **0 of 5 model executions**, no observed native conversation
ID, PID or input/output token usage, and no product edits. The reported reason is
that Kohaku's session safety guard stopped preparation of the proposed procedure.
Kogane did not independently verify the guard's details and did not rerun the
procedure or transfer it to another executor. It is not evidence of an actual
agy ordering failure: no native attempt began. Input/output usage is unobserved,
not a measured zero-token successful probe. No native run loaded global hooks,
so their effect on such a run is unmeasured as well.

Under the director's explicit submission ruling, this is an unmet native-engine
gate: **AG engine behavior is unverified; all-engine v1 deployment requires an
operator decision.** The remaining five-run allowance is not a reason to infer
success or continue via an alternate path. No actual-engine guard effectiveness
is claimed for AG. The only established AG results remain the adapter controls
and source observations above.

## Comparison of normal-end and interrupted delayed calls

| Boundary | Claude | Codex exec | Codex app-server | Antigravity |
|---|---|---|---|---|
| Normal completion while tool is held | Waited during 3 s observation | Waited during 1 s control | Waited during 1 s control | Native engine unmeasured |
| Old call after normal timeout/completion | Timeout unmeasured | Closed old socket; zero sends in observed timeout case | Persistent socket; one old send in T2 | Adapter remains receptive in the same epoch; native ordering unmeasured |
| Old call after interruption | One late send during T2 under controlled SDK scheduling/manual host label | One late send during actual host T2 | One late send during actual host T2 | Endpoint close rejects new connections; entered descriptor can still send; native host unmeasured |
| Available origin identifier | MCP tool-use ID needs host event-to-token map | Native turn metadata exists; proposed per-run endpoint avoids native ID joining | Native thread/turn metadata matches turn/start response | Existing wire carries only epoch nonce; per-turn identity unestablished |

## Proposed design implications, not implemented behavior

- Exec: one private ToolHost endpoint and immutable origin context per exec run.
  The bridge receives that endpoint at launch; retire and close it before another
  run. A pre-connect delay must still target the old path. No native call-ID join.
- App-server: preserve native thread/turn metadata in a separate bridge field;
  bind only to that turn/start response and wrapper token. Retire at terminal or
  abort. Bounded waiting for an unresolved matching start response must not use
  a later turn's identity. Connection identity alone cannot distinguish turns.
- Claude: observed native toolUseId is a candidate origin join; it must survive
  the SDK MCP adapter and link to the host's observed assistant event/token.
  An aborted MCP signal is useful but cannot replace origin binding when a
  cancellation notification precedes a delayed request.
- Antigravity: current-token injection alone repeats the reproduced Codex hole.
  An engine-origin identity or an immutable per-turn execution boundary remains
  to be established. Do not silently degrade default sends to same-turn-only.

## Verification and artifact retention

The disposable checker reads the exported evidence bundle and checks six Codex
cases, actual newer user input, event ordering, send/token counts, the extra
native-turn-ID join and the two revised Claude in-flight release orderings: exit 0.
Deleting the exec-interrupt send record in memory causes that same checker to
exit 1. Each Codex run emitted the expected unknown-auth/model-catalog warning because it
used an unauthenticated local model provider. The exec interrupt run additionally
logged its intentional AbortError. The checker validates the recorded observation
and its export, not a future product guard. Product guard mutations remain required
after implementation. No full-suite result is claimed by this investigation.

The bundle keeps Codex event/send records verbatim and only user-role API input
records; repeated model tool definitions and system context are omitted. Kohaku
records are included unchanged, with original file hashes. Its normal Claude
record predates the two revised interrupt runs and is not claimed as a rerun of
the revised harness; the retained normal observation itself is unchanged. Full
original captures, scripts, their hashes and build hashes remain available under
`/tmp/kogane407-cross-turn.bUKHrA` through review. Kogane owns that scratch and
will remove it when review/decision closes. Kohaku owns the separate collaborator
scratch. Copies of its nine scripts/raw files are retained under Kogane
`/tmp/kogane407-cross-turn.bUKHrA/peer-records` (same hashes) so Kohaku can clean up after aggregation
without removing the round-six review evidence. The scripts are disposable
measurement tools, not product deliverables.
