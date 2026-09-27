---
title: Issue 426 four-Agent hand-back owner observation
status: preliminary
last_updated: 2026-09-27
---

# Four-Agent hand-back owner observation

This native `runClaudeCli` run used the built Claude wrapper, SDK 0.3.280 / bundled CLI 2.1.280, `model=sonnet`, `permission_mode=auto`, `allowed_tools=[]`, a loopback Phoenix server, and real `ServerLink` instances. The temporary driver checked that its peer was in the server directory before starting the root. Four background Agents performed separate read-only document checks. All times below are UTC on 2026-09-27. The [admission plan](../../plans/issue-426-agent-handback-admission.md) remained unchanged; the four-Agent gate did **not** pass.

## Independent hand-back send

The initial wrapper turn used prompt ID `ac7c33e5-e835-4e9f-8292-b185b82bf510` and token `1bb55a0b-5f55-4a5e-b451-277a2cc8b314`; SDK result index 0 ended it at 11:45:41.837. Task `aeb8b595c256b8355` had a root `PreToolUse:Agent` parent tool-use ID `toolu_01LncKRe4EyAf85FKdG2ityu`, a matching background `task_started` frame, and a child `PreToolUse:SubagentHandback` at 11:45:33.503 with child tool-use ID `toolu_01GoM9ou4becx6UcjcVqfMUJ`. The child hook session matched the root session `361fecd4-d2a8-4269-96e7-182857305cca`.

At 11:45:43.386, its root `<agent-message>` arrived under a **fresh** prompt ID `9b74e429-d9ea-4abe-ad3a-2a2142563778`. The host opened one independent `sdk_notification` owner, token `0f00c5c3-e7b4-4067-9b2e-71bbcf7cdd57`. The built path calls `toolOrigins.beginIndependent` in `host.ts` and `beginNotificationReplyInput` in `cli.ts`; the latter takes a copy of the completed-delivery ledger. This is the code path for the owner's basis, not a separate direct observation of the ledger contents in this run. No reply ticket was claimed or inherited by the hand-back. The root `PreToolUse:mcp__kaoiro__send_to_agent` used that same prompt ID at 11:45:55.720. The wrapper attempted exactly one `FOUR_AUDIT_DONE aeb8b595c256b8355` send at 11:45:59.954; the peer received it at 11:45:59.974 and the server returned `accepted` at 11:45:59.975. This establishes the fresh-ID branch's bound send, server acceptance, and peer delivery once each on the final built host in this run. It does not establish its terminal result.

## Same-ID joins after the successful send

The next three root hand-backs reused the live owner's prompt ID. The table retains the observed arrival order; task notifications did not open a new root ID.

| UTC | Root continuation at prompt `9b74e429…` |
| --- | --- |
| 11:45:59.982 | Hand-back from task `a90f0f1c2d8774e09`. |
| 11:46:00.020 | Notification for task `aeb8b595c256b8355`. |
| 11:46:00.056 | Hand-back from task `aa72865189cf4c4ad`. |
| 11:46:00.093 | Notification for task `a90f0f1c2d8774e09`. |
| 11:46:28.403 | Notification for task `aa72865189cf4c4ad`. |
| 11:46:28.443 | Hand-back from task `a639c6637360253d1`. |
| 11:46:28.481 | Notification for task `a639c6637360253d1`. |

All four tasks had distinct root `PreToolUse:Agent` parents, matching background `task_started` frames, and distinct child `PreToolUse:SubagentHandback` calls with matching task `agent_id` and root session. The recorder observed no fresh-ID root continuation while the independent owner was live: all seven later root continuation hooks reused `9b74e429…`.

Five root `PreToolUse:mcp__kaoiro__send_to_agent` hooks occurred under that prompt ID. Only the first led to a wrapper send attempt. The CLI transcript contains four later tool results with `error=unbound_tool_call` and `send_not_attempted=true`; the event recorder contains no later wrapper attempt, server acceptance, or peer delivery. The prototype accepts a same-ID hand-back fold into an independent **notification** owner, but its owner branch does not accept a second hand-back into an independent **hand-back** owner, so a later hand-back shape taints that owner. This source-level explanation is consistent with the observed local rejections; the root result for the joined turn was not measured.

The driver was stopped by PID-specific SIGTERM at 11:48:06 after the repeated local rejections. The `turn_end` at 11:48:06.472 records `stream_eof` from that stop, **not** a native terminal settlement. The recorder has only result index 0 for the initial wrapper turn and no SDK result for token `0f00c5c3…`. A separate untruncated run below measures the terminal origin and report identity.

## Four7 terminal recorder

The second run used the same built host bytes and four read-only background Agents with new root and peer IDs. The driver added one instruction to end the turn without retrying a failed send, and closed the host **after** the SDK result and matching `turn_end` had been recorded. It made no admission or terminal source change. The root wrapper input used prompt `0be03237-ef72-4134-97ba-ce494bf4aef7` and ended with result index 0 at 11:53:19.575. Its four `Agent` parent hooks and four matching background `task_started` frames preceded four child `SubagentHandback` hooks; the child hooks all carried the root session `36668690-b156-4d08-8330-56c6e52fd334` and recorder generation 0.

At 11:53:20.080, the hand-back from task `ad5c207b74e2729db` opened fresh prompt `6a300cb1-015d-41ee-a1b2-d4ca99191b3c` and independent token `58ed7e6d-b818-450d-a6a6-377656350728`. The later joins all reused that prompt ID:

| UTC | Same-ID continuation |
| --- | --- |
| 11:53:24.559 | Notification for opener task `ad5c207b74e2729db`. |
| 11:53:26.637 | Hand-back from `a99f51ae17b5416d9`. |
| 11:53:26.673 | Hand-back from `a1b7fae757caa9136`. |
| 11:53:26.709 | Notification for `a99f51ae17b5416d9`. |
| 11:53:26.745 | Notification for `a1b7fae757caa9136`. |
| 11:53:52.261 | Hand-back from `a34b3fb7d0456d929`. |
| 11:53:52.297 | Notification for `a34b3fb7d0456d929`. |

There were **zero** fresh-ID continuation prompts arriving during the live independent turn in this run. Four root `send_to_agent` hooks occurred after the other-task joins; all four returned local `unbound_tool_call` with `send_not_attempted=true` in stderr. The event log records no wrapper send attempt, server acceptance, or peer delivery for four7. This run records terminal shape; it is not a successful send gate.

At 11:54:16.525 the SDK emitted **one** result for that independent turn: `result_index=1`, `origin.kind=peer`, `origin.handback=true`, and `origin.from=origin.senderTaskId=ad5c207b74e2729db`, the **opener** task rather than any later joined task. Its `origin.body` ends with the exact line-indented report from the opener's child `SubagentHandback` tool input. The host emitted one `turn_end` for token `58ed7e6d…` at 11:54:16.526 without an admission fail-stop. This is direct terminal evidence for the hand-back-opener case with other-task hand-backs and notifications folded into the same root prompt ID. It does not show that those later hand-backs were admitted: the prototype tainted the owner and rejected every attempted send.

| Four7 artifact | SHA-256 |
| --- | --- |
| `tmp/fuji-426/native-four7-recorder-events.jsonl` | `287f598db699fc696562a6a0c832183e8281289897df534119e30059dceb6861` |
| `tmp/fuji-426/native-four7-recorder.stdout` | `414cfca16c9a49359431e150115c1bb36e86406bb8ed7818b096718ee3389480` |
| `tmp/fuji-426/native-four7-recorder.stderr` | `2d5ad44f257a1bd253b8645c11f8bca19ad10da44a8490d808d1f1638bab77c7` |
| Claude root transcript `~/.claude/projects/-home-yuta-git-kaoiro-tmp-fuji-426-native-cwd/36668690-b156-4d08-8330-56c6e52fd334.jsonl` | `01fd61e80e1847fdb442ff7a2be952975ecab478c7677f7927b8841cac1ce95b` |
| Opener child transcript `~/.claude/projects/-home-yuta-git-kaoiro-tmp-fuji-426-native-cwd/36668690-b156-4d08-8330-56c6e52fd334/subagents/agent-ad5c207b74e2729db.jsonl` | `58ce074e45d470066fc147100c5dd38753e89cc275caa01f045e31e899587fe4` |
| Temporary `tmp/fuji-426/native-run.mjs` for four7 | `44de3a9b04ce246fbf886ec992627484e82d9fc0cfddc272523cace00d72a082` |

## Bound artifacts and limits

| Artifact | SHA-256 |
| --- | --- |
| `tmp/fuji-426/native-four6-events.jsonl` | `8e836d41a9d607ebe5cf8323fb58c6695829f79b6c3b5bdaf02db5fc613c84cd` |
| Claude root transcript `~/.claude/projects/-home-yuta-git-kaoiro-tmp-fuji-426-native-cwd/361fecd4-d2a8-4269-96e7-182857305cca.jsonl` | `b70f6390c670aeba558bb9dfddef1dd2e17409a5d46acf9b1bddafd2ddc7e209` |
| `wrapper/claude-code/dist/host.js` | `bb44b1d47d2d652eb8a1ec1dd39a62aa680d5c4f0f3539be1e897434c19f08bc` |
| `wrapper/claude-code/dist/cli.js` | `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c` |
| Temporary `tmp/fuji-426/native-run.mjs` | `041e266c6880d769fd7dec8dff0280ec640d6447ab0cd17f5aeeec2dee474d39` |

The temporary driver and raw logs remain in scratch until the issue's measurement and review work closes. No implementation source was committed for this observation.
