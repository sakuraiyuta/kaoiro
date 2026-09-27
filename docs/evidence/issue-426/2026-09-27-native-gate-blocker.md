---
title: Issue 426 native hand-back configuration and four-Agent ordering
status: preliminary
last_updated: 2026-09-27
---

# Native hand-back configuration and four-Agent ordering

The approved [admission plan](../../plans/issue-426-agent-handback-admission.md) requires a hand-back continuation in the final built `runClaudeCli` composition. An exploratory run on 2026-09-27 exposed a tool-availability difference from the [direct bundled-CLI observation](2026-09-27-handback-shapes.md). Matching the production permission configuration resolved that difference. A later four-Agent workload exposed a separate unsupported ordering. **The four-Agent admission gate has not passed; the implementation prototype must not be deployed on the strength of these runs.**

## Default-mode exploratory run

The run used `runClaudeCli` from the worktree's built `wrapper/claude-code/dist/cli.js` (SHA-256 `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c`), built `host.js` (SHA-256 `7f139d89df355f051df270122cdd2b53eb7a7dfc1b31ac64a986a7123f1f629f`), SDK 0.3.280, bundled CLI 2.1.280, a separately started Phoenix test server on loopback, the production MCP builder, and real `ServerLink` instances for root and peer. The temporary driver was `tmp/fuji-426/native-run.mjs` (SHA-256 `e584467e471709b824eea5ee0a94ddf4c3f45737a417fe0f4ef49f0bb5e0c01e`); it forwarded the production host callbacks and MCP send call while recording observations. The driver and event log are scratch artifacts, not committed verification tools.

The root's initial `UserPromptSubmit` used prompt ID `516b411d-fae4-43b4-837f-cf4bc7622abb`. The root `PreToolUse:Agent` had parent tool-use ID `toolu_01Kmcx7BeXyrHbEJLdLVAjbL`. The child Agent had task ID `a5b6277931fcec0be`; its captured hook calls were `ToolSearch`, not `SubagentHandback`. The child transcript states that `SubagentHandback` was absent from both its current tools and deferred-tool search, and it returned a normal text report. The next root continuation observed was a `<task-notification>` under prompt ID `a21a8f46-f0e9-4124-b1a7-1056f77eccf6befd`; no root `<agent-message>` was observed. Thus there is no hand-back candidate, owner, or terminal result to validate in this run.

This retry reused root and peer agent IDs from an earlier exploratory run. The server injected a reconnect/loss notice from the earlier conversation while the Agent was active. The eventual SDK result was ambiguous to the host and triggered admission fail-stop; the exact terminal ordering in this contaminated run cannot establish the proposed hand-back terminal rule. A prior exploratory run with the same driver reached a normal Agent notification, one root `send_to_agent` call, one server acceptance, and one peer delivery, but its raw event log was overwritten by the retry; its output is excluded from the durable gate claim.

The retry's event log at `tmp/fuji-426/native-run-events.jsonl` has SHA-256 `4a148181478e6cadeae14eaf1281176fcc69d93ee4ba25fe6262bbcc791047b9`; its stderr log has SHA-256 `5211d5d1832e1fc24be9cb5f9ff5438a253c57a56e519504427cde706fc0713e`. The child's actual transcript at `~/.claude/projects/-home-yuta-git-kaoiro-tmp-fuji-426-native-cwd/f99d2494-9c15-4a46-8036-8965cee6befd/subagents/agent-a5b6277931fcec0be.jsonl` has SHA-256 `9675b36917381999edc55036d07bb8a511b003e67490cb14f495f4c526cd69b6`. The driver was run against the built host bytes listed above; source edits made after that build were not part of this observation.

This run used `permission_mode=default` and `allowed_tools=["Agent", "mcp__kaoiro__send_to_agent"]`. The later production-matched runs below used `permission_mode=auto` and `allowed_tools=[]`. The observed difference is configuration-dependent in these runs; this record does not prove which individual setting controls tool exposure.

## Production-matched independent continuation

The director compared a production runner-supplied configuration with the probe and specified `permission_mode=auto`, `allowed_tools=[]`, and `model=sonnet`. `cli.ts` passes an explicit empty `allowed_tools` array through its nullish default without substituting `READ_ONLY_TOOLS`. Both reruns below used those values and a new root and peer agent ID per run. The native driver supplied only isolated config/CLI arguments and read-only observation hooks; `runClaudeCli`, `AgentHost`, the production MCP builder, the SDK/CLI, Phoenix, and both `ServerLink` instances remained the product implementations.

The single-Agent `auto1` run observed one root `PreToolUse:Agent`, one child `PreToolUse:SubagentHandback`, one fresh root `<agent-message>` prompt, and one root `<task-notification>` prompt under the same hand-back prompt ID. The host opened one independent `sdk_notification` owner for the hand-back. One root `send_to_agent` attempt received one server acceptance and one peer delivery. It exited 0 after a planned driver close. Its raw event log is `tmp/fuji-426/native-auto1-1790493715-events.jsonl`; it predates the SDK result observer and does not record `result_index` or `origin`.

The `ledger2` run first sent peer turn 1 to a fresh root in a new conversation. The server accepted that input and the root's wrapper turn completed. The child `SubagentHandback` then caused a fresh root `<agent-message>` and an independent owner. The root sent `HAND_BACK_ACCEPTED` in the **same** conversation with `in_reply_to=1` and `turn_number=2`; the server accepted it and the peer received it exactly once. The later notification joined the hand-back prompt ID. The process exited 0 after a planned driver close. This establishes the completed-input reply basis for the independent branch, not the separate four-Agent scheduling branch. Its raw event log is `tmp/fuji-426/native-ledger2-1790494020-events.jsonl` (SHA-256 `1cf01bc678fd6bc637043c75c60009062fb1c75b292bcbf1cb27485004484405`).

## Four-Agent ordering and failed send

The `four3` run gave four background Agents a read-only audit of four different reference pages. The root launched four Agents, and all four child `SubagentHandback` hooks, four root `<agent-message>` prompts, four `task_notification` frames, and four root `<task-notification>` prompts were observed. The SDK results were:

| Result index | Origin | Root ownership observed |
| ---: | --- | --- |
| 0 | absent | Initial wrapper input ended. |
| 1 | `peer` with `handback=true` | First fresh hand-back prompt was admitted independently and ended once. |
| 2 | `task-notification` | An independent notification prompt ended once. Three other hand-backs and notifications had arrived under this notification's same root prompt ID while it was live. |

The latter ordering was unsupported by the prototype under test: a hand-back tried to join an already live independent notification owner. The root `PreToolUse:mcp__kaoiro__send_to_agent` hook fired under that prompt ID. The tool returned `unbound_tool_call`; the wrapper made **zero** server send attempts, and the peer received zero messages. The model reported that send failed. This reproduces the production symptom under a four-Agent workload while preserving fail-closed authority. There was no admission fail-stop event; result index 2 had `task-notification` origin. The driver stopped its own process after recording the result. `four1` was excluded because the model declined an artificial labeling task; `four2` was excluded because an early driver close aborted a live SDK turn.

The production-sized notification-first ordering is pinned by these raw events in session `034af260-ad02-4d71-b1ba-363823595ab6`:

| UTC event time | Root prompt ID | Observed event |
| --- | --- | --- |
| 07:36:09.298–07:36:11.197 | `fbcc4cf5-4005-4e51-8e4b-903c9539c2d9` | Fresh hand-back from task `a24037533a2136b59`; one result with index 1 and `origin.kind=peer`, `handback=true`, `from=senderTaskId=a24037533a2136b59`. |
| 07:36:11.200–07:36:11.201 | `6933162c-8cc0-4e11-ad66-0587592de21f` | Notification for task `a24037533a2136b59` opened an independent `sdk_notification` owner. |
| 07:36:18.104–07:36:18.275 | `6933162c-8cc0-4e11-ad66-0587592de21f` | Hand-backs for tasks `a5d534b3f602c6a52` and `adc85c1518e6b95cb`, their notifications, then the hand-back and notification for task `af4bf647b0cf292aa`, all arrived under the still-live notification prompt ID. |
| 07:36:27.683 | `6933162c-8cc0-4e11-ad66-0587592de21f` | Root `PreToolUse:mcp__kaoiro__send_to_agent` (`toolu_013ZAiC2KaeszB5e8ErT5Tf9`) fired. Stderr recorded `reply_local_rejection`, `code=unbound_tool_call`, and `send_not_attempted=true`; the event log has no wrapper-to-server send attempt and no peer delivery. |
| 07:36:41.094–07:36:41.095 | `6933162c-8cc0-4e11-ad66-0587592de21f` | One result with index 2 and `origin.kind=task-notification`, followed by one `turn_end` for token `d2ea06c1-3d5b-4730-b46a-2ff1cf10de85`. |

This run measured the terminal origin for an independent notification owner receiving same-ID hand-backs. It did not validate hand-back admission in that owner: the attempted send was locally rejected. The subsequent [design decision](../../plans/issue-426-agent-handback-admission.md#terminal-decision) preserves the notification owner's token and basis when a validated hand-back folds into it; only a new final built native run can establish that behavior.

| Temporary artifact | SHA-256 |
| --- | --- |
| `tmp/fuji-426/native-four3-1790494840-events.jsonl` | `adc676d487e69588ff11f7300ab4f003747a4492dc56cf8e8f83a11af1b27958` |
| `tmp/fuji-426/native-four3.stdout` | `beb59207bcf065b77d238a154a3c5be6f5aa600b8e0cdd1ea05406c73461cd31` |
| `tmp/fuji-426/native-four3.stderr` | `d21114e4b18325914aacea7dbc9727dbb149ca0a45bff5299c467b068d03dd9a` |
| `tmp/fuji-426/native-run.mjs` at this run | `155d5c5e9c013dfc8ab08b6edf123e579ee0b5466ca4f6d19fcf79ecfe62ef4e` |

For `four3`, the built `host.js` SHA-256 was `7f139d89df355f051df270122cdd2b53eb7a7dfc1b31ac64a986a7123f1f629f`, and the built `cli.js` SHA-256 was `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c`. The native driver was modified between runs; each hash refers only to the identified run. The exact causal setting for `SubagentHandback` exposure remains undetermined. No source path from the prototype has been committed or released.
