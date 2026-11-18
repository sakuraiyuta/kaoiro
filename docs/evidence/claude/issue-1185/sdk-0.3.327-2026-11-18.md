---
title: Claude Agent SDK 0.3.327 bump
status: measured
last_updated: 2026-11-18
description: The record for raising @anthropic-ai/claude-agent-sdk from 0.3.321 to 0.3.327 in wrapper/claude-code, with the hook heartbeat's effect on the turn watchdog, the hook timeouts and the permission-mode measurements the bump needed.
---

# Claude Agent SDK 0.3.327 bump

[Issue #1185](https://github.com/sakuraiyuta/kaoiro/issues/1185), following
the [Agent SDK bump checklist](../../../contributing/agent-sdk-bump.md) with
the fixes of [issue #1184](https://github.com/sakuraiyuta/kaoiro/issues/1184).
Pin commit `7bb4bf45` on `develop` `c9723287`. Exit condition X4 is met, so
the bump went through a full design and design review
([design, revision 3](https://github.com/sakuraiyuta/kaoiro/issues/1185#issuecomment-6971886715));
class L because the operator can see the changes below.

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
| SDK 0.3.323 | "Added the periodic `tool_progress` heartbeat while a turn waits on long-running hooks" | every SDK frame is turn progress (`host.ts:3344` → `cli.ts:1405-1406`); measured below |
| SDK 0.3.323 | "Changed what happens when a tool's permission check fails with an error after a `PreToolUse` hook allowed the call: it now goes to `canUseTool`, or is refused when there is no callback" | kaoiro's PreToolUse returns `{}` or `updatedInput`, never allow; reaches only through operator hooks |
| CLI 2.1.326 | "Improved how a PreToolUse hook's `updatedInput` is kept when more than one hook answers a tool call; the rewrite now runs in more cases" | `host.ts:3218-3231` with user hooks; the kaoiro rewrite is kept in more cases |
| CLI 2.1.323 | "Fixed a resumed session joining your next message to an old interrupted message that was not resumed" | resumed peers; a fix |
| CLI 2.1.323 | "Fixed `--permission-mode auto` or a settings `defaultMode: auto` starting in a mode that could allow more when auto mode was unavailable. It now starts in Manual mode, which asks first" | peers in auto mode; measured below |
| CLI 2.1.326 | "Changed some tool calls in bypass permissions mode to ask for approval, or be denied where no one can be asked" | peers in bypass mode; measured below |
| CLI 2.1.327 | "Improved the speed of a session's first Bash command: shell start-up files may now run before it's approved, even if it's refused" | every peer; measured below |
| CLI 2.1.323 to 2.1.327 | further permission entries (more Bash, PowerShell, `cp`/`mv`, path and sandbox prompts or denials), not quoted one by one | relayed by `canUseTool`; operator-visible |

## Hook heartbeat and the turn watchdog

From the code: each SDK frame calls `TurnWatchdog.progress`, which restarts
the full inactivity interval (`turn_watchdog.ts:206-215`). A heartbeat during
a hook therefore restarts the interval, and the watchdog keeps running.

### Through the host

A throwaway probe calls `runClaudeCli`, which builds the real `AgentHost` and
turn watchdog with the CLI's own `onTurnStart`, `onTurnEnd` and
`onTurnProgress` forwarding. It is not the production composition: the probe
supplies its own `queryFn` (a forwarding proxy over the SDK `query`), a
scripted provider, a spawn function, `cwd`, `env`, `tools`,
`settingSources: ["user"]` with a scratch settings file and a stub server
link, in `bypassPermissions`. Production passes no `settingSources`; the
pinned SDK loads all sources when the option is omitted. No real model. The
watchdog is set to 60 seconds, 150 in the last hook case. The hook is a
settings-file `PreToolUse` command hook on `Bash`.

| Case | 0.3.321 | 0.3.327 |
|---|---|---|
| Hook `sleep 75`, no `timeout` | no heartbeat; watchdog interrupt at 60.6 s, result `error_during_execution` | heartbeats at 30.6 and 60.6 s; no interrupt; `success` at 75.7 s |
| Hook `sleep 200`, `timeout: 90` | watchdog interrupt at 60.6 s, before the hook timeout | heartbeats at 30.6, 60.6 and 90.6 s; the turn went on at 90.6 s; `success` at 90.7 s |
| Hook `sleep 200`, `timeout: 90`, watchdog 150 s | no heartbeat; the turn went on at 90.7 s; no interrupt; `success` | heartbeats at 30.6, 60.6 and 90.6 s; the turn went on at 90.7 s; `success` |
| No hook; Bash running 75 s | heartbeats at 30.6 and 60.6 s; no interrupt; `success` | the same |
| `Read`, then `Write` of the CLI's credentials file | written | refused: "Claude Code keeps its sign-in tokens here; tools cannot write them" |

The 0.3.321 interrupt at 60 seconds shows that the watchdog is live in the
probe. The long-Bash case shows that tools already sent heartbeats on both
pins; the bump extends that to hooks. The 150-second case shows the command
hook's `timeout` cancelling `sleep 200` at 90 seconds on both pins; without
it, the hook would have run into the watchdog. It is a controlled case, not a
bound for a turn.

### SDK directly

A throwaway probe calls the SDK `query` with a scripted provider, no settings
sources, `bypassPermissions`, and one `PreToolUse` callback hook on `Bash`
that sleeps until its abort signal fires. No kaoiro code runs.

| Callback | 0.3.321 | 0.3.327 |
|---|---|---|
| Sleeps 700 s, no `timeout` | aborted at 600.0 s; no heartbeat; `success` | aborted at 600.0 s; 19 heartbeats, 30 s apart; `success` |
| Sleeps 20 s, `timeout: 5` | aborted at 5.0 s; `success` | aborted at 5.0 s; `success` |

### Effect

- Recovery from inactivity can be delayed by a hook with any timeout,
  including the default: the interval restarts at the hook's last heartbeat,
  not at the last frame before the hook. Hooks in a row add up, so one hook's
  timeout does not bound the delay for a turn. Example derived from the code,
  not measured: with a 30-minute limit, a hook whose last heartbeat is at 9
  minutes and no frame after it, 0.3.321 can interrupt at about 30 minutes
  and 0.3.327 at about 39.
- A hook whose timeout is longer than the inactivity limit keeps the watchdog
  from firing while it runs (measured above at 60 seconds).
- Option A of the design: accept this with a release note and no code.
  Filtering hook heartbeats out of watchdog progress (option B) would be a
  separate unit.

No test drives the watchdog with a real SDK frame or with `tool_progress`. At
`8c8d2048`, the tracked files under `wrapper/claude-code` outside `src/` that
mention `watchdog` are seven test files. They use injected timers, fake frames
or direct calls to the fail-stop paths. None imports the SDK's `query` as a
value, and no `*_native` test mentions the watchdog.

## Permission changes

A throwaway probe calls the SDK `query` directly (not kaoiro's host) with a
scripted provider that makes one tool call, a `canUseTool` that denies, and a
scratch home with dummy credentials. Six calls (read-only `git -C` on another
repository, `cp` in the project, `cat` and `Write` of the CLI's credentials
file, `Read` of `/proc/self/status`, and `true` with shell start-up files that
leave a marker) in `default`, `auto` and `bypassPermissions`, on both pins.
Of the 18 pairs, one differs: the bypass `Write` to the credentials file,
also measured through the host above. With the scripted provider auto mode is
unavailable: both pins keep reporting `auto` and refuse Bash with "Auto mode
is unavailable", and neither starts in Manual. No shell start-up file ran
before a denied command on either pin. Four real-model queries on
`claude-haiku-5-5` in `auto` (two model turns each: the other-repository
`git` read and `cp`, on each pin) ran both commands without asking on both
pins.

`applyFlagSettings` resolves for both shapes kaoiro sends,
`{effortLevel: "high"}` and `{effortLevel: null}`, on both pins. A malformed
`permissions` value is rejected only on 0.3.327; `{effortLevel: "bogus"}`
resolves on both. This shows that the shapes are accepted, not that the
setting takes effect.

## E1 to E4

Local `bwrap` run of the harness README's command on `8c8d2048` (isolation
`bwrap`, Node v22.23.4, uid 1000). Harness hashes unchanged (`probe.mjs`
`e9cc98e0…`, `seam.mjs` `bbf78270…`, `checker.mjs` `da799010…`, `judge.mjs`
`919e0ef3…`). Native self-report `2.1.327 (Claude Code)`, sha256
`343c744b…6ac9`. `PASS 55, FAIL 0`; `ALL NEGATIVE CONTROLS BIT`.

## Checks

| Check | Result |
|---|---|
| Pre-landing CI | run on the landing head; recorded with the landing |
| `haiku55_native` | 4 of 4 |
| Catalog probe, base and candidate | 14 rows each, identical |

## Exit conditions

| Condition | Met | Basis |
|---|---|---|
| X1 | no | no kaoiro source or test claim has to change |
| X2 | no | shape unchanged; 74 lockfile lines inside the allowed set |
| X3 | no | 55 PASS, controls bit, harness unchanged |
| X4 | **yes** | the hook heartbeat reaches the turn watchdog, and no test covers that path; the credentials-file refusal is relayed vendor behaviour |
| X6 | no | 0.3.327 was `latest` when chosen |
| X7 | no | Claude |

## Release-note candidates

- A peer in `bypassPermissions` can no longer write the Claude CLI's
  credentials file with the `Write` tool; the call is refused and the turn
  goes on.
- While a hook runs, Claude Code now reports progress every 30 seconds, and
  kaoiro's turn watchdog counts that as activity. If a turn stops producing
  output after a hook, the watchdog can fire up to the hook's run time later
  than before; several hooks in a row add up. A hook whose timeout is longer
  than the watchdog's inactivity limit (30 minutes by default) keeps the
  watchdog from firing while it runs.
- Vendor permission changes (2.1.323 to 2.1.327) were not reproduced on the
  measured calls; other calls may now ask or be refused.

## Limits

- CLI 2.1.324 is unread.
- The delay example above is derived from the code, not measured.
- Not measured: the default timeout of settings-file command hooks, and hook
  events other than `PreToolUse`.
- The host probe is not the production composition (see above). The
  permission measurements go through the SDK directly; auto mode was measured
  unavailable (scripted) and available (two calls, real model) only.
- The search for watchdog tests covers `wrapper/claude-code` at `8c8d2048`.
