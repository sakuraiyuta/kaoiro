---
title: Claude Agent SDK 0.3.327 bump
status: measured
last_updated: 2026-11-18
description: The record for raising @anthropic-ai/claude-agent-sdk from 0.3.321 to 0.3.327 in wrapper/claude-code, with the hook-timeout bound and the permission-mode measurements the bump needed.
---

# Claude Agent SDK 0.3.327 bump

[Issue #1185](https://github.com/sakuraiyuta/kaoiro/issues/1185), following
the [Agent SDK bump checklist](../../../contributing/agent-sdk-bump.md) with
the fixes of [issue #1184](https://github.com/sakuraiyuta/kaoiro/issues/1184).
Pin commit `7bb4bf45` on `develop` `c9723287`. The same range was first run on
a throwaway branch ([issue #1168](https://github.com/sakuraiyuta/kaoiro/issues/1168) V4).

## Versions

| Item | Before | After |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` range | `^0.3.321` | `^0.3.327` |
| Bundled CLI | 2.1.321 | 2.1.327 |
| Native self-report | `2.1.321 (Claude Code)` | `2.1.327 (Claude Code)` |

Chosen 2026-11-18T03:14:44Z with `dist-tags.latest` and `next` at `0.3.327`.
No version skipped.

## Dependency shape

`peerDependencies`, `exports`, `engines.node` and the eight platform packages
are unchanged. The lockfile changes 74 lines, all in the allowed set of
ADR-0074 (the importer's `specifier` and `version`, and the SDK and platform
entries in `packages` and `snapshots`); resolved peers are unchanged.

## Changelogs

SDK 0.3.322 to 0.3.327 and CLI 2.1.322 to 2.1.327 read in full; CLI 2.1.324
has no published section.

| Version | Entry (verbatim) | kaoiro path |
|---|---|---|
| SDK 0.3.327 | "Breaking: Changed hook options to require arrays: a hook event's value and a matcher's `hooks`." | `host.ts:3212-3256` passes arrays; no change |
| SDK 0.3.327 | "Deprecated `createSdkMcpServer()` servers in an agent's `mcpServers`" | kaoiro registers at top level (`cli.ts:1649`); no change |
| SDK 0.3.323 | "Added the periodic `tool_progress` heartbeat while a turn waits on long-running hooks" | every SDK frame calls `onTurnProgress` (`host.ts:493-497`), measured below |
| SDK 0.3.323 | "Changed what happens when a tool's permission check fails with an error after a `PreToolUse` hook allowed the call: it now goes to `canUseTool`, or is refused when there is no callback" | kaoiro's PreToolUse returns `{}` or `updatedInput`, never allow; reaches only through operator hooks |
| CLI 2.1.326 | "Improved how a PreToolUse hook's `updatedInput` is kept when more than one hook answers a tool call; the rewrite now runs in more cases" | `host.ts:3218-3231` with user hooks; the kaoiro rewrite is kept in more cases |
| CLI 2.1.323 | "Fixed a resumed session joining your next message to an old interrupted message that was not resumed" | resumed peers; a fix |
| CLI 2.1.323 | "Fixed `--permission-mode auto` or a settings `defaultMode: auto` starting in a mode that could allow more when auto mode was unavailable. It now starts in Manual mode, which asks first" | peers in auto mode; measured below |
| CLI 2.1.326 | "Changed some tool calls in bypass permissions mode to ask for approval, or be denied where no one can be asked" | peers in bypass mode; measured below |
| CLI 2.1.327 | "Improved the speed of a session's first Bash command: shell start-up files may now run before it's approved, even if it's refused" | every peer; measured below |
| CLI 2.1.323 to 2.1.327 | further permission entries (more Bash, PowerShell, `cp`/`mv`, path and sandbox prompts or denials), not quoted one by one | relayed by `canUseTool`; operator-visible |

**Hook heartbeat** (SDK 0.3.323: "Added the periodic `tool_progress`
heartbeat while a turn waits on long-running hooks"). Every SDK frame counts as
turn progress (`host.ts`, `onTurnProgress`), so the 30-minute turn watchdog
does not advance while a hook runs. kaoiro's hook callbacks set no `timeout`,
so the event default applies: 600 seconds, 30 for `UserPromptSubmit`
([SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks), "Hook
timeout"). Measured on 0.3.327 with a scripted provider: a `PreToolUse`
callback with no `timeout` that sleeps 700 seconds was cancelled 600.0
seconds after it started; 19 heartbeats arrived 30 seconds apart, the last
at 570 seconds, and the turn then completed. With `timeout: 5` the callback
was cancelled at 5.0 seconds. A hook therefore holds the watchdog for at most
its own timeout, not indefinitely.

**Permission changes** (CLI 2.1.323 to 2.1.327). Measured with a scripted
provider, one tool call per run, the host's `canUseTool` denying, on both pins:
six calls (read-only `git -C` on another repository, `cp` in the project,
`cat` and `Write` of the CLI's credentials file, `Read` of `/proc/self/status`,
and `true` with shell start-up files that leave a marker) in `default`, `auto`
and `bypassPermissions`. Of the 18 pairs, one differs: in `bypassPermissions`
a `Write` to the credentials file now fails with "Claude Code keeps its sign-in
tokens here; tools cannot write them", where 0.3.321 wrote it. With the
scripted provider auto mode is unavailable: both pins keep reporting `auto`
and refuse Bash with "Auto mode is unavailable", and neither starts in Manual.
No shell start-up file ran before a denied command on either pin. Four
real-model queries on `claude-haiku-5-5` in `auto` (two model turns each: the
other-repository `git` read and `cp`, on each pin) ran both commands without
asking on both pins.

## E1 to E4

Local `bwrap` run of the harness README's command (isolation `bwrap`, Node
v22.23.4, uid 1000). Harness hashes unchanged (`probe.mjs` `e9cc98e0…`,
`seam.mjs` `bbf78270…`, `checker.mjs` `da799010…`, `judge.mjs` `919e0ef3…`).
Native sha256 `343c744b…6ac9`. `PASS 55, FAIL 0`; `ALL NEGATIVE CONTROLS BIT`.

## Checks

| Check | Result |
|---|---|
| Pre-landing CI | run on the landing head; recorded with the landing |
| `haiku55_native` | 4 of 4 |
| Catalog probe, base and candidate | 14 rows each, identical |

## Exit conditions

| Condition | Met | Basis |
|---|---|---|
| X1 | no | the pin commit touches only `package.json` and the lockfile |
| X2 | no | shape unchanged; 74 lockfile lines inside the allowed set |
| X3 | no | 55 PASS, controls bit, harness unchanged |
| X4 | no | the hook heartbeat is bounded by the hook timeout above; the permission changes are relayed vendor behaviour |
| X6 | no | 0.3.327 was `latest` when chosen |
| X7 | no | Claude |

## Release-note candidates

- A peer in `bypassPermissions` can no longer write the Claude CLI's
  credentials file with the `Write` tool.
- While a hook runs, the turn watchdog waits for the hook's own timeout
  before counting inactivity.
- Vendor permission changes (2.1.323 to 2.1.327) were not reproduced on the
  measured calls; other calls may now ask or be refused.

## Limits

CLI 2.1.324 is unread. The permission measurements cover six calls in three
modes through the SDK directly, not through kaoiro's host; auto mode was
measured unavailable (scripted) and available (two calls, real model) only.
A hook timeout set higher than 30 minutes in a peer's settings would keep the
watchdog from firing for that long; none of the measured settings does.
