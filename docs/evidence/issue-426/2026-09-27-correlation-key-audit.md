---
title: Issue 426 background Agent correlation-key audit
status: preliminary
last_updated: 2026-09-27
---

# Background Agent correlation-key audit

This is a read-only comparison of existing native `runClaudeCli` event logs, not a new gate run or a design change. The recorder saved the first 600 characters of each root prompt, enough to identify its opening `<agent-message from>` or `<task-id>`, but it did **not** save `session_id` on tool hooks or the complete prompt body. Times below are UTC on 2026-09-27. The raw logs are temporary; their hashes and the observed correlation facts are retained here. The [native gate record](2026-09-27-native-gate-blocker.md) explains the failed sends.

| Run | Event log SHA-256 | Recorded root prompts / child hand-back hooks / SDK results | Recorded session ID |
| --- | --- | --- | --- |
| `tmp/fuji-426/native-four3-1790494840-events.jsonl` | `adc676d487e69588ff11f7300ab4f003747a4492dc56cf8e8f83a11af1b27958` | 9 / 4 / 3 | `034af260-ad02-4d71-b1ba-363823595ab6` |
| `tmp/fuji-426/native-four4-r4-0844-events.jsonl` | `aa874513f8bcfdee5cdc330c0400823254a08d996a72bbf8c0bd0df77ef589b4` | 9 / 4 / 8 | `240edbcb-938e-454e-adda-026ac8687a2a` |
| `tmp/fuji-426/native-auto1-1790493715-events.jsonl` | `3524fc3f677692c82ae39949eee0139beca443f2d677f39533d3c322726b7e54` | 3 / 1 / no result observer | `69ce7e27-a704-4899-b59e-cfda9b32a913` |
| `tmp/fuji-426/native-ledger2-1790494020-events.jsonl` | `1cf01bc678fd6bc637043c75c60009062fb1c75b292bcbf1cb27485004484405` | 3 / 1 / no result observer | `d9a6175a-d0c8-41b0-95ea-6c7f8cde5fda` |

The accompanying four3 stdout/stderr SHA-256 values are `beb59207bcf065b77d238a154a3c5be6f5aa600b8e0cdd1ea05406c73461cd31` / `d21114e4b18325914aacea7dbc9727dbb149ca0a45bff5299c467b068d03dd9a`. For four4 they are `7710ea605bd9ecd57ffda63aecef619dfcad17a4ef26a9386e020bf1c2c8b00d` / `c77da05a72ae6053b0a642f158997d8ab72155f22f768470ac3a1dda8b535897`. The four3/four4 driver SHA-256 values at their respective runs were `155d5c5e9c013dfc8ab08b6edf123e579ee0b5466ca4f6d19fcf79ecfe62ef4e` / `5c0b491c71b7da26881b020c8ef3757f3a27fde29e1ab9c2323554f18af9fc51`.

The four-Agent logs each have four `task_started`, four `task_notification`, and four `task_updated` frames. Within each run, all recorded root prompts, task frames, and SDK results carry the same session ID. The recorder omitted the tool-hook session field, so these logs cannot test whether a **child hook's** `session_id` equals the task frame's. The single-Agent logs predate the SDK task/result observer; their root prompts and tool hooks can test prompt-ID membership, but not the `task_started` or result relationships below.

## Launch and child-hook relationships

Every row below names one task. `Agent hook / started` gives the two UTC times; the `Agent` hook's `tool_use_id` equals that task's `task_started.tool_use_id` in all eight rows. `Child hook` gives its UTC time, `prompt_id` alias, and unique child `tool_use_id`. In all eight rows, `child.agent_id` equals the displayed `task_started.task_id`. The child hook recorder does not carry `session_id`. `L3` and `L4` are the respective launch root prompt IDs.

| Run / `task_id` | Root `Agent` hook / `task_started` | Shared parent `tool_use_id` | Child `SubagentHandback` hook / prompt | Child `tool_use_id` |
| --- | --- | --- | --- | --- |
| four3 `a24037533a2136b59` | 07:35:54.501 / 07:35:56.827 | `toolu_01DrdDNRXMpN9fL2SuWoLcrS` | 07:36:06.870 `L3` | `toolu_01PMNm7U1tvzDKyy6BrfhXFo` |
| four3 `a5d534b3f602c6a52` | 07:35:55.998 / 07:35:58.269 | `toolu_018qgYQYXAzb487CfUiVzXux` | 07:36:09.250 `L3` | `toolu_014JmBH5WSputzvfEvug9qJi` |
| four3 `adc85c1518e6b95cb` | 07:35:57.497 / 07:35:59.627 | `toolu_01Lk1aBeckm7HLz51DDmuDV2` | 07:36:10.791 `H3` | `toolu_01JqXQnEZpAbzwhvudBTcMsg` |
| four3 `af4bf647b0cf292aa` | 07:35:58.915 / 07:36:01.272 | `toolu_011drfBEzPa22PzXcmjCUgTR` | 07:36:11.872 `N3` | `toolu_01RF13EFA5AvfsohHEBRwGr4` |
| four4 `a4866f1cd665d9abc` | 08:44:30.922 / 08:44:32.097 | `toolu_01DZNK1bnCNtfuSJWTHzcjDN` | 08:44:35.005 `L4` | `toolu_013hejW8hbGYaPj9YYuk3BYd` |
| four4 `a2250700b44f02601` | 08:44:32.273 / 08:44:33.092 | `toolu_01M6EgH1sYpMWyokdLevc1Fa` | 08:44:36.425 `L4` | `toolu_017cSy7fJdUuW1X7ZSxJ2unQ` |
| four4 `aa5e91e507945e5a1` | 08:44:33.675 / 08:44:34.504 | `toolu_01WNQVMJFbX1ZmQ8vzwC4A1a` | 08:44:37.358 `L4` | `toolu_01Jr8wek8nFBe6sWVrdbQAEF` |
| four4 `a10298bab3327f6d7` | 08:44:35.045 / 08:44:35.910 | `toolu_01Rur5CtnsLGte7PkpRHJ89g` | 08:44:39.007 `H4a` | `toolu_01MpxCxDUb1Giy6WoskTkNW3` |

| Prompt alias | Full root `prompt_id` | First observed root input |
| --- | --- | --- |
| `L3` | `a7748869-d9b9-4056-b5ff-2d69f4f96bc2` | four3 launch, 07:35:45.457 |
| `H3` | `fbcc4cf5-4005-4e51-8e4b-903c9539c2d9` | four3 first hand-back, 07:36:09.298 |
| `N3` | `6933162c-8cc0-4e11-ad66-0587592de21f` | four3 first notification, 07:36:11.200 |
| `L4` | `1228e246-3129-49b7-9df5-aaf983da63a3` | four4 launch, 08:44:26.573 |
| `H4a` | `446963f5-d5e2-41fd-9837-719b67e49c75` | four4 first hand-back, 08:44:38.143 |
| `N4a` | `0cc28b53-ab99-41d6-9445-b5fb3573960c` | four4 first notification, 08:44:41.569 |
| `H4b` | `c8e914e3-2a1e-4ef1-8590-874b53717abc` | four4 second hand-back, 08:44:44.560 |
| `N4b` | `02adb3e1-4dab-42e1-a888-61f6f6b2fe71` | four4 second notification, 08:44:47.725 |
| `H4c` | `951b4ee3-f681-45ca-bd4b-8cd5b222528a` | four4 third hand-back, 08:44:53.826 |
| `N4c` | `23dd5c3c-2f4f-4aa3-b1bd-0faae9f4e3d8` | four4 third notification, 08:44:56.812 |
| `H4d` | `300f631f-0d70-46f2-9007-702e9033d9d9` | four4 fourth hand-back, 08:44:59.787 |

The child `tool_use_id` is distinct and unrepeated in each four-Agent run (4/4), but it is an occurrence identifier, not a root prompt or owner identifier. A child-hook `prompt_id` equals its task's launch root prompt in four3 **2/4** cases and differs in **2/4** (`H3`, `N3`); in four4 it equals launch in **3/4** and differs in **1/4** (`H4a`). The drifted child hook IDs were root prompts already observed **before** those hooks: `H3` 1.493 seconds earlier, `N3` 0.672 seconds earlier, and `H4a` 0.864 seconds earlier. This is a measured relationship, not proof of what the CLI will put in every future child hook.

## Root report, notification, and result order

The root report envelope's `from` equals the task ID in all four report prompts per run. Each root notification's `<task-id>` also equals its task ID. The event recorder does not capture the complete report or notification body; byte-exact rendering remains outside this audit.

| Run / task | Root hand-back prompt | Root notification prompt | SDK notification frame time / UUID |
| --- | --- | --- | --- |
| four3 `a24037533a2136b59` | 07:36:09.298 `H3` (fresh) | 07:36:11.200 `N3` (fresh) | 07:36:10.786 `1b441a32-01b7-4520-b91e-f946c2fe5bb4` |
| four3 `a5d534b3f602c6a52` | 07:36:18.104 `N3` (joined notification prompt) | 07:36:18.173 `N3` | 07:36:12.954 `65311129-99c3-4b4e-a9e8-7cf42e4e79d6` |
| four3 `adc85c1518e6b95cb` | 07:36:18.139 `N3` (joined notification prompt) | 07:36:18.207 `N3` | 07:36:14.007 `5ab63be6-91e6-4517-a24d-c7f6b5a68ed1` |
| four3 `af4bf647b0cf292aa` | 07:36:18.241 `N3` (joined notification prompt) | 07:36:18.275 `N3` | 07:36:15.731 `fb1a0823-d4cc-4a20-8dd2-3227e96beffd` |
| four4 `a4866f1cd665d9abc` | 08:44:38.143 `H4a` (fresh) | 08:44:41.569 `N4a` (fresh) | 08:44:36.834 `4c947924-fb58-4ac3-96a6-1417cb612041` |
| four4 `a2250700b44f02601` | 08:44:44.560 `H4b` (fresh) | 08:44:47.725 `N4b` (fresh) | 08:44:38.004 `f115530c-6de6-4de5-b824-d5f09fcb8e94` |
| four4 `aa5e91e507945e5a1` | 08:44:53.826 `H4c` (fresh) | 08:44:56.812 `N4c` (fresh) | 08:44:38.713 `9f99b9ee-18df-4b93-a287-0c94d9ce1f6d` |
| four4 `a10298bab3327f6d7` | 08:44:59.787 `H4d` (fresh ID; not admitted by the host) | 08:45:04.034 `H4d` (joined hand-back prompt ID) | 08:44:41.397 `ce163d16-1375-4621-9e95-355cdeb414b0` |

In four3, one report prompt got a fresh ID and three reports joined `N3`, the independent notification prompt opened at 07:36:11.200. The root report order under `N3` was `a5d534` at 07:36:18.104, `adc85c` at 07:36:18.139, their notifications at 07:36:18.173 and 07:36:18.207, then `af4bf6` report at 07:36:18.241 and notification at 07:36:18.275. In four4, all four report prompts got distinct fresh IDs; three notifications then got distinct fresh IDs and the fourth reused `H4d`. Thus a root report prompt's ID is not a stable function of task ID or of its child hook's `prompt_id`.

| Run | SDK result index / UTC time / origin | Attribution fields recorded |
| --- | --- | --- |
| four3 | `0` 07:36:05.864 origin absent; `1` 07:36:11.196 `peer`; `2` 07:36:41.094 `task-notification` | Index 1: `from=senderTaskId=a24037533a2136b59`, `handback=true`. Index 2 has no task ID. |
| four4 | `0` 08:44:38.138 origin absent; `1` 08:44:41.565 `peer`; `2` 08:44:44.556 `task-notification`; `3` 08:44:47.722 `peer`; `4` 08:44:53.822 `task-notification`; `5` 08:44:56.809 `peer`; `6` 08:44:59.783 `task-notification`; `7` 08:45:18.222 `peer` | Peer indices 1/3/5/7 have `from=senderTaskId` equal respectively to `a4866f1cd665d9abc` / `a2250700b44f02601` / `aa5e91e507945e5a1` / `a10298bab3327f6d7`, all with `handback=true`. Notification origins have no task ID. |

`result_index` is new and sequential within both runs (3/3 four3, 8/8 four4), but carries no root prompt or task ID. `origin.kind` varies with the root continuation; `task-notification` by itself does not identify which task's notification or report contributed. In four4, result 6 had no recorded host `turn_end`; the later `H4d` prompt did not get a recorded `turn_start`. Result 7 carried the expected task identity but was rejected as an unowned hand-back. Neither the index nor a peer origin alone repairs a missing admitted owner.

## Prior-root-prompt membership check

For each child `SubagentHandback` hook, the check scanned root `UserPromptSubmit` records **strictly earlier** in the same event log. It counted exact `prompt_id` equality, without inferring ownership from the text. This checks the director's hypothesis on these four runs only.

| Run | Child hooks whose `prompt_id` was a previously observed root prompt | Hooks with no such root prompt | Equal to the launch root prompt / different |
| --- | ---: | ---: | ---: |
| four3 | 4 | 0 | 2 / 2 |
| four4 | 4 | 0 | 3 / 1 |
| auto1 | 1 | 0 | 1 / 0 |
| ledger2 | 1 | 0 | 1 / 0 |
| **Total** | **10** | **0** | **7 / 3** |

For auto1, the launch prompt ID was `d4f35c64-f9e6-4a13-b1d9-c02917f4d37b` at 07:22:25.481 and the child hook with `agent_id=a49c09275af008ff2` reused it at 07:22:33.088. For ledger2, the launch prompt ID was `f58d65d3-a48b-435d-b53f-67743c8e6837` at 07:30:21.925 and the child hook with `agent_id=a3ba600afa47a9e81` reused it at 07:31:07.302. Both had a later fresh root hand-back prompt. The recorder cannot establish the child-hook session field in any of these runs.

The same class of assumption may affect a rule that equates the child hook's current `prompt_id` with the task's **launch** prompt or with its **later root report** prompt. Both equalities fail in these logs. A recorded root-prompt membership relation held 10/10 times, but it does not by itself prove the hook belongs to a particular task, prompt owner, or generation. No correlation rule was changed in this audit.
