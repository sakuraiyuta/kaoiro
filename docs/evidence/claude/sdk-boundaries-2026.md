---
title: Claude SDK notification and permission boundary observations (2026)
status: measured
last_updated: 2026-09-27
---

# Claude SDK boundary observations

These dated observations were moved from the Claude event reference. They
characterize the SDK versions and settings stated below; they do not by
themselves remeasure the current installed SDK. The current wrapper contract
is in [Claude events](../../reference/engines/claude-events.md).

## Task notification terminal paths

**Observed record (task_notification terminal guarantee, issue #170)**: SDK
`0.3.220`, captured 2026-08-09. A disposable script captured a real `query()`
stream and verified that `task_notification` is always emitted along all four
paths: (a) natural subagent completion, (b) `Query.stopTask(taskId)` (emits a
`task_notification` with `status: "stopped"`, as documented), (c) parent-session
interrupt, and (d) `Query.backgroundTasks(toolUseId?)` (emits a
`task_notification` on settlement after being backgrounded). Paths through
`task_updated` also always converge on `task_notification` at termination.

## canUseTool firing boundary

To verify the broker → permission dialog → client approval path through the
dashboard on a real machine, a command is needed that reaches `canUseTool`
without being stopped by the SDK's built-in safe Bash classifier. Observed
boundaries (2026-06-22, verification for #59):

| Example | Path |
|---|---|
| `hostname` / `echo X` / `[ -f X ] && echo Y` | Classifier judges safe → auto-approve |
| `mkdir -p /tmp/...` | Treated as within the sandbox → auto-approve |
| `for f in ...; do ...; done` | Cannot statically analyze control syntax → ask → `canUseTool` fires |
| `curl --version` | Network-command name → ask → `canUseTool` fires |

For the most stable firing with no side effect, use **`curl --version`** (no
actual communication, small output, always succeeds). With default
`settingSources`, the SDK does not read `~/.claude/settings.json`, so a user's
settings allow list and PreToolUse hooks (such as `approve-compound-bash.sh`)
do not apply to SDK sessions through the wrapper — the boundaries above are
solely from the SDK's built-in classifier.
