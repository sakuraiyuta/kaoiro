---
title: Root agent-message envelope correlation audit
status: preliminary
last_updated: 2026-09-28
---

# Root agent-message envelope correlation audit

This read-only audit covers every `*events.jsonl` file still present under
`tmp/fuji-426/`: 63 logs, including failed startup runs and the duplicate
`four16-negative` log. The [input manifest](2026-09-28-a6-inputs.sha256)
records SHA-256 for all 63 logs and 42 root CLI transcripts used to recover
full prompt text. The manifest SHA-256 is
`b43d1094a233c1da8dcdf7c5394945d4513c685e67a06d2013f82e7e9290a789`.
`sha256sum -c` passed for all 105 entries; changing one digest made it fail.
The disposable audit script's positive case, altered-final-line negative
case, and ordinary-prose control also passed.

The 63 logs contain 294 root `UserPromptSubmit` records: 109 start with
`<agent-message`, and 111 start with `<task-notification>`. One log copies
the same four-Agent run, so de-duplicating by session, timestamp, prompt ID,
and prompt prefix leaves 285 root hooks, 105 `agent-message` hooks, and 107
task-notification hooks. Counts below use these **105 distinct** agent-message
hooks. This is a finite observation, not a CLI guarantee.

## Outer frame and source hook

| Question | Result | Limit |
| --- | --- | --- |
| First line exactly `<agent-message from="TASK">`, with a 17-character alphanumeric task ID and no other attribute | 105/105; no counterexample | Six old direct-CLI hooks retain only the first 220 characters, but that includes the complete first line. |
| Final line exactly `</agent-message>` with no trailing text | 99/99 full prompts; no counterexample | Six old direct-CLI hooks were truncated and have no persisted root transcript, so their last line is unverified. |
| Earlier child `PreToolUse:SubagentHandback` or `PreToolUse:SendMessage` with matching `agent_id` in the same run | 105/105 by log ordering; no hookless envelope | For 13 early hooks the recorder omitted child `session_id`; same-session equality cannot be independently checked for those. |
| Child hook and root prompt carry the same recorded `session_id` | 92/92 comparable; no counterexample | The other 13 child hooks lack the field. |
| Child hook timestamp strictly precedes root hook timestamp | 99/99 comparable; no counterexample | Six direct-CLI hooks have no timestamp; their hook records still precede the prompt records in file order. |
| Hand-back root prompt has the fixed disclaimer as its second line | 94/94 full hand-back prompts; no counterexample | Six truncated direct-CLI prompts show its prefix but cannot prove the whole line. The sanitized `sendmsg-file1` prompt still has the fixed disclaimer on line two. |
| SendMessage root prompt has the fixed hand-back disclaimer on line two | 0/5; all five have different second lines | Two older SendMessage hooks omitted `to` in the recorder; their child transcripts confirm `to=main`. |
| Task-notification prompt starts with `<task-notification>` | 107/107 distinct observed task-notification hooks | No observed notification hook starts with `<agent-message`. |

The source-kind split is 100 hand-back prompts and five SendMessage prompts.
All 105 have a recorded earlier child hook with the same task ID. The 13
missing-session cases are in `auto1`, `ledger2`, `four2`, `four3`, and `four4`,
whose early recorder version did not capture that child field. The six
unverified final lines all come from `hook-events.jsonl`, a direct CLI probe
whose root transcript was not persisted. They are **not** counted as exact
outer frames.

## Simultaneous occurrence kinds

The `native-r1fix-four-seq1-events.jsonl` run has two tasks with both kinds
pending at once. A second SubagentHandback hook for task
`ab0d20a5bbe1ed1c2` arrived at 14:12:21.263Z, then its SendMessage hook at
14:12:26.957Z. For task `a4b387e8792fd28af`, the corresponding times are
14:12:21.687Z and 14:12:27.063Z. Their later root prompts arrived at
14:12:34.833Z and 14:12:34.870Z; both lack the hand-back disclaimer on line
two and correspond byte-for-byte to the SendMessage messages from those
child transcripts. The earlier same-task hand-back occurrences were distinct
and still pending at that moment. No other run in this log set shows both
kinds simultaneously pending for one task. The two cases demonstrate why
task ID alone cannot choose a pending occurrence kind.

The audit does not prove a general collision rule for a child SendMessage
whose body itself begins with the exact fixed hand-back disclaimer. No such
body appeared. It also cannot prove that an unseen CLI version keeps the
outer frame or task ID length. Those shapes must remain subject to the
admission gate.
