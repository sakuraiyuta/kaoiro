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

The driver was stopped by PID-specific SIGTERM at 11:48:06 after the repeated local rejections. The `turn_end` at 11:48:06.472 records `stream_eof` from that stop, **not** a native terminal settlement. The recorder has only result index 0 for the initial wrapper turn and no SDK result for token `0f00c5c3…`. The hand-back opener plus other-task folds needs a separate untruncated run to determine its terminal origin and report identity.

## Bound artifacts and limits

| Artifact | SHA-256 |
| --- | --- |
| `tmp/fuji-426/native-four6-events.jsonl` | `8e836d41a9d607ebe5cf8323fb58c6695829f79b6c3b5bdaf02db5fc613c84cd` |
| Claude root transcript `~/.claude/projects/-home-yuta-git-kaoiro-tmp-fuji-426-native-cwd/361fecd4-d2a8-4269-96e7-182857305cca.jsonl` | `b70f6390c670aeba558bb9dfddef1dd2e17409a5d46acf9b1bddafd2ddc7e209` |
| `wrapper/claude-code/dist/host.js` | `bb44b1d47d2d652eb8a1ec1dd39a62aa680d5c4f0f3539be1e897434c19f08bc` |
| `wrapper/claude-code/dist/cli.js` | `00daf7dca9da209c99a0dfd64458b3bf1fb3b5ca5c22a6835e33ba245576ba5c` |
| Temporary `tmp/fuji-426/native-run.mjs` | `041e266c6880d769fd7dec8dff0280ec640d6447ab0cd17f5aeeec2dee474d39` |

The temporary driver and raw logs remain in scratch until the issue's measurement and review work closes. No implementation source was committed for this observation.
