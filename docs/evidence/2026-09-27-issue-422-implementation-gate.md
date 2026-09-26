---
title: Issue 422 notification admission implementation gate
status: blocked
last_updated: 2026-09-27
---

# Issue 422 notification admission gate

The uncommitted option-A candidate **did not pass** its required actual-CLI queue-race gate. Notification admission was not committed or pushed. The diagnostic-only change is commit `e67979d1`.

## Environment and reproduction

- SDK `@anthropic-ai/claude-agent-sdk` 0.3.280, native Claude CLI 2.1.280, actual `AgentHost`, real SDK hooks and MCP callback. The transport recorder replaced the kaoiro server; model requests were real.
- Run from `worktrees/fuji-422`: `node tmp/fuji-422/probe-implementation-bash.mjs`, `node tmp/fuji-422/probe-implementation-agent.mjs`, and `node tmp/fuji-422/probe-implementation-race.mjs`. The Agent command was run three times while adapting the observed Agent notification shape. Only processes started by these commands were stopped by host close; no PID search or signal-by-pattern was used.
- Source baseline was `e67979d1` plus the experimental patch at `tmp/fuji-422/stage-a-experimental.patch` (SHA-256 `f4c619492a4ca42ae8a62cdd432e88da7e4c2211a89353e286d17d43b610c226`). The tested `wrapper/claude-code/dist/host.js` SHA-256 was `7bbb238c79eb2fbc74f55bdc904164f0c4e7d3e9368dd8c0c028e776ece4f191`. The source files were restored to `e67979d1` after the failed gate; the patch is retained for the direction decision.

| Run | Result | Model API dispatches |
| --- | --- | ---: |
| Background Bash, no competing wrapper input | Root notification acquired a new token and sent `BACKGROUND` once | 5 |
| Background Agent, first two attempts | Child sent zero; root notification did not match the initially assumed Bash markup and sent zero | 7 + 7 |
| Background Agent, corrected candidate matching | Child sent zero with `unbound_tool_call`; root notification acquired a new token and sent `AGENT_ROOT` once | 7 |
| Background Bash with the next wrapper input already active | **Unsafe:** notification send used the wrapper token and sent `NOTIFICATION` once | 7 |

These five runs made **33** model API dispatches, counted from `[dispatch] sent anthropic-dispatch-id=` lines within each run's start/finish timestamps. The corrected Agent probe observed that an Agent notification includes `output_file` in the SDK frame, but its hook omits `<output-file>` and puts the frame's `summary` under `<result>`. The child callback carried `agent_id`; the root notification callback did not.

## Failing race trace

The race probe launched a background Bash task, allowed its wrapper turn T1 to finish, then queued a second wrapper input T2 that ran a foreground Bash command while the background task completed. The following records are from `tmp/fuji-422/implementation-race-events.jsonl` (SHA-256 `8f1ddec2471760d039f49464e7ff320ae1fa0d4d2e823ede989417ace798d27c`):

| Sequence | Observed boundary |
| ---: | --- |
| 16–18 | T1 ended; T2 began with token `4627a8c7-2a0a-4b64-9ca7-0d4898c2f221`. T2's `UserPromptSubmit.prompt_id` was `80c561a5-5c63-437a-be18-9743ca62866f`. |
| 28, 33 | The SDK emitted `task_notification`, then a notification `UserPromptSubmit` **with the same prompt ID as T2**. Its body contained the matching background task ID and tool-use ID. |
| 35–37 | The notification's `send_to_agent` `PreToolUse` also carried that prompt ID. The MCP resolver returned T2's token, and the recorder accepted one send with body `NOTIFICATION` and `in_reply_to=1`. |
| 42–43 | One ordinary result completed T2 with `result=SECOND_DONE`; `origin.kind` was absent. There was no separate notification result to attribute. |

This is a measured same-prompt fold, not an independent notification turn. Rejecting a candidate when T2 is active does not protect T2's already registered prompt ID. A model call generated after the notification can borrow T2's reply basis. The approved plan's gate requires unambiguous hook-to-tool-to-result ownership under this competition; therefore option-A admission remains disabled pending a new direction decision.

The standalone Bash and corrected Agent event logs have SHA-256 `fd4d962131029dc034c4bd3eea7e73833845a02cc24437bd2afa4c2d2c8a14f8` and `60004f8bd221825af87f21552e602b105d4c4b1f3f5526c279bfdd893d382f6e`, respectively. The raw logs and exact probe programs remain in `tmp/fuji-422` for director review; this scratch is retained only while the direction decision is pending.
