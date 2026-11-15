---
title: Killing an interrupted turn's background tasks (2026-11-15)
description: task/list, task/kill, ownership through tool calls and the turns Grok starts after a kill.
status: accepted
last_updated: 2026-11-15
---

# Killing an interrupted turn's background tasks

Version boundary: Grok Build 1.0.52
(`grok --no-auto-update agent --no-leader stdio`) and
`@agentclientprotocol/sdk` 1.8.0. Recorded for
[issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594). These results
describe the measured runs, not every version or prompt. Raw records stay
private. Every process check read `/proc/<pid>/stat` for PIDs the test's own
commands wrote; no signal was sent by the tests.

## Over ACP directly

A driver ran two turns in one session. Turn A started `sleep` in the
background and ended. Turn B started another background `sleep` and a
foreground command and was cancelled. The prompts of these first two runs
forbade other tools.

| Question | Observation |
| --- | --- |
| Does `_x.ai/task/list {sessionId}` return the task? | Yes, with every task of the session, earlier turns' included. Entries carry no turn or prompt id. |
| Does `session/cancel` end a background task? | No. Both `sleep` processes were alive 5 s after the cancel. |
| Does `_x.ai/task/kill {sessionId, taskId}` end it? | Yes. Without `taskId` the answer is `-32602`. The killed task's process was gone; turn A's was not. |
| What does a kill start? | `_x.ai/task_completed` with `will_wake: true`, then `_x.ai/queue/changed` naming `task-completed-<taskId>` as running: a turn Grok starts on its own. |

## Through the wrapper

The real wrapper (after [issue #1128](https://github.com/sakuraiyuta/kaoiro/issues/1128))
drove live Grok with a test plugin that asks for commands carrying a marker.
Turn A backgrounded one `sleep`; turn B backgrounded two (B1, B2), ran a
foreground `sleep` and asked for a follow-up command once the background tasks
stopped; turn B was interrupted. These prompts did not forbid tools. Some runs
used throwaway Grok settings with one file deny rule (`Read(**/.env)`,
`Edit(**/.env)`), so that a redirect to a path held in a variable asks for
permission at once; the operator's settings were not used for those.

In the first runs, a measurement proxy between the wrapper and Grok sent the
kills when the prompt answered `cancelled` and held that answer for at most
2 s. In the last runs, the wrapper's own implementation sent them without a
proxy.

| Question | Observation | Runs |
| --- | --- | --- |
| Does `_x.ai/task_backgrounded` carry a prompt id? | No. `params` hold `sessionId`, `update` (`task_id`, `tool_call_id`, command details) and `_meta` with `eventId` and `agentTimestampMs`. | All |
| Can the task be attributed? | Yes. The `tool_call` with the same id carried the own `_meta.promptId`, 6 to 15 s before the notification. Only B1 and B2 were selected; never A. | All |
| What does a kill answer? | `{ "result": { "taskId": "…", "outcome": "killed" } }` inside the JSON-RPC result, after 2 to 9 ms for two parallel kills. | 5 runs with raw records |
| Are the processes gone, and the earlier one kept? | B1 and B2 were gone; A stayed the same `sleep` (same start time). | All |
| When do the self-started turns come? | Within 5 ms of the kill answers: one `task-completed-*` turn per killed task, run one after the other. With the wrapper's own kill, the first started after the interrupted turn's result. | All |
| Can such a turn ask for permission? | Yes. With throwaway settings and no new input, each such turn asked 33 to 37 ms after its `tool_call`; the wrapper refused all 8 requests over 4 runs. With the operator's settings and no new input, Grok refused the command before asking. With new input, the request reached the wrapper and was refused. | 6 runs |
| Did the interrupted turn's result stay its own? | Yes: only the own prompt's text, `stop_reason: cancelled`, `interrupted: true`, and the agent stayed `waiting_input`. | All |

## A kill left unanswered at close

A child Node process ran the host against a fake agent that never answered
`task/kill`, then either closed the host or let the agent exit. The SDK
rejected both pending requests in both cases; the process ended 14 to 19 ms
after the host closed. With the timer not cleared on that rejection, it lived
about 2 s longer.
