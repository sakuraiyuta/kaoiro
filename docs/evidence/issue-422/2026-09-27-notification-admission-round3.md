---
title: Issue 422 notification admission review round 3
status: superseded
last_updated: 2026-09-27
---

# Issue 422 notification admission review round 3

## Artifact and decision

This is a fix-forward change on the landing candidate after `3b673672`. The approved design remains `690913dd` (SHA-256 `c6ceffc660833eab720aa652cc82ccd6f179604a99e0775d95f626877d4671ab`). The round-2 review accepted the actual peer-input (a)/(b) measurements and the ambiguous-result terminal freeze, then found that the frozen owner could still send. The director chose to retain the fail-stop policy, revoke model-initiated send authority, and use the current terminate/disconnect/restore path for recovery.

`AgentHost` now freezes `ToolOrigins` when admission stops. This aborts captured current and independent notification origins, refuses new bindings, and remains frozen across a later SDK session init. The CLI also passes its admission state to `InterAgentTool`; `invoke` checks it on entry and again at the dispatch boundary after any CID-lock wait. This second check covers a call that began before the freeze but had not sent. Internal failure notices use a separate path and retain their terminal reporting role. The unresolved wrapper owner is still settled only on stream teardown, once; no ambiguous result is reclassified as a successful terminal.

## Controlled reproduction and permanent tests

Kogane's unchanged `kogane422r2-review.test.ts` (SHA-256 `6df6a1dc5b8b3e10c9c1ef6b0d729298856478b390c5243cae979eefff6a3f4d`) was copied into this worktree, run, and removed. Its controlled SDK iterator used the real `AgentHost`, `ToolOrigins`, and `InterAgentTool`. Exit 0, two tests passed. The normal T2 control made two sends with bases `[3,3]`; the frozen case reported `state=error`, no T2 `onTurnEnd` before teardown, captured signal aborted, and **zero** sends from both a captured call and a new `PreToolUse` call. Its output is `tmp/fuji-422/r3-reviewer-test-final.log`.

The permanent `notification_outbound_freeze.test.ts` repeats the actual Host-origin boundary and checks the final teardown. The common tool test separately keeps wrapper token T and independent notification token N live while changing send admission to false: both are rejected locally with `admission_fail_stop` and `send_not_attempted=true`, with no additional sink attempt. Another test puts a call behind the CID lock, freezes admission while it waits, and checks the pre-dispatch rejection. The CLI composition test uses the `runClaudeCli` constructor wiring: one pre-freeze send is accepted, then the same token and an independent notification token both produce local rejection and no second sink attempt. These tests cover the send decision as well as origin invalidation.

| Removed mechanism | Focused red | Byte restoration and focused green |
| --- | --- | --- |
| `AgentHost` call to `ToolOrigins.freeze()` | `r3-host-final-mutation-red.log`, exit 1; captured signal remained live | `r3-host-final-restored-green.log`, exit 0 (2/2) |
| `InterAgentTool` admission recheck after CID lock | `r3-send-guard-mutation-red3.log`, exit 1; waiting call reached the sink | `r3-send-guard-restored-green.log`, exit 0 (26/26) |
| CLI's admission callback wiring | `r3-cli-wiring-mutation-red2.log`, exit 1; post-freeze call reached the sink | `r3-cli-wiring-restored-green.log`, exit 0 (8/8) |

The current source SHA-256 values are `4154636f930e26eda050af56e71045a5288a909c6a3a8e65e348b25bec516fe6` for `tool_origins.ts`, `c99d3e8a84462b75709dc4caad91e9c588bdb5f3b15c629f8b29c670174f51ab` for `inter_agent.ts`, `8d995be808def64211f007e1a848b5c9d12be58e626b7ca5193a07f0174456ce` for Claude `host.ts`, and `02dce08e3d9aef92c4c119060b6d4a4e0bec255fc7d4163cb878b8aa28aaac90` for Claude `cli.ts`. Their restored test source hashes and full gate results are reported with the submitted HEAD. The round-2 raw CLI logs remain in `tmp/fuji-422` for review.

## Recovery and native-gate scope

The [Claude events reference](../reference/engines/claude-events.md#recovering-a-fail-stopped-claude-wrapper) now gives the actual operator sequence: observe `state=error` and the stderr reason, terminate the affected wrapper from its card, wait for `disconnected`, restore it, then verify an idle or waiting-input live wrapper and accepted new input. The CLI stderr includes that document path. A live `error` agent cannot be restored directly, and session reset does not accept that state. Neither server reply-basis comparison nor reset admission rules changed.

At the time of this preliminary record, no new model API call had been made. The director subsequently required a real-CLI rerun on the final build because the shared send guard could affect normal notification sends. [The final native-gate record](2026-09-27-issue-422-notification-admission-round3-native.md) supersedes this paragraph's test-only inference and records the new API dispatches, actual server outcomes, and independent notification controls.

The full wrapper build/typecheck/test and runner typecheck/test are run on the clean landing candidate after this evidence is committed. Exit codes, counts, and warnings are retained in `tmp/fuji-422` and reported to the director with that HEAD.
