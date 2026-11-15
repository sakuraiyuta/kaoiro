---
title: Turns Grok starts on its own (2026-11-15)
description: Prompt ids, permissions and cancel behind prompt-id ownership.
status: accepted
last_updated: 2026-11-15
---

# Turns Grok starts on its own

Version boundary: Grok Build 1.0.52
(`grok --no-auto-update agent --no-leader stdio`).
These results were recorded for
[issue #1128](https://github.com/sakuraiyuta/kaoiro/issues/1128) and
[issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594). They describe
the measured runs, not every prompt kind or version. Raw records stay private.

## Driven over ACP directly

A driver spoke JSON-RPC to the agent. A test plugin turned commands carrying a
marker into permission requests; the prompts asked for those commands and did
not forbid other tools.

| Question | Observation | Limit |
| --- | --- | --- |
| Can the client name a prompt? | `session/prompt` with `_meta.promptId` made Grok use that id in the queue entry, `runningPromptId`, every update's `_meta.promptId`, `turn_completed.prompt_id` and the response `_meta.promptId`. `_meta.requestId` and a top-level `messageId` were ignored. | One session, three prompts |
| Which records carry a prompt id? | `session/update` chunks and tool calls (`params._meta.promptId`); `turn_completed`, hook and summary notifications (`prompt_id`); `_x.ai/queue/changed` (`runningPromptId`, `entries[].id`). `response_completed`, `session_info_update` and `background_tasks` carry none. | Kinds seen in these runs |
| Does a permission request carry one? | No. It has `toolCall.toolCallId`; the `tool_call` update with that id and a prompt id arrived 164 ms to 172 ms earlier in all six observed requests (own and self-started). | No reversed order observed |
| What does `session/cancel` stop? | Only the running prompt. With a self-started turn running and the client's prompt queued, cancel ended the self-started turn (`MidTurnAbort`); the client's prompt then ran to `end_turn` about 5 s later. | One run |
| Can a queued prompt be cancelled? | `_x.ai/queue/remove` is not a method (`-32601`). A second `session/cancel` sent when `queue/changed` reported the client's prompt as running ended it `cancelled` 6 ms and 3 ms later. | Two runs |

## Through the wrapper (before ownership)

Earlier runs of the real wrapper, with background tasks ending naturally and a
permission-asking setup, one run each:

| Case | Observation |
| --- | --- |
| No input during the self-started turn | Its permission request was refused as out of turn; no `permission_request` envelope. |
| Next input during it | Its permission request reached the operator as a `permission_request` of the operator's turn, and its text joined that turn's result. |
| Next input, then interrupt | The cancel stopped the self-started turn; the operator's prompt did not return within the 3 s abort grace and the agent was closed. |

Earlier ACP runs for
[issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594) used prompts
that forbade other tools; the self-started turns in those runs made no tool
call, which says nothing about turns started without that instruction. With
the instruction absent, two self-started turns after a kill ran the
follow-up command the original prompt asked for.
