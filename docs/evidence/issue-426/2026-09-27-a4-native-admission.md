---
title: Issue 426 A4 native admission observations
status: preliminary
last_updated: 2026-09-27
---

# A4 native admission observations

These runs used the final built Claude Code host at source commit `07ac81f2`, SDK 0.3.280 / bundled CLI 2.1.280, `model=sonnet`, `permission_mode=auto`, `allowed_tools=[]`, the production MCP builder, a loopback Phoenix server, and real joined `ServerLink` peers. The driver checked peer directory visibility before starting each root. The runs exercised [the accepted A4 owner rule](../../plans/issue-426-agent-handback-admission.md#exact-prompt-and-owner-decision); they do not complete every verification gate in that plan. Times are UTC on 2026-09-27.

## Four-Agent observations

| Run | Observed owner and terminal | Root sends / server acceptances / peer deliveries | Limit |
| --- | --- | --- | --- |
| `four8` | All four hand-backs and four notifications used the live wrapper prompt ID `53ad7d57-360e-4532-8f97-8d0f49fa2f0f`; one originless result at index 0 and one owner `turn_end`. | 4 / 4 / 4, one per task. | The driver was stopped after the terminal; its process exit is not a successful gate exit. |
| `four10` | The initial wrapper result was index 0. Later independent continuations had peer results at indices 1, 2, 5 and 6, and task-notification results at indices 3 and 4; each had one owner `turn_end`. | 4 / 4 / 4. | The schedule did not show a notification owner joined by a hand-back before its terminal. |
| `four11` | Initial wrapper result index 0 ended at 12:21:58.832. Task `ad69fee66d13a1011` opened a fresh hand-back prompt ID `c2cd362a-e397-41d5-9f93-6efbbb6e50eb` and independent token `48740972-7c89-40f3-a4fc-a81320a878ca` at 12:22:07.741. Three other task hand-backs and four notifications folded into that ID at 12:22:13.051–13.268, before any root send. One peer result at index 1 identified the **opener** (`from=senderTaskId=ad69fee66d13a1011`, `handback=true`) and ended that token once at 12:22:40.145. | 4 / 4 / 4, one for each distinct task. | This is the hand-back-opener A4 positive control, not the notification-first or long-busy expiry control. |

In `four11`, all four child `PreToolUse:SubagentHandback` hooks carried the root session `8d0a80fd-7d24-4022-8774-b2cf85f22cfd` and recorder generation 0, matching their background `task_started` records. All four root `send_to_agent` hooks followed the seven same-ID folds and used the opener's prompt ID. The wrapper attempted `FOUR_AUDIT_DONE` for each distinct task; each attempt received one server `accepted` response and one peer message. The opener result's body retained the opener report, rather than a folded task's report. No admission fail-stop was recorded. No fresh-ID continuation arrived while another root owner was live in these three runs.

## Ledger probe refusal

`ledger3` delivered one peer input, and the initial wrapper turn ended with originless result index 0. It produced no `Agent`, child hand-back, wrapper send, or server acceptance. The model declined the test-like request because it explicitly named `SubagentHandback` as a tool to call, questioned the synthetic probe IDs, and requested guidance. This is a prompt failure before the admission path, not evidence that the host rejected a hand-back. The ledger gate remains open; the director approved a natural read-only document-audit request for the rerun.

## Artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| `wrapper/claude-code/src/host.ts` | `29341e40df15fa8faf405499965a0bc2d957127c2536be92c5e4c787e227f609` |
| `wrapper/claude-code/dist/host.js` | `5b83a5724ec1a17fbf3fe038804b47112746de8e2533659db8b5e881bb10dd78` |
| `tmp/fuji-426/native-run.mjs` | `5b687b348ce21c332755f34ddb90ec63d9c97f6295aea3df70891a41f5294840` |
| `tmp/fuji-426/native-four8-a4-events.jsonl` | `0087e69a14b9b83cb6e1eaa370faafbcfd5293070833022705f45c0788b0821b` |
| `tmp/fuji-426/native-four8-a4.stdout` | `a06afd56ebdd1f81e25a74ae628d63fb48618525bca17dd1f2ce2a373a2145d5` |
| `tmp/fuji-426/native-four8-a4.stderr` | `f2557017b77173c1567549176f8ba588b5aba1ab74ee3a53231168c9316de440` |
| `tmp/fuji-426/native-four10-a4-events.jsonl` | `468969161ecd16d7eb6b3c39e74336b1a51bbc2fb8463f069412552e102ac3f6` |
| `tmp/fuji-426/native-four10-a4.stdout` | `0fc78fb03486a4c1c941fe91346952efe2a6e00685f5b57aa197ef551244aae1` |
| `tmp/fuji-426/native-four10-a4.stderr` | `45eed5e6ac3286a35220ca08a0b19be797ab931318b8058e97b12ab3a495d009` |
| `tmp/fuji-426/native-four11-a4-events.jsonl` | `eec49a3fda7e535ee01c3586fdc538fc1fcbc1d2c0eeccec7d0097204e6a429c` |
| `tmp/fuji-426/native-four11-a4.stdout` | `5deb117982b567fe18c63a5253ba610d1ac64e4f1d7c96a7f36e45298aa312f1` |
| `tmp/fuji-426/native-four11-a4.stderr` | `69c5981008d9074f18a73e5b59ceb5ae632b990966af242a996a78db6be55e59` |
| `tmp/fuji-426/native-ledger3-a4-events.jsonl` | `43104844af8e239d183dd9150c3ce8c1324ce2c99440abdde257119e9de0e711` |
| `tmp/fuji-426/native-ledger3-a4.stdout` | `8b8a00f79901c3752e7e69c10aff5877665ccbfef3c6ff20836216458af220b6` |
| `tmp/fuji-426/native-ledger3-a4.stderr` | `852ab6b8630555bf412d8648c31f0b9e6c39c2622d02e56a73477ebc38e53a38` |

The temporary driver and raw logs remain in scratch while the remaining gates and implementation review are open.
