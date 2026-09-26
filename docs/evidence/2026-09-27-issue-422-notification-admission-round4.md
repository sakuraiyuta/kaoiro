---
title: Issue 422 notification admission round 4
status: complete
last_updated: 2026-09-27
---

# Issue 422 notification admission round 4

## Measurement contract before implementation

The measurement enters the final built `runClaudeCli` composition. It supplies isolated CLI arguments and config, constructs real `ServerLink` and `AgentHost` instances, and delegates MCP registration to the production `buildKaoiroMcpServer`. It does not construct an `InterAgentTool` or copy the CLI's `canSendInterAgent`, Host fail-stop, turn coordinator, or inbound formatting wiring. A real peer sends ordinary envelopes through a joined server channel; the CLI receives them and forms the SDK inputs. The probe counts wrapper attempts, server acceptances, and peer deliveries separately. SDK hooks and prompt logs verify that the exact peer body, CID, and turn number reached the model input.

The observation wrappers call the original callback exactly once with the same `this` and argument identities, without an observation-only `await`, and return its value or Promise or propagate its exception unchanged. They preserve every production `createHost` option, including `prepareInput`, `onTurnStart`, `onTurnEnd`, `onPromptAdmitted`, both fail-stop callbacks, `queryOptions`, and hooks. MCP delegation forwards the inter-agent tool, Claude-only tools, and `resolveOrigin` unchanged. A controlled test pins call count, argument identity, unaffected option reference identity, return/Promise identity, and thrown errors. The exercised observer source is retained with a SHA-256. Only the deliberate barrier and interrupt in the retired-call probe alter ordering.

For (c), the observer holds an actual root `send_to_agent` invocation that arrived through the SDK MCP callback, after `resolveOrigin` supplied T1's origin and before the original `InterAgentTool.invoke`. At capture, the T1 origin must exist and have a live signal. The observer retains the original context and call; it never resolves a new origin or generates a replacement call. It triggers the CLI's interrupt path, then waits for the production `onTurnEnd` of T1 and an aborted T1 origin signal. It admits a distinct T2 through the real CLI inbound path and waits for its SDK prompt and live admitted token. Only then does it release the original invocation. The same T1 context must remain aborted, T2 must have a different live token, the original invocation must finish, and wrapper-to-server attempts from that old call must be zero. Missing capture, release, terminal event, or invocation completion is a nonzero probe failure. This is a controlled delay applied to a real SDK call, not an observed spontaneous delay.

The fail-stop negative evidence has two separate controls. The first drives a real Host failure into its CLI fail-stop callback and checks the state/error and outbound effects. The second uses a valid token in the real CLI composition, changes only the CLI admission decision, and checks that common-tool sending stops with `admission_fail_stop` and zero server attempts. A mutation removing the CLI callback connection must make this second control fail without ToolOrigins abort masking it. Together with actual SDK/MCP normal sends in (a), (b), Bash N→N2, and Agent root/child, these controls cover both sides of the production connection.

The previous round's probes omitted the production admission callback and are historical observations only. This round's native gates must be bound to the final source and built bytes; a green process without a captured (c) call or without an actual SDK prompt is not a valid result. Model API dispatches include excluded exploratory runs and are counted from SDK debug records.

## Final artifact and checks

The final product source is commit `9c66c59eccd1bb0be8103c4e7bc9837b18a843af` on `issue-422-a-landing`; design record correction `6a3405c4fc8035bad4debfa62d240af82ddfc168` changes the preliminary Agent frame probe count from six to seven dispatches. The matching source, built JavaScript, observation scripts, gate logs, and each native raw log are bound by path and SHA-256 in [the manifest](2026-09-27-issue-422-notification-admission-round4.json). `r5-verify-manifest.py` verified all 42 referenced paths (exit 0); replacing the host source hash in a copy made it exit 1. The test server was bound to `127.0.0.1:42522` and the probes used isolated Claude working directories. Only PIDs started by this investigation were signalled, by exact PID; the final probe driver signals its own PID after the observed terminal result to exercise the production CLI shutdown handler.

| Gate on this tree | Exit | Observed result |
| --- | ---: | --- |
| `pnpm --dir wrapper build` | 0 | Five wrapper packages built; no warning |
| `pnpm --dir wrapper typecheck` | 0 | Five wrapper packages; no warning |
| `pnpm --dir wrapper test` | 0 | core 270, agent-common 399, Claude 554, Codex 851, Antigravity 405 passed; 2 skipped; no Vitest unhandled error |
| `pnpm --dir runner typecheck` | 0 | No warning |
| `pnpm --dir runner test` | 0 | 774 passed; no Vitest unhandled error |
| Unchanged Kogane round-2 controlled test, SHA-256 `6df6a1dc5b8b3e10c9c1ef6b0d729298856478b390c5243cae979eefff6a3f4d` | 0 | 2 passed: normal sends 2 at basis 3; ambiguous-result stop aborts captured authority and makes 0 sends |

The wrapper test output includes model-catalog and SDK warnings; runner test output includes fixture/Node warnings. These are in the raw logs. Build and typecheck did not warn. The final built files were regenerated after the last mutation was restored; `host.js` SHA-256 is `d91b139b1f6932b94c2fcc18c7713078b513b8ee9db597a36cdfdde2ffdcb861`, `cli.js` is `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c`, and common `inter_agent.js` is `035db29fceec8cd14b06e5dce7c9c4cd9548796e1545f25f16370eaef6179aa7`.

## Final native observations

Every accepted row below enters the built `runClaudeCli`, production `AgentHost`, real `ServerLink`, native SDK/CLI, and production MCP builder. The production `canSendInterAgent` and Host fail-stop callbacks are created inside `runClaudeCli`; the probe does not provide substitutes. The observer's same-`this`/same-argument/one-call/return-and-error forwarding control exited 0. Its source hash is in the manifest.

| Probe raw suffix | Process exit | Wrapper attempts / server acceptance / peer delivery | Observation |
| --- | ---: | --- | --- |
| `r4-a-1790458897347-3720764` | 0 | notification 1 / 1 / 1 | T1 body A/turn 1 and T2 distinct body B/turn 3 exactly matched their respective prepared SDK prompts; the notification folded into T2, retaining basis 3. |
| `r4-b-1790458994998-3721099` | 0 | notification 1 / 0 / 0 | Server accepted turn 5 while SDK had received only T1 and T2 prompts. The folded call still sent basis 3 and received `stale_reply_basis(expected_peer_turn=5, supplied_basis=3)`. |
| `r4-c-1790459231785-3721735` | 0 | old T1 call 0 / 0 / 0 | Real SDK MCP callback captured T1 call at seq 15 with a live origin. T1 ended at seq 20; a distinct live T2 released the same call at seq 30 with its original signal aborted. The original invocation completed at seq 31 without a server attempt. The separate T2 control message was accepted. |
| `r4-ledger-1790459286184-3721954` | 0 | N1 `FIRST` 1 / 0 / 0; N2 `SECOND` 1 / 1 / 1 | After peer turn 3 was committed in N, N1's older basis 1 was rejected. N2 started from the completed ledger and sent basis 3. |
| `r4-agent-1790459383797-3722276` | 0 | child 0 / 0 / 0; root 1 / 1 / 1 | Child `PreToolUse` carried an `agent_id` and its call received `unbound_tool_call`; the root's independent notification token sent `AGENT_ROOT` once. |

The joined-server stale control independently sent peer turns 1 and 3 around a valid host acknowledgement, then tried a host response with basis 1. The server returned `stale_reply_basis(expected_peer_turn=3, supplied_basis=1)` and delivered the stale body zero times (process exit 0). It is counted separately from the wrapper calls above. `r5-audit.py` compared the exact prepared T1/T2 text with `UserPromptSubmit`, and asserted body, CID, turn number, fold ID, basis, server result, queued turn 5, and peer delivery for (a)/(b): exit 0. Replacing prepared body B with body X in a copy made the same verifier exit 1; the original raw bytes were not changed.

The Agent matcher accepts the two recorded frame-to-hook forms: exact omission and exact path. Focused controlled tests cover both and reject different, empty, duplicated, or malformed hook paths, a missing SDK path, a wrong session, and a wrong parent tool ID (9/9 passed). Removing only the Agent path-equality guard made the different-path test fail (focused exit 1); byte restoration made the same focused test green (exit 0). The historical SDK 0.3.280 frame at `a-agent-r3-events.jsonl` seq 28 carries a path while its hook seq 30 strictly omits the tag. A targeted `runClaudeCli` observation at `r4-agent-1790457806931-3696079-events.jsonl` seq 28/30 confirmed the second form's exact frame/hook path; that run is shape evidence, not an admission gate. The final Agent run above provides the successful root/child gate after the matcher change.

The real Host watchdog fail-stop → CLI callback control used a valid common-tool token: normal send made one outbound attempt, then watchdog stop reported `state=error` and rejected the next send with `admission_fail_stop` and zero further attempts. Changing only `canSendInterAgent` to always return true made its focused test exit 1; restoring it made the test exit 0. This token is independent of Host `ToolOrigins`, so that abort cannot hide a disconnected CLI admission callback. The common guidance now says only that the host stopped admission, covering both ambiguous-result and watchdog stops. The operator recovery steps remain in [Claude events](../reference/engines/claude-events.md#recovering-a-fail-stopped-claude-wrapper).

## Excluded probes and API use

The first final-build Agent attempt recorded a successful root send but the temporary driver waited until its own deadline because it checked `info.turnKind` instead of `info.kind`. A second Agent attempt produced the same root/child behavior and exited 0 after a manually issued SIGTERM to its exact PID. After correcting the driver, the accepted Agent row above exited 0 by its own planned shutdown. The first (c) attempt did not capture `OLD`: the model declined the prompt, and the probe exited 1; it is excluded. The next (c) row captured and released the call as required. No excluded run is counted as a passing gate.

Model API dispatches were counted from final debug lines matching `[dispatch] sent anthropic-dispatch-id=`. The targeted frame-only observation before this design approval made 7. After approval, accepted native rows made 32 (a 6, b 6, c 5, ledger 8, Agent 7); excluded attempts made 22 (Agent deadline 8, Agent manual shutdown 8, rejected c 6). Thus this implementation round used **54** dispatches after approval and **61** including the earlier frame-only observation. The manifest binds each debug log and count.
