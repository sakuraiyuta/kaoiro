---
title: Claude notification prompt and tool boundary
description: SDK 0.3.280 hook observations for issue 422 option A.
status: measured
last_updated: 2026-09-27
---

# Claude notification prompt and tool boundary

## Baseline and method

This extends [the original actual-host reproduction](https://github.com/sakuraiyuta/kaoiro/blob/f7035c18a909bcdca5376387d7942cd57dc6fc0a/docs/evidence/2026-09-27-issue-422-notification-turn.md) without changing product source. The worktree is based on `b1d9b2e5`; `pnpm --filter @kaoiro/claude-code... build` exited 0. The three disposable probes copied the original `probe-replay.mjs` into `tmp/fuji-422/`, removed replay mode, and registered `UserPromptSubmit`, `PreToolUse`, and `Stop` hooks through the actual `AgentHost.queryOptions`. They used SDK 0.3.280, CLI 2.1.280, an isolated cwd, the real MCP registration, and the existing model account. The peer transport was a recorder. No real peer received a send. The inherited `start.baseline` field in the probe's event log still names `b71674a2`; it is a copied label, while the built source for these runs was `b1d9b2e5`.

Reproduction commands, from `worktrees/fuji-422`:

```sh
node tmp/fuji-422/probe-hooks.mjs
node tmp/fuji-422/probe-source.mjs
node tmp/fuji-422/probe-prompt.mjs
```

Each process exited 0. Each debug log recorded four Sonnet dispatches and one internal Haiku dispatch: **three SDK queries and 15 recorded model API dispatches total**. The first two probes logged only selected hook fields; the third also logged the prompt text. No additional model calls are needed for the design. All three printed the existing shadowed-`canUseTool` warning and the host's untracked-turn state warnings. Those warnings are observations, not a passing lifecycle test.

## Observation

In the third run, the explicit wrapper input triggered `UserPromptSubmit` with `prompt_id=877133bd-756d-4872-ad48-23443366bf20` (event 5). Its Bash `PreToolUse` and `Stop` used that ID (events 14 and 20). After the wrapper result and background completion, the SDK reported `system/task_notification` (event 25), then invoked `UserPromptSubmit` with a **different** `prompt_id=f6ed95fe-05f0-4822-b3c3-6daf979f596a` (event 27). The hook's `prompt` was a `<task-notification>` document with the matching task ID, tool-use ID, status, output-file path, and summary. The subsequent `send_to_agent` `PreToolUse` and `Stop` carried this second ID (events 30 and 35). `PreToolUse` preceded the MCP origin lookup; the tool still returned `unbound_tool_call`, and the final result had `origin.kind=task-notification`.

`UserPromptSubmit.source` was **absent in both the explicit and notification prompts** in the `source` and `prompt` runs, which recorded that field. The earlier `hooks` run did not record `source`, so it cannot support this claim. Its optional type declaration is not an identity signal in the two measured runs. The SDK type declares `prompt_id` as a prompt-grain correlation field and supplies it to hook callbacks; the measured sequence confirms that correlation for this one background-Bash path. The result's `origin.kind` is useful for terminal routing, but still arrives too late for admission.

The retained artifacts are:

| Probe | Program SHA-256 | Event SHA-256 | Debug SHA-256 |
| --- | --- | --- | --- |
| hooks | `fd17dfe7e4a3078f63e62653d44caaedfb4e0d472016d7feae6f32b18f43a95b` | `dd7fa4ce5ad63a4161efaca2f86dba0a4cdebf9b50a653884b3b0145f9a0f40c` | `7adcdad692e11955b5a419fb895d0118e0b156fe72034bd228b3a75d595a9693` |
| source | `de1ff79e3d444498ef6b7de1b78d2b16ef6e6caa04b24b564f506442d435fc1f` | `cd001ef6a96f88ef1a4bfb9024b8b59b3ace3e0ad087627ad576e46b15ae2b0b` | `7752f7e9b1398911381ea54879eed56bb19d0f0a906cc774d4c1493999657131` |
| prompt | `ddfba5a6b0db25200f1c5f1c23110fb1764e73f2056407b140ca960cbf8fbf8f` | `ba51f9b9d81a297ea169f6e624ba6b47a1223834c574be2f434671a428aea21d` | `1a5ba2c4962e1b40dceeeb5a74f37af3bc2f507a619b11ff8fe7254b07e02370` |

The files are disposable, worktree-local investigation artifacts. The event logs contain the synthetic prompt and model output; the debug logs are **not** part of the committed evidence and should not be copied into the repository. This experiment did not measure a queued host input racing the notification, a background Agent task, interrupt, or a subagent tool callback. Those are implementation gates, not established facts.
