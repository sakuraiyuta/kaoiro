---
title: Issue 426 serial-queue assumption audit
status: preliminary
last_updated: 2026-09-27
---

# Serial-queue assumption audit

This is a read-only audit of the accepted [hand-back plan](../../plans/issue-426-agent-handback-admission.md) and its inherited [notification plan](../../plans/issue-422-notification-lifecycle.md). It is not an admission gate or a design amendment. All timestamps are UTC on 2026-09-27. `H` means child `SubagentHandback` hook to root `<agent-message>` prompt; `N` means SDK `task_notification` frame to root `<task-notification>` prompt. A busy interval is a recorder `turn_start` through its matching `turn_end`; the table counts each interval's intersection with the source-to-prompt wait and sums those intersections. Thus a busy count can include the launching turn or the turn into which a later prompt folds. Millisecond event order, rather than rounded timestamp alone, decides whether a turn was already active at prompt arrival.

| Run | Events SHA-256 | Stdout SHA-256 | Stderr SHA-256 |
| --- | --- | --- | --- |
| four3 `tmp/fuji-426/native-four3-1790494840-events.jsonl` | `adc676d487e69588ff11f7300ab4f003747a4492dc56cf8e8f83a11af1b27958` | `beb59207bcf065b77d238a154a3c5be6f5aa600b8e0cdd1ea05406c73461cd31` | `d21114e4b18325914aacea7dbc9727dbb149ca0a45bff5299c467b068d03dd9a` |
| four4 `tmp/fuji-426/native-four4-r4-0844-events.jsonl` | `aa874513f8bcfdee5cdc330c0400823254a08d996a72bbf8c0bd0df77ef589b4` | `7710ea605bd9ecd57ffda63aecef619dfcad17a4ef26a9386e020bf1c2c8b00d` | `c77da05a72ae6053b0a642f158997d8ab72155f22f768470ac3a1dda8b535897` |
| four5 `tmp/fuji-426/native-four5-r5-0907-events.jsonl` | `3a6a4da9f0fa6ec96cc6b01701d9f556919a3314eafeaf114ce8ff78ed5b7808` | `8aa97694a5b71f5ae92cc11ffce26b0daa6fdd620361721bb9f933c52c765816` | `a94a913221981c7791618931d597166ec990e689557915e22e63143622772966` |

The [earlier correlation audit](2026-09-27-correlation-key-audit.md) also binds auto1 and ledger2 logs. `Direct` below means the [direct CLI probe](2026-09-27-handback-shapes.md); `A1`/`L2` are auto1/ledger2; `F3`/`F4`/`F5` are the three four-Agent runs. **Holds** means only that the cited observations did not contradict the rule. **Unmeasured** includes an unexercised branch or a bound whose native proof is absent. A focused fixture alone does not count as serial-queue observation.

## Rule inventory

| Rule and plan location | Premise class | Observation | Serial four-Agent status |
| --- | --- | --- | --- |
| #426 task provenance requires background `local_agent` and root `Agent` tool-use association (§ Task and occurrence ownership). | ID, order | F3/F4: 8/8 parent tool-use associations; F5: four more task starts and root Agent hooks. | Holds for these starts; other task kinds unmeasured. |
| #426 child `agent_id` identifies its task, and child tool-use ID identifies an occurrence. | ID | [ID audit](2026-09-27-correlation-key-audit.md#launch-and-child-hook-relationships): 8/8 F3/F4; F5: 4/4 child hooks match task IDs, with distinct child tool-use IDs. | Holds in 12/12 observed hooks; ID collision unmeasured. |
| #426 child hook session equals provenance session/generation. | ID | F5 recorder captured session and generation; 4/4 matched task frames in generation 0. F3/F4/A1/L2 recorder omitted child session. | Holds in F5; older runs and session rotation unmeasured. |
| #426 child `prompt_id` belongs to an earlier observed root prompt in the same session/generation; no equality to launch ID is required. | ID, order | [ID audit](2026-09-27-correlation-key-audit.md#prior-root-prompt-membership-check): 10/10 earlier membership, only 7/10 launch equality. F5: 4/4 earlier membership. | Holds for 14 hooks; capacity and cross-generation cases unmeasured. |
| #426 observed-root-ID set is capped at 64, retained while provenance/parent association exists, then cleared; overflow refuses new IDs. | Constant, order | Plan bound; F3/F4/F5 used fewer than 64. | Unmeasured at capacity and cleanup. |
| #426 hand-back candidate requires a string report, unique child tool-use ID and valid task; notification candidate requires a matching SDK frame UUID. | ID, order | Direct, F3/F4/F5 show hook/frame ordering and IDs. | Holds for observed positive cases; malformed/reused IDs unmeasured. |
| #426 candidate selection uses the entire exact rendered prompt, not task ID or markup substring; ambiguity and replay reject. | ID, order | Direct measured one renderer shape; F3/F4/F5 recorder truncated root text. | Unmeasured in serial queue for exact bytes, duplicate reports, and ambiguity. |
| #426 distinct same-task occurrences coexist; identical fingerprints are retained and rejected until task provenance clears. | ID, order | F3/F4/F5 have one report and one notification per task. | Unmeasured for repeated or distinct later reports. |
| #426 task cap 64, per-kind fingerprints 8/task, 10-minute post-notification grace, hand-back candidates 64 total and 8/task; notification cap 64 total and 8/task. | Constant, time | F3/F4/F5 have four tasks each; no overflow or late second report. | Unmeasured at bounds and grace. |
| #426/#422 candidate timer arms on registration with no active root turn, otherwise on that turn's end; hand-back 30 s and notification 10 s after arming, with no rearm on later activity. | Time, order | F5 `a590ec` notification arrived 09:08:17.519 during turn `bf0aad`; timer armed at 09:08:21.171, prompt arrived 09:08:44.344 after the approximately 09:08:31.171 deadline. F4 waits reached 22.637 s (N) and F5 32.046 s (H), although their individual arm times differ. | **Breaks** as a serial-queue availability premise: F5's valid later prompt expired while two other continuations consumed the wall-clock window. The host rejected it as designed. |
| #426 expiration removes one occurrence but keeps fingerprint; overflow warns and rejects rather than evicting another candidate. | Time, constant | F5 shows one expired notification; no subsequent same-body replay or overflow. | Holds for removal; replay and overflow unmeasured. |
| #426/#422 pending candidates hold the next wrapper input only with no live owner; all pending candidates and independent owners must finish before release. | Order, time | F3/F4/F5 show multiple candidates, but no queued external wrapper input behind the four-Agent continuations. | Unmeasured for multi-candidate release; F5 cannot prove barrier behavior from the recorder. |
| #426/#422 a valid same-ID fold retains its live owner token, fixed basis, tickets, watchdog and barrier; no new terminal. | ID, order | F3: three hand-backs and notifications reused independent notification ID `6933162c`; F4 fourth notification reused hand-back ID `300f631f`; F5 two later notifications reused ID `5f3422cc`. Prompt-ID reuse alone does not establish candidate validity, especially after F5 expiry. | Holds for observed ID reuse only; successful binding and exact owner-state assertions remain unmeasured in F5. |
| #426/#422 a fresh-ID continuation with no live owner gets an independent `sdk_notification` token and completed-ledger copy; it inherits no ticket. | ID, order | Direct fresh hand-back; F3/F4/F5 fresh root IDs. | Holds for observed admission shapes; peer-basis correctness under distinct delivered inputs unmeasured here. |
| #426/#422 live different-ID collision, wrapper/candidate ambiguity, bad same-ID hook taint, and foreign prompt must not borrow current token. | ID, order | F5 notification `fcd94a5d` arrived after expiration and was foreign; later result index 6 fail-stopped. | Holds for F5 fail-closed case; other collision/taint controls unmeasured natively. |
| #426/#422 root `PreToolUse` needs absent `agent_id`, a live confirmed owner and new tool-use ID; retired calls cannot bind to a newer token. | ID, order | F3/F4 tool hooks show root versus child IDs; F5 made no kaoiro send. | Unmeasured for the intended F5 bound send and retired-call race. |
| #422 confirmed wrapper/recovery input enters the completed ledger only after correlated prompt/committed handoff; queued input does not. | Order | L2 ledger probe, [#422 plan](../../plans/issue-422-notification-lifecycle.md#admission-invariant). | Unmeasured in F3/F4/F5 with distinct peer input; no contrary evidence. |
| #426/#422 folded owner keeps its immutable basis; independent owner copies completed ledger; tickets do not cross tokens. | Order, ID | Direct and L2 support separate branches; F3/F4/F5 have no distinct peer-input comparison. | Unmeasured in four-Agent serial queue. |
| #422 candidate frame alone, `system/init`, result origin alone, or matching ID string alone never grants a token. | Order, ID | F3/F4/F5 show frames preceding prompts; F5 expired prompt rejected. | Holds for F5 frame/expired case; other isolated inputs unmeasured. |
| #422 notification matcher requires task/session/parent/status/summary and exact optional output path, preserving absent versus empty path. | ID | #422 native gates; F3/F4/F5 recorder omitted full matcher inputs. | Unmeasured in this serial-queue audit. |
| #426/#422 `Stop`/`StopFailure` is an attempt, not settlement; actual result or cancellation retires exact owner and settles each owned CID once. | Order | F3/F4/F5 result/turn-end records; Stop attempts and CID settlement not recorded. | Unmeasured for repeated Stop, cancellation, and CID settlement. |
| #426 result index is monotone per run/generation; exact retired-result duplicates alone may be ignored. | ID, order | F3 indices 0–2, F4 0–7, F5 0–6 are sequential; no duplicate. | Holds for observed indices; duplicate and generation reset unmeasured. |
| #426 terminal owner follows opener: wrapper fold → originless; independent hand-back → `peer` with task identity/body; independent notification fold → `task-notification`. | ID, order | F3 indices 0/1/2; F4 indices 0–7; F5 0–5 follow observed opener shapes. F5 index 6 was rejected after a foreign prompt. | Holds for measured accepted shapes; body equality and all mismatch branches unmeasured. |
| #426/#422 an unmatched/foreign result freezes admission, ledger and barrier rather than settling by stream position. | Order | F5 index 6 `peer` after unresolved foreign notification caused fail-stop; no accepted send. | Holds for this failure; later recovery/EOF/reset unmeasured. |
| #426/#422 session change, interrupt, EOF, reset, close, watchdog and fail-stop retire or freeze exact owner/candidates; no late candidate can move to a replacement token. | Order, ID, time | F5 fail-stop only. | Unmeasured for other lifecycle branches. |

The inventory separates an observed identity relation from its availability assumption. In particular, [the ID audit](2026-09-27-correlation-key-audit.md) did not test whether a candidate could survive the time spent in other root turns.

## Source-to-root prompt timing

Times below are `HH:MM:SS.mmm`; task IDs and prompt IDs are unique prefixes within a run. `Busy` is count / aggregate seconds of overlapping recorded root-turn intervals. The sum excludes gaps with no recorded active turn and can be less than the total delay. A prompt can arrive during a turn yet share its `prompt_id`; that is a same-ID join, not a fresh independent turn.

| Run | Kind / task | Source → root prompt | Root prompt ID | Delay s | Busy count / s |
| --- | --- | --- | --- | ---: | ---: |
| F3 | H `a24037` | 07:36:06.870 → 07:36:09.298 | `fbcc4c` | 2.428 | 0 / 0.000 |
| F3 | H `a5d534` | 07:36:09.250 → 07:36:18.104 | `693316` | 8.854 | 2 / 8.802 |
| F3 | H `adc85c` | 07:36:10.791 → 07:36:18.139 | `693316` | 7.348 | 2 / 7.344 |
| F3 | H `af4bf6` | 07:36:11.872 → 07:36:18.241 | `693316` | 6.369 | 1 / 6.369 |
| F3 | N `a24037` | 07:36:10.786 → 07:36:11.200 | `693316` | 0.414 | 1 / 0.411 |
| F3 | N `a5d534` | 07:36:12.954 → 07:36:18.173 | `693316` | 5.219 | 1 / 5.219 |
| F3 | N `adc85c` | 07:36:14.007 → 07:36:18.207 | `693316` | 4.200 | 1 / 4.200 |
| F3 | N `af4bf6` | 07:36:15.731 → 07:36:18.275 | `693316` | 2.544 | 1 / 2.544 |
| F4 | H `a4866f` | 08:44:35.005 → 08:44:38.143 | `446963` | 3.138 | 1 / 3.135 |
| F4 | H `a22507` | 08:44:36.425 → 08:44:44.560 | `c8e914` | 8.135 | 3 / 8.124 |
| F4 | H `aa5e91` | 08:44:37.358 → 08:44:53.826 | `951b4e` | 16.468 | 5 / 16.450 |
| F4 | H `a10298` | 08:44:39.007 → 08:44:59.787 | `300f63` | 20.780 | 5 / 17.789 |
| F4 | N `a4866f` | 08:44:36.834 → 08:44:41.569 | `0cc28b` | 4.735 | 2 / 4.728 |
| F4 | N `a22507` | 08:44:38.004 → 08:44:47.725 | `02adb3` | 9.721 | 4 / 9.707 |
| F4 | N `aa5e91` | 08:44:38.713 → 08:44:56.812 | `23dd5c` | 18.099 | 5 / 18.083 |
| F4 | N `a10298` | 08:44:41.397 → 08:45:04.034 | `300f63` | 22.637 | 5 / 15.399 |
| F5 | H `a9cea4` | 09:08:09.491 → 09:08:12.110 | `d1acf3` | 2.619 | 1 / 2.616 |
| F5 | H `ad2210` | 09:08:12.257 → 09:08:40.377 | `fbef9a` | 28.120 | 3 / 28.111 |
| F5 | H `a590ec` | 09:08:13.279 → 09:08:21.174 | `e31421` | 7.895 | 2 / 7.889 |
| F5 | H `aa7f1f` | 09:08:16.799 → 09:08:48.845 | `5f3422` | 32.046 | 4 / 27.533 |
| F5 | N `a9cea4` | 09:08:13.553 → 09:08:16.979 | `e506a1` | 3.426 | 1 / 3.423 |
| F5 | N `a590ec` | 09:08:17.519 → 09:08:44.344 | `fcd94a` | 26.825 | 3 / 26.816 |
| F5 | N `ad2210` | 09:08:30.645 → 09:08:53.813 | `5f3422` | 23.168 | 3 / 18.660 |
| F5 | N `aa7f1f` | 09:08:33.808 → 09:08:53.848 | `5f3422` | 20.040 | 3 / 15.532 |

The proposed blanket premise that a candidate root prompt cannot arrive during another root turn is false in **8/24** observed continuation prompts: F3 has 6/8, F4 0/8, and F5 2/8. F3's six arrived at 07:36:18.104–18.275 during turn `d2ea06c1` (started 07:36:11.201); F5's two arrived at 09:08:53.813 and 53.848 during turn `15e517aa` (started 09:08:48.846). In all eight, the incoming prompt reused the active owner's ID; **no fresh-ID prompt** was recorded inside an already active root turn in these runs. This narrower observation does not establish a universal CLI guarantee. F4 also has two later root prompts without a corresponding recorded host `turn_start`; the busy-intersection measure does not invent intervals for them.

For the F5 failure, `a590ec` notification frame arrived during the `e506a1c6` notification turn at 09:08:17.519. That turn ended at 09:08:21.171, arming its 10-second candidate timer. The `a590ec` hand-back occupied 09:08:21.174–40.374 and the `ad2210` hand-back 09:08:40.377–44.341. The `a590ec` notification prompt arrived at 09:08:44.344, roughly 13.173 seconds after the deadline, and was rejected as foreign. A later origin-index 6 could not be uniquely attributed and fail-stopped. This is a measured availability failure of the current deadline premise, not a proposal to change the timer.

## Four5 peer-discovery check

The recorder logged root `turn_start` at **09:07:40.384**, `peer_joined` at **09:07:40.385**, and root `UserPromptSubmit` at **09:07:41.531**. Thus the peer callback happened one millisecond *after* host turn start, but before the first root SDK prompt. In `tmp/fuji-426/native-run.mjs`, `peer_joined` is recorded at the start of `ServerLink.onPersonaPrompt`, before its asynchronous `peer.send(state_change)` resolves; neither events nor stderr record a server directory acknowledgement or a kaoiro directory listing. Server registration and visibility before root start therefore remain **unverified**.

At 09:08:53.794, the only discovery hook in F5 was `tool_name="ListAgents"`, not `mcp__kaoiro__list_agents`; no kaoiro list call or `send_to_agent` followed. Stdout said it saw four `kaoiro-7c/73/22/74` agents and therefore could not find `probe426-peer-four5-r5-0907`. The four matches are consistent with the launched subagents, so invoking the wrong tool namespace is the supported explanation for this probe's missing send. It does **not** prove that the joined server lacked the peer. Before another native run, a driver precheck must query the actual kaoiro directory for the peer and abort before root startup if it is absent; this disposable driver has not been changed or rerun in this audit.

## Limits

The root-prompt recorder truncates text, so this audit cannot validate byte-exact hand-back or notification rendering. F3/F4 omit child-hook sessions; F5 records them. The three runs have four tasks each, below the proposed capacity limits. No source, owner, deadline, plan, or native-gate behavior was changed here.
