---
title: Claude Agent SDK 0.3.319 bump, fold premises and catalog measurement
status: measured
last_updated: 2026-11-07
description: The dated record for raising @anthropic-ai/claude-agent-sdk from 0.3.306 to 0.3.319 in wrapper/claude-code — changelog reads, the E1 to E4 fold re-measurement, the native checks and the limits.
---

# Claude Agent SDK 0.3.319 bump, fold premises and catalog measurement

This record covers the six steps of the
[Agent SDK bump checklist](../../../contributing/agent-sdk-bump.md) for
`wrapper/claude-code`. Everything below is bound to the commits and artifact
hashes named here; a later change to any of them invalidates the measurement.

## Versions, commits and artifact identity

| Item | Before | After |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` range | `^0.3.306` | `^0.3.319` |
| Bundled CLI (installed `manifest.json` `version`) | 2.1.306 | 2.1.319 |
| Native executable self-report | 2.1.306 (Claude Code) | `2.1.319 (Claude Code)` |

Commits on `issue-1044-claude-sdk-bump`:

| Commit | Contents |
|---|---|
| `c0288185f9a3744c6d992b8705b3c4e9f50bd3ad` | the pin and the lockfile |
| `c96efe5b7bcc21e0bd08770f6efc636187d8b213` | the three native version tripwires re-pinned |

Artifact identity, read from the installed tree at `c0288185`:

| Artifact | sha256 |
|---|---|
| `sdk.mjs` | `71460e29f72859dbc65a613e3737c834b4afa4b6411716fd7b596f9c5e129b76` |
| native `claude` (linux-x64), 340226576 bytes | `dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed` |

The native binary's measured sha256 equals the `platforms["linux-x64"].checksum`
the package's own `manifest.json` declares, and its size equals the declared
`size`. Positive control for that comparison: the same method applied to
0.3.306 matched its own manifest value (`520bc6c1...`) before the bump.

The installed manifest also records `commit`
`fbdd7e02e8530e4c2ade8cc67d30104e53d2c8f2`, `buildDate`
`2026-11-05T19:38:09Z`, `sdkCompat.harnessSchema` 1 and 30
`testedWrapperVersions` entries spanning 0.3.286 to 0.3.318, which include the
previous pin 0.3.306. Neither version lists itself, so the compatibility
declaration has the same shape as before.

## Step 1: version choice

`0.3.319` — the latest published version, which is the checklist default. On
2026-11-07 the registry packument reported `dist-tags.latest` and
`dist-tags.next` both at `0.3.319`, published `2026-11-06T00:59:53.715Z`.

`0.3.313` is skipped because upstream never published it: the changelog has an
entry for it but the packument does not list it, and that entry only records
parity with Claude Code v2.1.313 with no API addition.

The dependency shape does not move. `peerDependencies` are identical
(`zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk
^1.29.0`), the same eight platform packages stay optional, and the `exports`
map is unchanged. `engines.node` goes from `>=18.0.0` to `>=18.14.0`, below
`wrapper/claude-code`'s own `>=22`. kaoiro imports only the root entry, from
eight call sites, so `prewarm()` on the `./core` entry stays unreachable.

## Classification, release class and the lockfile scope

Classified **L**: one of the six surfaces (the dependency lock) plus a safety
valve (the behaviour of a new SDK and CLI is an unmeasured external premise).
`docs/operations/high-risk-change-release.md` also treats an engine pin change
as high risk for the affected engine.

Release class: **TL only** (turn lifecycle, claude-code engine). **FS does not
apply**, and that is measured rather than predicted: the runner declares no
dependency on the SDK, and on the committed lockfile every changed line falls
inside the bump's own scope.

| Measurement on `c0288185` | Value |
|---|---|
| Changed lines, `pnpm-lock.yaml` | 76 (38 added, 38 removed) |
| Changed lines, `wrapper/claude-code/package.json` | 2 (1 added, 1 removed) |
| Distinct lockfile entries containing a changed line | 21 |
| Changed lines outside the allowed set | **0** |

The allowed set is "an entry whose name contains `claude-agent-sdk`, or the
importer `wrapper/claude-code`". The 21 entries are the main package in four
forms (plain and peer-resolved, old and new), eight platform packages at two
versions, and the importer. Negative control: replacing the allowed set with a
package name that does not exist puts **76 of 76** changed lines outside it, so
the predicate is not vacuously true; allowing only the importer leaves 72
outside, which accounts for exactly the importer's four lines.

The importer's peer resolution moves only its own version: the three resolved
peers (`@anthropic-ai/sdk@0.105.0`, `@modelcontextprotocol/sdk@1.29.0`,
`zod@4.4.3`) are unchanged.

## Step 2: SDK changelog 0.3.307 to 0.3.319

Read in full, including the parity-only releases 0.3.308, 0.3.310, 0.3.313 and
0.3.315: 13 version headings and 47 bullets.

Source: `anthropics/claude-agent-sdk-typescript` `CHANGELOG.md` at `main`
commit `49dd8ef10dd5cb012dc9fe10703376489850c36c` (committer date
`2026-11-06T17:03:45Z`); the fetched text hashes to
`462dd97caf179d45f8603f29dc6921640509b03f393ecc651257939591684223`.

### SDK entries that reach kaoiro

| SDK | Entry, verbatim | kaoiro code path and finding |
|---|---|---|
| 0.3.317 | "Added `onFailure` to hook matchers: with `\"block\"`, a hook that throws or returns invalid output blocks the action" | `host.ts:3098-3146` passes eight hook groups as `{ hooks: [fn] }`; `matcher` and `onFailure` appear nowhere in `src`. The fail-open default is kept; opt-in not taken |
| 0.3.317 | "Added a warning message in the stream when a hook callback fails" | `adapter.ts:182-184` maps `case "system"` to an empty array unless `subtype === "init"`, so the new message is dropped silently. No crash, no surface. Surfacing it is out of scope |
| 0.3.318 | "Fixed the interrupt response missing a message held behind a model change: it is now listed, cancelled with `cancel_queued`, and stopped at start-up as a queued message is" | `host.ts:1846` awaits `interrupt()` and, as the comment at `host.ts:1852` states, does not read the response payload |
| 0.3.319 | "Added MCP task support in SDK sessions (not on Bedrock, Vertex or Foundry): with `CLAUDE_AUTO_BACKGROUND_TASKS=1` and streaming input, an MCP task runs in the background with `task_type` `\"mcp_task\"`" | `host.ts:2328-2341` drops any `task_type` other than `local_bash`, `local_agent`, `local_workflow`; `host.ts:4920-4950` forwards a defined `task_type` to the server, and `wrapper_channel.ex:2767` requires a non-empty string rather than an enum. kaoiro never sets the variable, but `host.ts:3064` inherits `process.env` for the child, so a runner environment could supply it |
| 0.3.317, 0.3.319 | "Added a `session_writes_lost` system message, sent after the last result when a full disk or disk quota kept the CLI from saving the session transcript or ~/.claude.json" / "Changed `session_writes_lost` to be sent only when the CLI exits 0; a run that ends on an error result now gets only the stderr line" | Same `adapter.ts:182-184` drop. A transcript lost to a full disk does not reach any kaoiro surface |
| 0.3.317 | "Removed the `file_unchanged` variant of `FileReadOutput` in `sdk-tools.d.ts`; a repeated Read now returns the file content" | `file_unchanged` appears nowhere in `src` and the `./sdk-tools` entry is not imported. No effect |
| 0.3.318 | "Changed `status` in `PushNotificationInput` to optional" | `PushNotification` appears only in advice text at `continuation_markers.ts:36`; the type is not used. No effect |
| 0.3.318 | "Added an optional `credential_expires_at` field to result messages" / "Added the `config_file_invalid` startup failure reason" | `adapter.ts:157-215` reads only `subtype`, `is_error` and `result`; `startup_failure` appears nowhere in `src`. Added fields are ignored |
| 0.3.314 | "Added `sandbox_required_unavailable` to `startup_failure_reason`" / "Fixed a settings file left out of `settingSources` still supplying some settings, such as auto mode rules and saved permission consents" | `settingSources` appears nowhere in `src`. No effect |
| 0.3.311 | "Added `cacheCreationEphemeral5mInputTokens` and `cacheCreationEphemeral1hInputTokens` to `ModelUsage`, splitting `cacheCreationInputTokens` by cache lifetime" | `host.ts:4605` reports context through `getContextUsage()`. Field addition only |
| 0.3.311 | "Changed background start-up work to wait until the first model request is sent, for about 10 seconds at most, when the first message arrives during start-up" | `turn_watchdog.ts:15-17` defaults are 30 minutes inactivity and a 60 s abort grace, with a 60 s floor, so a start-up wait of up to 10 s stays far inside them |
| 0.3.309 | "Changed `extractFromBunfs()` to extract the embedded CLI into its own per-user temp directory (`claude-agent-sdk-<uid>`, or `claude-agent-sdk` on Windows) instead of Claude Code's temp root" / "Changed `extractFromBunfs()` to reuse an already-extracted file only when its bytes match the embedded binary, replacing it otherwise" | Changes where the native CLI is unpacked. Peers sharing a uid share one directory |
| 0.3.316, 0.3.314 | "Added `permissions.blockReadsExemptPaths` to the `Settings` type: paths, read only from `--settings` and settings the host sends, that `blockReadsOutsideWorkingDirectories` lets through without making them working directories" / "Added `permissions.blockWritesOutsideWorkingDirectories` to the `Settings` type" | kaoiro builds no `Settings` object; permission comes from `permissionMode` (`host.ts:3061-3067`) and `canUseTool` (`host.ts:3147`). Not adopted |
| 0.3.312 | "Added `autoMode`, `skipAutoPermissionPrompt`, `useAutoModeDuringPlan` and `permissions.disableAutoMode` to the `Settings` type" / "Fixed `resolveSettings()` returning mistyped managed auto-mode settings, such as `permissions.disableAutoMode: true`, as written instead of reading them as the CLI does; a user or project settings file whose auto-mode keys hold an invalid value is now skipped, as in the CLI" | kaoiro writes no auto-mode rule, but permission mode `auto` is a member of its closed `PERMISSION_MODES` (`wrapper/core/src/persona.ts:34-41`) and reaches the SDK as `initialMode` (`host.ts:3061-3067`). Auto-mode changes therefore apply to a peer running in that mode; see the CLI permissions table |
| 0.3.312 | "Added `unanswered` (`skipped`, `replied_in_chat` or `dismissed`) to AskUserQuestion answers' per-question `annotations`; send it only when `system/init` lists the `ask_user_question_unanswered_v1` capability" | kaoiro's question broker (`host.ts:2310`) does not announce that capability, so the field is not sent |
| 0.3.307 | "Added `wakeup_source` to the `command_lifecycle` `started` frame of a scheduled wakeup or task, and `scheduled_for` for a wakeup (capability `lifecycle_wakeup_source_v1`)" | `continuation_registry.ts` classifies from `command_lifecycle`. The capability is not announced; an added field would be ignored anyway |

### SDK entries with no kaoiro contact point

The remaining entries touch surfaces kaoiro does not use: `deleteSession()` and
session management (0.3.319, 0.3.317), OpenTelemetry metrics (0.3.319),
`setMcpServers`, `prewarm()` and `SpareProcess.claim()` on the `./core` entry
(0.3.317, 0.3.314), the browser SDK's `supportedDialogKinds` and `onUserDialog`
(0.3.307), the `managedSettings` list (0.3.309), the
`agentProgressSummaries` wait (0.3.318), `initialize_not_first` and
`--await-initialize` (0.3.317), and `readFile()`'s `lossy` plus
`task.description` (0.3.317).

## Step 3: bundled CLI changelog 2.1.307 to 2.1.319

Read in full: 11 version headings and 771 bullets.

Source: the public
[anthropics/claude-code `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
at `main` commit `0ed94698aa0aeee471465fc9c867c2e8434c4d68` (committer date
`2026-11-06T17:03:45Z`, the same commit the 0.3.306 record read); the fetched
text hashes to
`7c124cc46a362ab85dddb66b6b9b18efef761578def15c761c164447a125ad03`.

Gap in the source: there is no heading for 2.1.313 or 2.1.315, although the SDK
records parity with both. That the public changelog does not publish those two
versions' contents is a limit of this record, handled the same way the 0.3.306
record handled 2.1.297 and 2.1.298.

Bullet counts per version: 2.1.319 has 146, 2.1.318 84, 2.1.317 87, 2.1.316 55,
2.1.314 119, 2.1.312 39, 2.1.311 92, 2.1.310 26, 2.1.309 79, 2.1.308 1 ("Bug
fixes and reliability improvements" only) and 2.1.307 43.

Selection follows the checklist's definition of relevant, which is topical:
folding and queued input, permissions, hooks, or model switching. The four
categories are not exclusive, so one entry can belong to several; each such
entry is quoted once, in the category its text leads with, and cross-referenced
from the other. Keyword sets for the four categories were applied to all 771
bullets; every one of the 215 matches (counted across categories) was read and
placed in one of four columns.

| Column | Meaning |
|---|---|
| Reaches kaoiro | a kaoiro code path is named by `file:line` |
| Conditional | it reaches kaoiro under a stated condition |
| Not checked | not checked against a kaoiro path. **Not** a claim that it does not apply |
| Out of topic | the keyword matched in another sense, so the entry is not in the four categories |

| Category | Matches | Reaches | Conditional | Not checked | Out of topic |
|---|---:|---:|---:|---:|---:|
| Folding and queued input | 26 | 14 | 0 | 8 | 4 |
| Permissions | 103 | 25 | 10 | 59 | 9 |
| Hooks | 27 | 10 | 0 | 17 | 0 |
| Model switching | 59 | 21 | 1 | 21 | 16 |
| Total | 215 | 70 | 11 | 105 | 29 |

"Not checked" is deliberately the weaker statement. Where an entry's own
sentence names a surface, that limitation is recorded, but naming a surface
only describes the entry's text; it is not proof that the change cannot reach a
kaoiro path. The absence of a setting in any particular environment is not used
as grounds for non-applicability anywhere in this record.

Every quote below was verified to appear verbatim as a bullet in the fetched
changelog text; a one-word mutation of one quote makes that check fail.

### Folding and queued input

| CLI | Entry, verbatim | kaoiro code path |
|---|---|---|
| 2.1.319 | "Changed PostToolUse hooks to run, with up to 10 seconds to finish, on tool calls that finish after a new message interrupts the turn" | `host.ts:3112-3119`, `#nativePostTool`, `host.ts:2977-2995`, `is_interrupt` |
| 2.1.318 | "Fixed a message sent right after a model change still running after Stop in headless sessions: Stop now cancels or stops it as it would a queued message" | `host.ts:2062-2170`, `setModel`, `host.ts:1846`, `interrupt()`, `inter_agent_turn_coordinator.ts:272-290` |
| 2.1.318 | "Fixed a restarted session re-sending a message that failed with an API error, ahead of the newer message waiting behind it" | `wrapper/core`, `continuation_registry.ts` |
| 2.1.317 | "Changed SendMessage so a message to a running background agent arrives earlier: its running command moves to the background, without being stopped" | `continuation_registry.ts:99-129`, `Agent`, `Monitor`, `SendMessage` |
| 2.1.314 | "Fixed prompts containing tags such as `<bash-stdout>` or `<local-command-stdout>` not being acknowledged to a local stream-json host" | `host.ts:2472-2520` |
| 2.1.311 | "Changed `--output-format json` and `stream-json` output to write DEL, C1 control and Unicode format characters inside strings as `\uXXXX` escapes; parsed values are unchanged" | `checker.mjs`, `includesBytes`, `exact` |
| 2.1.311 | "Fixed interrupting Claude not taking effect until a timeout while an MCP server had not answered a resource read or a skill was still downloading" | `host.ts:1846`, `interrupt()`, `turn_watchdog.ts` |
| 2.1.309 | "Fixed ctrl+enter (send now) only queuing a message when pressed before the response had started, and restarting a prompt's hooks while leaving the message queued when pressed while those hooks were running" | -- |
| 2.1.309 | "Fixed ctrl+o not showing messages from other agents and sessions that are still waiting to be delivered; they now appear in full under the transcript, marked as waiting" | -- |
| 2.1.319 | "Added support for MCP tasks in the terminal: when an MCP server runs a tool call as a task, Claude Code moves it to the background right away and tells Claude the result when it finishes" / "Changed MCP tasks to work in the terminal without feature-flag fetching (Bedrock, Vertex, Foundry, LLM gateways, `DISABLE_TELEMETRY`); set `CLAUDE_CODE_DISABLE_MCP_TASKS=1` to turn them off" / "Added the `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` environment variable to make Claude Code wait for an MCP task inside its tool call instead of moving it to the background right away" | `inter_agent_sdk.ts`, `send_to_agent`, `wait_for_response`, `host.ts:2328-2341` |
| 2.1.312 | "Added click to send: in fullscreen, clicking the \"to send now\" hint under a queued message sends it right away, as its key does" | -- |

### Permissions

| CLI | Entry, verbatim | kaoiro code path |
|---|---|---|
| 2.1.319 | "Added `permissions.denyInsteadOfPrompting` setting: a tool call that would wait on a permission prompt is denied and the turn continues, in terminal sessions, subagents and teammates" | `host.ts:3147`, `canUseTool`, `host.ts:2306`, `setPendingPermission` |
| 2.1.317 | "Fixed a background session sometimes losing a just-made change of permission mode when it was upgraded or retired" | `host.ts:2257-2258`, `#permissionMode`, `host.ts:3061-3067`, `default` |
| 2.1.317 | "Fixed Remote Control and SDK hosts offering \"don't ask again\" on a mod's tool calls" | `canUseTool` |
| 2.1.314 | "Fixed a settings file excluded with `--setting-sources` still supplying some settings, such as auto mode rules and saved permission consents" | `settingSources` |
| 2.1.314 | "Fixed shell and MCP calls that auto mode, a deny rule or a PreToolUse hook blocked, or that otherwise did not run, reading as if they ran in a collapsed tool group" | `adapter.ts:232-300` |
| 2.1.314 | "Added `permissions.blockWritesOutsideWorkingDirectories`: Write, Edit and NotebookEdit refuse paths outside the working directories in every permission mode" | -- |
| 2.1.309 | "Fixed a disabled MCP server being reconnected by a later permission prompt in print and SDK sessions" | `inter_agent_sdk.ts` |
| 2.1.319 | "Fixed a Bash permission bypass where a crafted environment prefix could hide part of a command from permission checks" | `canUseTool`, `bypassPermissions`, `permission_axes.ts` |
| 2.1.319 | "Changed a session's exact Bash or PowerShell ask rule to be refused, not asked about, when a broader deny rule covers the command" | -- |
| 2.1.319 | "Changed Monitor's WebSocket watch to follow a rule on every Bash command: a deny refuses it, and under an ask rule an allow on Monitor, bypass mode or auto mode no longer skips the prompt" | `continuation_registry.ts:88-129`, `host.ts:3147`, `canUseTool` |
| 2.1.319 | "Fixed a case where Bash deny and ask rules missed commands written with quoted words" | `canUseTool`, `host.ts:3147`, `default`, `acceptEdits`, `auto` |
| 2.1.319 | "Fixed needless permission prompts for read-only commands wrapped in a plain `timeout DURATION`, such as `timeout 30 rg foo`" | -- |
| 2.1.319 | "Changed the Bash tool to ask for permission before running `which` with flags outside a lookup/display set" | -- |
| 2.1.319 | "Fixed a case where a `sed` command could skip the permission check in accept-edits and auto mode" | `acceptEdits`, `auto` |
| 2.1.319 | "Fixed a case where `NotebookEdit` changed the wrong cell when the notebook changed while a permission prompt was open" | `host.ts:2306`, `setPendingPermission`, `canUseTool` |
| 2.1.319 | "Fixed a case where auto mode was wrongly refused when a client sent a model change and a request for auto mode back to back" | `host.ts:2062-2170`, `setModel`, `host.ts:2257-2258`, `#permissionMode`, `auto` |
| 2.1.319 | "Fixed auto mode refusing actions without saying why when permission rules or `autoMode` settings are very large: it now explains and, unless `autoMode` deny rules are set, asks you in the terminal" | `auto`, `autoMode` |
| 2.1.317 | "Added a notice when auto mode's check has no answer for a subagent's tool call, which used to leave nothing in the main view" | `auto` |
| 2.1.311 | "Fixed background agents in auto mode that wait on their own shells starting a new main conversation turn on every wake" | `auto`, `continuation_registry.ts:13-15` |
| 2.1.311 | "Changed startup warnings about permission rules in settings files to show once per user until the rule changes" | `host.ts`, `writeRedactedStderr`, `host.ts:1169` |
| 2.1.309 | "Fixed the Bash permission check trusting a variable set by a command whose redirect can fail to open" | -- |
| 2.1.309 | "Fixed Bash permission checks not prompting for some compound commands that change directory before running git when the `cd` is wrapped or prefixed, as they do for a plain `cd`" | -- |
| 2.1.309 | "Fixed an `Edit(path)` deny rule not blocking a Bash redirect to that path in some commands that also held a subshell" | -- |
| 2.1.319 | "Fixed `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` re-running a turn that was interrupted in plan mode when the session resumes in another permission mode" | `#permissionMode` |

### Hooks

| CLI | Entry, verbatim | kaoiro code path |
|---|---|---|
| 2.1.317 | "Added `onFailure: \"block\"` for Agent SDK hook callbacks, so a callback that fails blocks the action instead of letting it run" | `host.ts:3098-3146`, `onFailure`, `matcher` |
| 2.1.312 | "Changed prompt and agent hooks to run at most 24 at a time per session, sub-agents included, plus at most 12 that have waited longer than their event's timeout; a `timeout` under 1 second now counts as 1 second" | -- |
| 2.1.314 | "Fixed hooks matching Bash not running on shell commands started by the Monitor tool; such hooks can block or ask, but not approve or rewrite those commands" | `continuation_registry.ts:88-129`, `continuation_proof.ts:103-107` |
| 2.1.314 | "Changed hook `if` conditions such as `Monitor(tail *)` to match the Monitor tool's shell commands as `Bash(tail *)` matches Bash's" | -- |
| 2.1.314 | "Fixed a PreCompact hook with very large output making compaction fail or repeat; each hook's output is now cut at 10,000 characters" | `request_compact.ts`, `/compact` |
| 2.1.311 | "Fixed `SubagentStop` hooks running about twice a minute for each running subagent instead of once when it finishes" | -- |
| 2.1.318 | "Fixed `claude -p` and Agent SDK sessions reporting success when an API error cut off a reply while a mod hooked `turn.step`" | -- |

### Model switching

| CLI | Entry, verbatim | kaoiro code path |
|---|---|---|
| 2.1.307 | "Fixed model switches through the Agent SDK's `setModel()`, and apps built on it, being refused when the API took more than 5 seconds to confirm the model; Claude Code now waits up to 15 seconds" | `host.ts:2062-2170`, `setModel`, `host.ts:2111`, `current.setModel(value)`, `host.ts:2165`, `modelApplied=false`, `cli.ts:1133` |
| 2.1.312 | "Changed automatic model switches after a flagged message to also cover model names Claude Code doesn't recognize, such as custom deployment names; set `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` to turn them off" | `adapter.ts:642-648`, `refusal_fallback`, `refusal_no_fallback`, `host.ts:4064-4080`, `host.ts:3437` |
| 2.1.314 | "Changed flagged requests to retry on another model, not end in a refusal, when `ANTHROPIC_DEFAULT_OPUS_MODEL`, `availableModels` or `deniedModels` leaves only an older Opus model, or none" | -- |
| 2.1.314 | "Fixed `--resume`, and rewinding past a switch to another model after a refusal, moving a session on a model name Claude Code doesn't recognize to a different model" | `resume_snapshot`, `host.ts:3962-3975` |
| 2.1.314 | "Fixed sessions failing turn after turn with \"Invalid effort level\" when an organization's admin caps a model's effort: Claude Code now lowers the effort, retries, and says which level it uses" | `host.ts:2176`, `source_resolution.ts:3` |
| 2.1.311 | "Changed model names and IDs to drop the `[1m]` suffix and its label on models where the suffix has no effect; the suffix is still accepted" | `probe.ts:243-256`, `initializationResult()`, `supportedModels()`, `wrapper/claude-code/test/fixtures/claude-agent-sdk-0.3.293.models.json`, `docs/reference/engines/claude-model-catalog.md` |
| 2.1.316 | "Deprecated fast mode for Opus 4.8 as of October 30, 2026; it will be removed on November 30, 2026. After removal, fast mode requests on Opus 4.8 return an error and do not fall back to standard Opus 4.8. Migrate to Opus 5.5 to keep the speedup" | `host.ts:1011`, `#fastMode`, `host.ts:1487`, `fast_mode`, `host.ts:3305`, `host.ts:3957` |
| 2.1.316 | "Added `CLAUDE_CODE_SUBAGENT_EFFORT` to set the effort level subagents run at when nothing else names one, instead of inheriting the session's" | `host.ts:3064` |
| 2.1.317 | "Changed subagents and teammates on a different model from the main conversation to use that model's saved effort level or its default, instead of the session's effort level" | -- |
| 2.1.318 | "Changed subagents to stop instead of switching models when \"Switch models when a message is flagged\" is set to \"Ask each time\"" | `refusal_*` |
| 2.1.316 | "Fixed sub-agents that inherited a parent sub-agent's model moving to the main model when a background job or message woke them" | -- |
| 2.1.319 | "Fixed a mistyped model name, such as `opus-5-5`, telling you to update Claude Code instead of suggesting the model you meant" | `host.ts:2062`, `setModel` |
| 2.1.312 | "Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task before the model applied it; they now show the level in force" | `host.ts:2176`, `host.ts:3089`, `#effortSource` |
| 2.1.317 | "Fixed `DISABLE_PROMPT_CACHING_OPUS` and `DISABLE_PROMPT_CACHING_SONNET` having no effect on `[1m]`, other-region and undated spellings of the default model" | `probe.ts:243-256`, `[1m]`, `host.ts:3064` |
| 2.1.316 | "Fixed `/model <id>` not warning when the model isn't recognized by this version and auto-compact will assume a 200K context window" | `host.ts:4605`, `getContextUsage()`, `request_compact.ts` |
| 2.1.314 | "Fixed model switching being refused on machines with managed plugin settings when one of your own `--plugin-dir` or `--plugin-url` plugins had a broken manifest or failed to download" | `host.ts:2062-2170`, `setModel` |
| 2.1.310 | "Fixed requests failing behind some gateways and compatible servers that reject the `effort-2025-11-24` beta value or mid-conversation system messages; Claude Code now retries without them" | `host.ts:3096`, `effort`, `Options` |
| 2.1.307 | "Fixed requests failing with a model-not-found error when `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set and the model is an alias with the `[1m]` suffix, such as `opus[1m]`" | `[1m]`, `host.ts:3064` |

### Outside the four categories

| CLI | Entry, verbatim | kaoiro code path |
|---|---|---|
| 2.1.319 | "Fixed a case where text was dropped from informational messages sent to SDK clients" | `adapter.ts:182-215`, `host.ts` |
| 2.1.319 | "Fixed a case where Agent SDK hosts got a generic exit-code error instead of a failed run's own error message when the disk was full" | `adapter.ts:303-345`, `cli.ts` |
| 2.1.317 | "Fixed `claude -p` exiting 0 when a full disk or quota lost its transcript or ~/.claude.json writes; it now prints an error and, in text and json output, exits 1. Full NFS exports may be missed" / 2.1.314 "Fixed `claude -p` exiting with code 0 and no output when startup failed; it now prints the error and exits 1" | `cli_sigterm_process_exit.test.ts` |
| 2.1.318 | "Fixed a duplicate notification when Claude left the status field out of a PushNotification call" | `continuation_markers.ts:36` |
| 2.1.318 | "Fixed idle compaction replacing a conversation with a reply that was not a summary" / 2.1.311 "Improved compaction: when the model's reply has no summary in it, Claude Code now usually asks for the summary once more before it replaces the conversation" / 2.1.317 "Fixed very long conversations losing their earlier summary when compaction had to shorten its own request" | `request_compact.ts`, `host.ts:4755-4790`, `host.ts:4786-4795`, `compact_resume_native.test.ts` |
| 2.1.311 | "Fixed Claude seeing stale MEMORY.md and CLAUDE.md content right after automatic compaction when those files were edited earlier in the session" | -- |
| 2.1.319 | "Fixed a case where a background agent's later report was lost silently: the notification now says it was refused and how to ask for it" / "Fixed subagents being told after compaction to expect a completion notice for background agents they neither started nor took over" | `docs/evidence/claude/background-notification-admission-2026-10-14.md`, `native_agent_notification_parser.test.ts`, `continuation_proof.ts` |
| 2.1.310 | "Added the Monitor tool and plugin monitors on Bedrock, Vertex, and Foundry, and when telemetry or nonessential traffic is disabled; long foreground sleeps are now blocked there too" | `continuation_registry.ts:88-129`, `monitor_notification_advice_native.test.ts` |
| 2.1.319 | "Fixed `/clear` killing running commands of background agents, teammates and workflows that keep running, and foreground subagents of background agents and teammates" | `request_compact.ts`, `conversation_reset`, `host.ts:4755` |
| 2.1.318 | "Fixed non-interactive launches replacing a `~/.claude.json` that isn't valid JSON with defaults; the start now fails, says how to restore the file, and leaves it as is (anthropics/claude-code#87551)" / "Improved unattended runs (`claude -p`, SDK apps) to stop rewriting `~/.claude.json` on every run when nothing in it changed" | `CLAUDE_CONFIG_DIR`, `tasklist.ts:63` |
| 2.1.318 | "Fixed custom slash commands that fail, or that only Claude can invoke, printing nothing in `claude -p` and SDK sessions" | `host.ts:4317`, `initializationResult().commands` |
| 2.1.317 | "Fixed session titles being lost in cloud and SDK sessions when a new message or Stop arrived while the title was generating" | -- |
| 2.1.316 | "Fixed the SDK `register_repo_root` control request not loading the CLAUDE.md of a directory outside the working directory (with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`)" | `register_repo_root` |
| 2.1.314 | "Improved memory use in long headless and SDK turns that run many subagents: the parent session no longer keeps each subagent's tool results until the turn ends" / 2.1.310 "Improved memory use of non-interactive sessions (`-p`, Agent SDK) during compaction when the transcript file is very large" | -- |
| 2.1.311 | "Fixed `claude -p` and SDK sessions saving transcript messages out of order or keeping messages that were taken back" | `native_transcript.ts`, `NativeTranscriptReader` |
| 2.1.307 | "Fixed a turn sometimes starting without an SDK MCP server's latest tools when a background task was running" | `inter_agent_sdk.ts` |
| 2.1.307 | "Improved recovery from unparseable tool calls: Claude Code now retries the call up to twice before ending the turn with an error" | `turn_watchdog.ts` |

### Conditional entries

| CLI | Entry, verbatim | Condition |
|---|---|---|
| 2.1.319 | "Changed auto mode with telemetry or feature flags off, including behind LLM gateways: calls the server can't check are asked about or denied, with no fallback to the built-in classifier; set `CLAUDE_CODE_AUTO_MODE_SERVER=0` to keep using it (Bedrock, Vertex and Foundry are unchanged)" | the peer's `permission_mode` is `auto` |
| 2.1.319 | "Changed auto mode so that a project's settings files or a plugin can no longer switch its server-side check back on once you have switched it off outside the project" | the operator's settings hold the key the entry names |
| 2.1.318 | "Changed `deniedMcpServers` URL entries to also block Anthropic-provided servers whose upstream URL matches, and connectors in cloud sessions and on self-hosted runners, where the session is given the connector's own URL; otherwise deny a connector by name" | the operator's settings hold the key the entry names |
| 2.1.318 | "Changed `/claude-api managed-agents-onboard` to give a new agent's built-in tools, and a quickstart template's MCP tools, the `auto` permission policy (\"Judge risky actions\") by default, matching the Claude Console; say \"run without asking\" to opt out" | the peer invokes that bundled skill |
| 2.1.316 | "Fixed a managed `autoMode.allow` list without `\"$defaults\"` getting the built-in exceptions back from a host app's `--settings`, a first rule added in `/permissions`, or `/auto-mode-setup`" | the operator's settings hold the key the entry names |
| 2.1.316 | "Changed auto mode so that an `autoMode.allow` list without `\"$defaults\"` no longer removes the built-in rule on scheduled-task prompts" | the operator's settings hold the key the entry names |
| 2.1.314 | "Fixed auto mode reporting a call as blocked, and listing it in `/permissions`, when its safety check gave no verdict" | the peer's `permission_mode` is `auto` |
| 2.1.314 | "Improved auto mode's blocked calls: messages name the command, say Claude may retry and auto mode checks again, and point to `/permissions` to review" | the peer's `permission_mode` is `auto` |
| 2.1.309 | "Fixed Claude asking for permission on each artifact update for the rest of a turn after the conversation was compacted in that turn" | the Artifact tool is used |
| 2.1.309 | "Changed worktree creation and reuse so git no longer fetches objects on demand, in ordinary clones and in partial clones with a Bash sandbox configured; such a partial clone fetches them first" | a worktree-isolated subagent is used |
| 2.1.311 | "Changed `/code-review` to tell Claude to put the effort level first and use max only when asked" | the peer invokes that bundled skill |

### Entries not checked against a kaoiro path

| CLI | Entry, verbatim | What the entry text names |
|---|---|---|
| 2.1.319 | "[VSCode] Fixed Claude carrying out an unapproved plan after a window reload: a step interrupted in plan mode now stops with a notice when the session comes back in another permission mode" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.319 | "[Cloud sessions] Fixed Send now on a waiting message in cloud sessions ending running background agents; they now keep running" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.318 | "Fixed a restarted session dropping its interrupted turn when the restart came right after Claude read a large image or retried a tool call" | the entry text names no surface; not checked against a kaoiro path |
| 2.1.317 | "Self-hosted runner: Fixed Claude not seeing the interrupted tool call when a session moves to a new runner and the turn is older than `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.316 | "Self-hosted runner: Fixed a message sent while Claude was working being answered after a Stop, once the session's process had been replaced" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.314 | "[VSCode] Fixed missing spinner and Stop button while a queued message's hooks run" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.311 | "Fixed ↑ in an agent's chat tab recalling a message that was still waiting to be delivered, so resending it sent a second copy" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.309 | "Self-hosted runner: Improved sessions that move to a new runner: Claude now sees the tool call that was interrupted, marked as outcome unknown" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.319 | "Changed auto mode behind an LLM gateway: `CLAUDE_CODE_AUTO_MODE_SERVER=1` turns on the server-side check even with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set; if managed settings set the latter, they must set the `1` too" | entry text names an LLM gateway or the Claude apps gateway; not checked against a kaoiro path |
| 2.1.319 | "Fixed `claude -p` exiting 0 in auto mode when its actions were refused because no safety check was available: text and JSON output now exit 1" | entry text names the `claude -p` or `claude <subcommand>` entry point; not checked against a kaoiro path |
| 2.1.319 | "Fixed `/status` showing \"Auto mode server: Enabled\" when the server-side review isn't reaching the session, for example behind an LLM gateway that drops it" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.319 | "Fixed the agents view appearing to send a reply to a background session waiting on a permission prompt; the reply now stays in the box with a hint to open the session and answer" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.319 | "Fixed `/permissions` in cloud sessions replying only that it isn't available; it now says where the session's rules live and how to change them" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.319 | "Fixed cloud sessions losing session-scoped deny and ask permission rules, such as those a PermissionRequest hook adds, when the session moves to a new worker" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.319 | "Fixed a case where deny and ask rules, hook matchers and `disallowedTools` entries written with a claude.ai connector's terminal name (`mcp__claude_ai_Slack`) were ignored in Claude Desktop (takes effect once Claude Desktop includes this version)" | entry text names Claude Desktop, the mobile app, or the claude.ai web UI; not checked against a kaoiro path |
| 2.1.319 | "Fixed a sandbox escape when creating a worktree" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.319 | "Fixed self-hosted runners: `--trust-workspace false` now also stops hooks in the repository's settings files and skills from running" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.319 | "Changed `--add-dir` directories to register plugin marketplaces only once that directory's own trust dialog has been accepted" | entry text names an option or a pre-started session the entry names; not checked against a kaoiro path |
| 2.1.319 | "Changed nested skill loading: with the Bash sandbox on, skills in `.claude/skills` folders below the starting folder load only if you start Claude Code there or `/cd` there" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.319 | "Changed cloud sessions to drop session-scoped allow rules at a move to a new worker when their deny and ask rules can't all be kept, so you may be asked again" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.319 | "[VSCode] Fixed Claude carrying out an unapproved plan after a window reload: a step interrupted in plan mode now stops with a notice when the session comes back in another permission mode" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.319 | "[Claude Tag] Fixed saving auto mode allow rules in Claude Tag admin settings overwriting another admin's changes; the save is now refused with a message" | entry text names Claude Tag (Slack) or Code Review; not checked against a kaoiro path |
| 2.1.318 | "Fixed permission prompts being answered by keys typed just after sending a message, or before a slow prompt appeared" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.318 | "Fixed `/logout`, `claude auth logout` and `claude mcp remove` reporting success, and changes to trust, consent or MCP settings being dropped with no word, when the config file could not be updated on a shared network home directory" | entry text names a HOME on a network file system; not checked against a kaoiro path |
| 2.1.318 | "Improved sessions on network file systems to look again when the configuration file is wrongly reported as missing, so fewer start without your MCP servers and trusted folders" | entry text names a HOME on a network file system; not checked against a kaoiro path |
| 2.1.318 | "Changed the `/permissions` rule details, built-in rules and delete confirmation views to use the standard dialog; pressing Ctrl+C twice there now goes back or cancels instead of quitting" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.317 | "Fixed auto mode failing every turn when an LLM gateway set as the base URL answers 403 or 422 to its server-side safety check (a 403 with an apiKeyHelper is unchanged)" | entry text names an LLM gateway or the Claude apps gateway; not checked against a kaoiro path |
| 2.1.317 | "Fixed the second of two simultaneous permission prompts showing no file path or command on claude.ai and the mobile apps" | entry text names Claude Desktop, the mobile app, or the claude.ai web UI; not checked against a kaoiro path |
| 2.1.317 | "Fixed auto mode in cloud sessions stopping for approval when the Artifact tool uploaded, wrote to a database or saved a file through the outputs folder" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.317 | "Fixed agent team teammates in tmux or iTerm2 panes starting in auto mode when the lead session was in manual mode" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.316 | "Fixed `--restricted` sessions uploading files from outside the working directories when a Read allow rule covered them" | entry text names an option or a pre-started session the entry names; not checked against a kaoiro path |
| 2.1.316 | "Fixed cloud sessions and cloud scheduled tasks not being marked as failed when auto mode stopped a turn because the server returned no safety verdict" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.316 | "Fixed `claude -p` text output sometimes not saying why auto mode stopped a turn when a background agent was still running" | entry text names the `claude -p` or `claude <subcommand>` entry point; not checked against a kaoiro path |
| 2.1.316 | "[VSCode] Fixed a conversation coming back in Auto mode after a reload or restart when its plan was approved with \"Yes, and manually approve edits\"" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.314 | "Fixed `claude ultrareview` and `claude remote-control` asking the workspace trust question in a CI job that has a terminal; with `CI` set they now refuse an untrusted folder at once" | entry text names the ultrareview entry point; not checked against a kaoiro path |
| 2.1.314 | "Fixed the `sandbox.excludedCommands` setting description saying listed commands always run outside the sandbox; it now says every command in a call must match an entry" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.314 | "Fixed sandbox protections not applying to a worktree entered by `claude -p --resume` or `--continue`" | entry text names the `claude -p` or `claude <subcommand>` entry point; not checked against a kaoiro path |
| 2.1.314 | "Fixed the session name from /rename disappearing while Claude asks for permission or a plan decision, so side-by-side sessions stay identifiable" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.314 | "Improved `/permissions` review tab, now called Recently blocked: the footer says what Esc will do with marked rows" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.314 | "Improved permission prompts: a long reason takes fewer rows, so it pushes the command being approved off the screen on fewer terminals" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.314 | "Changed `/ultrareview` to check workspace trust before it runs git, as `claude ultrareview` does" | entry text names the ultrareview entry point; not checked against a kaoiro path |
| 2.1.314 | "Changed `/permissions` Recently blocked to refuse approving a call you can't read in full, including one the terminal is too short to show" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.314 | "Changed auto mode in Cowork cloud sessions: a hook's allow of an MCP tool call now counts as no answer, so the classifier or a permission prompt decides" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.314 | "[Cloud sessions] Fixed the permission mode picker staying on Auto after a running cloud or Remote Control session refused the switch; it now shows the mode in use and tells you" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.314 | "[Remote Control] Fixed the permission mode button in Remote Control sessions showing the wrong mode until you typed; while your computer is online it now shows the real mode on open" | entry text names Remote Control; not checked against a kaoiro path |
| 2.1.311 | "Linux: Fixed sandboxed Bash commands failing with `bwrap: Can't create file` when a `--plugin-dir` folder was also an added directory and `permissions.blockReadsOutsideWorkingDirectories` was on" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.311 | "Improved screen reader mode: deleting a rule in /permissions says \"Deleted allow rule …\" right away" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.310 | "Fixed file read permission prompts not showing where a symbolic link leads" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.310 | "Windows: Fixed PreToolUse and PermissionRequest hooks letting a tool call through when Git Bash is missing and the hook's command is only quoted strings, such as a quoted path" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.310 | "Improved auto mode's prompt before the first read outside the working directories: it now says when blocking those reads makes shell commands ask for permission" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.310 | "Linux: Improved `/sandbox` and the sandbox startup warning to name Ubuntu's AppArmor restriction on user namespaces, and how to lift it, when it keeps bubblewrap from starting the sandbox" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.310 | "[Cloud sessions] Added Claude Code cloud sessions and Remote Control permissions to Enterprise custom roles, so Owners can control access to each by role" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.310 | "[Cloud sessions] Changed turning on Cloud sessions or Remote Control in admin settings to ask for confirmation and list the custom roles that have that permission" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.309 | "Fixed sandboxed Bash commands on macOS and Linux running the shell's startup files outside the sandbox before each command" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.309 | "Fixed macOS sandbox `denyWrite` glob patterns not applying at a path's real location when the pattern's folder is reached through a symlink" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.309 | "Fixed sandboxed commands and auto-accepted edits being able to modify the MCP config file passed with `--mcp-config`" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.309 | "Fixed Read reporting \"File does not exist\" for PDF page ranges in Linux sandboxes that share the parent's `/proc`" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.309 | "Fixed split-pane agent teammates not inheriting the tool deny and `--tools` rules given on the leader's command line" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.309 | "Fixed hooks that run in PowerShell not blocking when the hook's program exits with code 2, and on Windows `PreToolUse` and `PermissionRequest` hooks with `\"shell\": \"powershell\"` failing open when Git for Windows isn't installed" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.309 | "Linux: Fixed sandbox write denies lifting when a background command outlived the session" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.309 | "Windows: Fixed PowerShell permission checks auto-approving some `Set-Location` or `cd` commands that target the current directory and carry extra arguments; these now prompt for approval" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.309 | "Changed `claude ultrareview` to require workspace trust: it asks on a terminal, else refuses; scripts pass `--trust-workspace`, which takes no value (put a PR number or base branch before it), or set `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK=1`" | entry text names the ultrareview entry point; not checked against a kaoiro path |
| 2.1.309 | "Changed the dangerous `rm` and `rmdir` prompt in bypass permissions mode in the Desktop app and VS Code to deny the command at once with a rewrite hint, so unattended sessions keep going" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.309 | "Changed commands the settings exclude from the sandbox to ask before writing to its write-list paths while the sandbox is enabled but cannot run; the unsandboxed fallback is refused there" | entry text names a configuration with the Bash sandbox enabled; not checked against a kaoiro path |
| 2.1.309 | "[Claude Tag] Fixed Allow and Deny on Claude's approval cards in Slack doing nothing when the session had stopped; your answer now restarts the session" | entry text names Claude Tag (Slack) or Code Review; not checked against a kaoiro path |
| 2.1.307 | "Added the `claude_code.safety_event` OpenTelemetry event for each tool call a permission rule, auto mode, a safety check, a hook or the sandbox stopped, prompted or sent back" | entry text names an added OpenTelemetry event; not checked against a kaoiro path |
| 2.1.307 | "Fixed `/permissions` > Recently denied not showing the denied shell command, and auto mode's local classifier ignoring an approval from there when it checks a retried command; approving a row now names the command, not its description" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.319 | "Fixed cloud sessions losing session-scoped deny and ask permission rules, such as those a PermissionRequest hook adds, when the session moves to a new worker" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.319 | "Fixed a case where deny and ask rules, hook matchers and `disallowedTools` entries written with a claude.ai connector's terminal name (`mcp__claude_ai_Slack`) were ignored in Claude Desktop (takes effect once Claude Desktop includes this version)" | entry text names Claude Desktop, the mobile app, or the claude.ai web UI; not checked against a kaoiro path |
| 2.1.319 | "Fixed self-hosted runners: `--trust-workspace false` now also stops hooks in the repository's settings files and skills from running" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.318 | "Fixed variables a `Setup` hook writes to `CLAUDE_ENV_FILE` not reaching the Bash tool in some cloud sessions" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.318 | "Fixed a mod's `turn.step` hook making a stopped reply finish as a success in headless runs" | entry text names a plugin's hooks module (mod); not checked against a kaoiro path |
| 2.1.318 | "Self-hosted runner: Added `CLAUDE_RUNNER_SPAWN_REASON` to the orchestrator's spawn-runner hook environment: why Anthropic sent the request (e.g. `runner_lost`, `resumed`); unset when none was sent" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.316 | "Fixed PowerShell hooks not blocking on exit code 2 when the command begins with a type cast, `param`, `using` or an attribute" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.314 | "Changed auto mode in Cowork cloud sessions: a hook's allow of an MCP tool call now counts as no answer, so the classifier or a permission prompt decides" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.314 | "[VSCode] Fixed missing spinner and Stop button while a queued message's hooks run" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.311 | "[VSCode] Added a \"Running UserPromptSubmit hooks\" spinner status and screen reader announcement for slow UserPromptSubmit hooks" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.310 | "Windows: Fixed PreToolUse and PermissionRequest hooks letting a tool call through when Git Bash is missing and the hook's command is only quoted strings, such as a quoted path" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.309 | "Fixed hooks that run in PowerShell not blocking when the hook's program exits with code 2, and on Windows `PreToolUse` and `PermissionRequest` hooks with `\"shell\": \"powershell\"` failing open when Git for Windows isn't installed" | entry text names a Windows, macOS or Linux specific; not checked against a kaoiro path |
| 2.1.309 | "Fixed a mod's `turn.step` hook that names a model by alias, such as `haiku`, failing every request with a model error: the alias now resolves to its model" | entry text names a plugin's hooks module (mod); not checked against a kaoiro path |
| 2.1.309 | "Improved the error when a hooks module is nested too deep to load: it now names the file instead of showing a bare stack-overflow message" | entry text names a plugin's hooks module (mod); not checked against a kaoiro path |
| 2.1.307 | "Added the `claude_code.safety_event` OpenTelemetry event for each tool call a permission rule, auto mode, a safety check, a hook or the sandbox stopped, prompted or sent back" | entry text names an added OpenTelemetry event; not checked against a kaoiro path |
| 2.1.307 | "Self-hosted runner: Fixed archiving or requeueing a session, or stopping the runner, during its checkout hook leaving the hook's processes running and the runner's slot held" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.307 | "Self-hosted runner: Changed checkout hooks to be stopped after 30 minutes by default, failing the session's setup; if yours needs longer, raise `--checkout-hook-timeout-min` or set it to `0`" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.319 | "Fixed self-hosted runner sessions failing with no explanation when the server keeps refusing to renew model access: the runner now retries sooner and posts a warning in the session" | entry text names Anthropic's self-hosted runner; not checked against a kaoiro path |
| 2.1.319 | "Improved the `/model` picker: older models are now grouped under a \"More models\" row instead of being listed after the current ones" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.318 | "Added an `effort` option to a mod's `$.model.fork`, so a quick side job can run at `low` whatever effort the session uses; the result reports the effort sent" | entry text names a plugin's hooks module (mod); not checked against a kaoiro path |
| 2.1.317 | "Fixed a project's `effortLevel` setting being ignored by sessions that an app starts ahead of time and then opens in the project, such as new sessions in the desktop app's Code tab" | entry text names an option or a pre-started session the entry names; not checked against a kaoiro path |
| 2.1.317 | "[VSCode] Fixed `ultrathink` not raising effort for its turn or showing its rainbow when telemetry is off" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.316 | "Fixed `sonnet`, `opus` and `haiku` on Vertex AI and Amazon Bedrock showing an error mid-session instead of switching to an older model when the newest is not yet available to the account or region" | entry text names Bedrock, Vertex, Foundry or Mantle; not checked against a kaoiro path |
| 2.1.316 | "[VSCode] Changed `ultrathink` to run its turn at `xhigh` effort and show in a rainbow in the chat box, as in the terminal" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.316 | "[VSCode] Fixed the missing Effort slider, Ultracode switch and model name when the model setting has the `[1m]` tag, such as `opus[1m]`" | entry text names the VS Code / JetBrains extension; not checked against a kaoiro path |
| 2.1.314 | "Fixed Microsoft Foundry sessions failing when the resource has no deployment for the default Sonnet, Opus or Haiku model: Claude Code now falls back to an older model of that family" | entry text names Bedrock, Vertex, Foundry or Mantle; not checked against a kaoiro path |
| 2.1.314 | "Fixed the Bedrock and Vertex model upgrade offer coming back at every start when managed settings pin the model" | entry text names Bedrock, Vertex, Foundry or Mantle; not checked against a kaoiro path |
| 2.1.314 | "Fixed model switches over Remote Control that take over 8 seconds getting a \"still pending\" error instead of the final result" | entry text names Remote Control; not checked against a kaoiro path |
| 2.1.314 | "Fixed model IDs spelled with a dot behind an LLM gateway, such as `claude-opus-4.8`, being treated as an older model with the wrong context window, output limit, effort, thinking mode and cost" | entry text names an LLM gateway or the Claude apps gateway; not checked against a kaoiro path |
| 2.1.314 | "Fixed a resumed claude.ai cloud session making a model call nobody asked for when the previous worker stopped just after receiving a new chat's files" | entry text names a cloud session, Cowork, or a cloud scheduled task; not checked against a kaoiro path |
| 2.1.312 | "Fixed the `/model` and `/effort` cache warning saying the re-read waits for your next message; a change made while Claude is working can trigger it sooner" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.312 | "Improved the prompt's effort indicator: a change made mid-task now says it may wait for your next message, and the note clears when it no longer applies" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.312 | "Changed Bedrock, Vertex, Foundry and Mantle to use the shorter system prompt for model names Claude Code doesn't recognize, such as custom deployment names and inference profile ARNs, even when they front Sonnet or Haiku; set `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` to keep the full prompt" | entry text names Bedrock, Vertex, Foundry or Mantle; not checked against a kaoiro path |
| 2.1.311 | "Fixed `/effort` not warning about a prompt cache miss in plan mode when the plan model differs from the session model" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.311 | "Changed `ultrathink` in the interactive terminal to run its turn at xhigh effort on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 through Anthropic's API; typed while Claude is working, it raises the rest of that turn" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.311 | "Changed the `ultrathink` rainbow to appear only where the keyword can raise effort, and not when the word is quoted or part of a file path" | entry text names the interactive terminal UI (a screen, key or pane the entry names); not checked against a kaoiro path |
| 2.1.311 | "Changed Claude Code on Bedrock, Mantle, Vertex, and Foundry to load model settings from a signed file on downloads.claude.ai; set CLAUDE_CODE_MODEL_CATALOG=off to turn this off" | entry text names Bedrock, Vertex, Foundry or Mantle; not checked against a kaoiro path |
| 2.1.309 | "Fixed a mod's `turn.step` hook that names a model by alias, such as `haiku`, failing every request with a model error: the alias now resolves to its model" | entry text names a plugin's hooks module (mod); not checked against a kaoiro path |

### Keyword matches that are not in the four categories

| CLI | Entry, verbatim | Why it is out of topic |
|---|---|---|
| 2.1.314 | "Fixed Esc on a command's panel, such as `/btw`, also interrupting the subagent whose transcript is open" | out of topic: terminal Esc handling; `interrupting` matched |
| 2.1.311 | "Fixed Claude not being told the cause when a file attached to a message sent over Remote Control or to a cloud session could not be saved because the disk was full, or that a message's attachments past the first 20 were left out" | out of topic: attachment save-failure notice; `message sent` matched |
| 2.1.309 | "[VSCode] Fixed long messages not folding behind Show more after the chat panel is made narrower" | out of topic: chat display folding; `folding` matched |
| 2.1.309 | "[Code Review] Fixed a push queued behind a running review still starting a review after `@claude review stop`; its check now closes and says why" | out of topic: the Code Review queue; `queued` matched |
| 2.1.319 | "Fixed the `/claude-api` skill saying Console web settings don't apply to Managed Agents sessions, and tightened its credential and permission examples" | out of topic: wording of a bundled skill |
| 2.1.319 | "Fixed help links in `/status` and the auto mode billing notice opening only part of the address when they wrap" | out of topic: link wrapping in the display |
| 2.1.319 | "Improved the contrast of faint gray secondary text, such as hints, details in `/stats`, `/model` and `/sandbox`, and rejected-action messages" | out of topic: text contrast; `/model` and `/sandbox` matched as screen names |
| 2.1.318 | "Gateway: Improved the log hints about `listen.trusted_proxies`: they now say to list only a proxy that adds the connecting address to `X-Forwarded-For` itself" | out of topic: gateway log wording; `trusted` matched |
| 2.1.316 | "Fixed the Claude apps gateway not checking every model a request names against `availableModels`, `deniedModels` and `models`; a request that names a blocked model now gets a 400 naming the field" | out of topic: the gateway's own model check |
| 2.1.314 | "Fixed an administrator's TLS trust settings in managed settings not being applied in Claude Desktop sessions" | out of topic: TLS certificate trust; `trust` matched, unrelated to tool permission |
| 2.1.307 | "Self-hosted runner: Changed the certificate file built for Anthropic-managed git to filter its trusted certificates as the CLI does; a `[runner:warn]` line gives the number left out" | out of topic: TLS certificate trust; `trust` matched, unrelated to tool permission |
| 2.1.307 | "[VSCode] Changed voice dictation to filter its trusted certificates as the CLI does" | out of topic: TLS certificate trust; `trust` matched, unrelated to tool permission |
| 2.1.307 | "[VSCode] Changed the extension's own requests to filter their trusted certificates as the CLI does, and to trust the `NODE_EXTRA_CA_CERTS` file named in the environment or in user settings" | out of topic: TLS certificate trust; `trust` matched, unrelated to tool permission |
| 2.1.319 | "Added a Claude apps gateway boot warning for a case where another policy's `availableModels` also allows a custom model id that one policy lists by name" | out of topic: a gateway start-up warning |
| 2.1.319 | "Fixed Write ending the turn as a refusal when it couldn't read the file to overwrite" | out of topic: Write tool failure handling, not a model switch; `refusal` matched |
| 2.1.319 | "Improved the refusal for a path outside the working directories on macOS and Windows: when only its letter case differs from a path inside them, the message names that spelling" | out of topic: wording for a path outside the working directory; `refusal` matched, display only |
| 2.1.319 | "Improved the contrast of faint gray secondary text, such as hints, details in `/stats`, `/model` and `/sandbox`, and rejected-action messages" | out of topic: text contrast; `/model` and `/sandbox` matched as screen names |
| 2.1.319 | "[Claude Tag] Added a Claude Tag row to the Models admin page for Enterprise orgs with Claude Tag connected, linking to where its model defaults are managed" | out of topic: an added admin console row |
| 2.1.318 | "Fixed `/mcp` in cloud sessions counting tools the model can't use; a server's row now shows how many of its tools are available" | out of topic: an MCP tool count in the display; `the model` matched |
| 2.1.318 | "Removed the 2.1.288 fix that kept the model's earlier thinking when resuming a conversation started on 2.1.286 or earlier; that thinking can now be dropped" | out of topic: thinking retained on resume, not a model switch |
| 2.1.316 | "Fixed the Claude apps gateway not checking every model a request names against `availableModels`, `deniedModels` and `models`; a request that names a blocked model now gets a 400 naming the field" | out of topic: the gateway's own model check |
| 2.1.314 | "Fixed the welcome header in fullscreen mode showing the session's model while viewing a subagent or teammate that runs on a different model" | out of topic: the terminal header display |
| 2.1.312 | "[Cloud sessions] Added an effort level to the model picker when you create or edit a routine that runs in the cloud" | out of topic: the effort field of the routine-creation UI |
| 2.1.312 | "[Claude Tag] Improved Claude Tag's retry notice in Slack to name the model in use, or say rate limits were hit, instead of a generic API error" | out of topic: Slack notification wording |
| 2.1.311 | "Improved startup time for launches whose only arguments are options and their values, such as `claude --model opus`" | out of topic: start-up time; `--model` matched as an example |
| 2.1.311 | "[Code Review] Improved Code Review's check run to say no further automatic review will start when the model still can't analyze a change on the automatic retry" | out of topic: Code Review wording |
| 2.1.309 | "Fixed `/privacy-settings` showing an out-of-date \"Help improve our AI models\" value; it now also says when the setting can't be fetched" | out of topic: the privacy settings display; `AI models` matched |
| 2.1.307 | "Fixed `/help` and the `/` command menu showing long model-facing descriptions for bundled skills such as `/claude-api` instead of their short descriptions" | out of topic: a skill description in the display; `model-facing` matched |
| 2.1.307 | "Fixed WebFetch in Cowork cloud sessions reporting a tool error when a site answered with a 4xx status or a robots.txt refusal; it is now a normal result, as in local sessions" | out of topic: WebFetch result handling; `refusal` matched |

## Code-path summary

The entries above touch these kaoiro paths. Nothing in this bump changes any of
them; the pin and the lockfile are the whole source diff.

| Area | Path | Why the changelog reaches it |
|---|---|---|
| Live input push | `host.ts:1363-1400` (`pushLiveInput`, with `priority: "now"` at `:1388`) | folding and queued input, and the `priority: now` premise E4 |
| Interrupt | `host.ts:1846` | interrupt and queued-message entries |
| Model switch | `host.ts:2062-2175` (`setModel`) | the 15-second confirmation wait and the refusal-fallback entries |
| Permission broker | `host.ts:2306` (`setPendingPermission`), `host.ts:3147` (`canUseTool`) | the Bash rule fixes and the auto-mode entries |
| Initial permission mode | `host.ts:3061-3067` | `auto` is a member of `PERMISSION_MODES` (`wrapper/core/src/persona.ts:34-41`) |
| Child environment | `host.ts:3064` | `process.env` is the default, so a runner-side variable reaches the CLI |
| Hook groups | `host.ts:3098-3146` (eight groups, no `matchers`, no `onFailure`) | the hook entries |
| Task classification | `host.ts:2328-2341`, `host.ts:4920-4950`, `wrapper_channel.ex:2767` | `mcp_task` |
| Context usage | `host.ts:4605` | the `ModelUsage` split and auto-compact entries |
| Catalog projection | `probe.ts:243-256` | the `[1m]` suffix change |
| System message mapping | `adapter.ts:182-184` | the new system messages are dropped |
| Refusal fallback | `adapter.ts:642-648` | the automatic model switch entries |
| Continuation classification | `continuation_registry.ts:13-15`, `:88-129` | Monitor, Agent and SendMessage entries |
| Fold text | `fold_text.ts` | E1 and E2 measure the bytes this builds |
| Turn watchdog | `turn_watchdog.ts:15-17` | the start-up wait and the retry entries |

## Step 4: re-measurement of the input-folding premises E1 to E4

The baseline is the
[2026-09-28 fold measurements](../../issue-429/2026-09-28-claude-fold-measurements.md),
whose verdicts are bound to SDK 0.3.280 / CLI 2.1.280. The previous bump to
0.3.306 did not re-measure them, and its record says so, so 0.3.280 is the
standing baseline. No verdict is carried forward.

| Premise | Statement | 2026-09-28 | This measurement (SDK 0.3.319 / CLI 2.1.319) |
|---|---|---|---|
| E1 | live input reaches the next model request verbatim, ticket included | established for the measured running-Bash fold | **established** for the same schedule |
| E2 | fold hook text and live-owner prompt ID match | established for the measured fold | **established** |
| E3 | input queued before a tool-free turn ends starts a new root prompt | established for the measured text-only completion | **established** |
| E4 | `priority: now` waits for the running tool, ends the turn once, and starts the input as a new turn | established for the measured running Bash | **established** |

### Where and how it ran

One run in the project's remote heavy-test slot, class `test`, which has no
network at all, on the fixed runtime image
`sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`
(run `sakura-c028818-e1e4-1107202327-7b5c.18ea4f0353d452bc`). The measurement
needs no external API — the provider is a scripted Anthropic Messages SSE
endpoint on loopback with a dummy key — so no real model ran, no spend and no
rate-limit budget was consumed. The container reported uid/gid 1001, `HOME=/w`,
`CI=true`, Node v22.23.3 at `/usr/local/bin/node`, and `/w/repo` at
`c0288185f9a3744c6d992b8705b3c4e9f50bd3ad`.

The five schedules are the 2026-09-28 ones, with the same payload (a UUID
marker, exact indentation, Japanese text and a reply authorization) and the
same model string `claude-sonnet-4-6`:

| Run | Schedule | Requests / results | Duration |
|---|---|---|---|
| B0 | ordinary root input, one Bash, no extra input | 2 / 1 | 2140 ms |
| F1 | push with no priority after the Bash start marker (fold) | 2 / 1 | 3926 ms |
| T1 | push while the first text-only reply is held, turn ends with no tool | 2 / 2 | 1282 ms |
| P1 | push with `priority: "now"` after the Bash start marker (cut) | 2 / 2 | 2146 ms |
| F2 | F1 repeated unchanged | 2 / 1 | 3917 ms |

B0 doubles as the environment pre-flight. Ten scripted model requests in total;
zero real ones.

This composition differs from 2026-09-28's nested-namespace host run in ten
recorded ways: no network at all rather than loopback-only; uid/gid 1001 rather
than 1000; container-scoped rather than per-invocation PID lifetime; a
1,200-second outer limit rather than `timeout 300s`; a read-only root
filesystem with only `/w`, `/tmp` and `/dev/shm` writable; all capabilities
dropped; 3 CPUs and 3 GiB of memory; `HOME` and `CI` set by the container but
overridden for the child by the probe's own environment allowlist; and no
launcher script. None of those is a quantity E1 to E4 observe — they judge
content, identity and order — which is a judgement recorded here as a
judgement, not a claim that the two environments are the same.

### Harness identity

The 2026-09-28 harness was reused rather than rewritten; it is a throwaway tool
and is not landed as product code. Four files were used, and the diff against
the retained originals is six constants (three import paths, the output base,
the scratch root, and the child `PATH`) plus one added property on the
recording `ServerLink` stub, described below.

| File | Lines | sha256 as run |
|---|---|---|
| `probe.mjs` | 70 | `e9cc98e0ffb6540db999106676b79607047f1873f22c9b510f36f55e52eb234f` |
| `seam.mjs` | 19 | `bbf7827080ff04116423b8789b374a719d353ff309a75dcffb6fd671ce4d7c54` (unchanged from 2026-09-28) |
| `checker.mjs` | 35 | `da79901013d581bcd85c2d56140684467835e21f321ff4aadf09a7ff589de1d8` |
| `judge.mjs` | 247 | `919e0ef3d863b0179d60cce22c9b0592ab709458147bf71335a33d386ee42807` |

The four were shipped into the run as one archive whose sha256 the run compared
against the local value before extracting, and the per-file hashes were then
checked inside the run. `launch.sh` was **not executed** and its hash is
therefore not evidence of any execution path.

`checker.mjs` is an extractor, not a judge: its ordinary path writes
`<run>.check.json` and exits 0 without asserting anything, so its exit status
is not evidence for any premise. The judging is done by the throwaway
`judge.mjs`, which evaluates the table below and exits non-zero if one
condition fails.

### A harness defect found, and the control that attributes it

The first attempt produced zero model requests and zero result frames in all
five runs. `judge.mjs` reported `J0` as failed and drew no premise verdict,
which is the behaviour the design asks for when a measurement is not
established.

The cause was in the harness, not in the new pin: the recording `ServerLink`
stub does not implement `deliveryModes()`, a method the current wrapper calls
(`cli.ts` guards it with `link?.deliveryModes()`, which protects against a null
link but not against a stub missing the method). The host's input generator
rejected with `TypeError: link?.deliveryModes is not a function`, so no root
prompt was ever yielded and the native CLI exited 0 on end-of-input.

Attribution, measured rather than assumed:

| Experiment | Result |
|---|---|
| Harness + 0.3.319 + this branch | 0 requests, 0 results |
| Harness + **0.3.306** + `develop` | 0 requests, 0 results — identical |
| `query()` alone, given a never-yielding async generator, 0.3.319 vs 0.3.306 | identical: both pull the prompt iterable at about 15 ms and keep the child alive |
| Native CLI alone with an open, never-written stdin, 2.1.319 vs 2.1.306 | identical: both wait, emitting nothing |
| Native CLI alone with stream-json stdin, 2.1.319 | emits its `init` message and runs |

The old pin reproducing the same failure on the current build is what rules the
new SDK out. The harness had simply gone stale against the wrapper it was
pointed at. Adding `deliveryModes: () => undefined` to the stub — the value
that reproduces the 2026-09-28 semantics, where no delivery mode was negotiated
because the mechanism did not exist — made all five schedules produce the
counts the table above expects.

### Verdicts

55 judgements passed and none failed. The numbering follows the design; `J23`
is vacant, withdrawn before approval because "the payload is always wrapped"
was a guarantee neither premise claims.

| Premise | Conditions | Result |
|---|---|---|
| E1 (F1, F2) | `J1` payload absent from request 1; `J2` payload present as a contiguous byte run inside request 2's `tool_result.content`; `J3` the extractor's own reference agrees | all pass |
| E2 (F1, F2) | `J4` exactly one `UserPromptSubmit` hook whose text equals the payload; `J5` its `prompt_id` equals the run's first one; `J6` it precedes the turn's terminal; `J7` the extractor agrees; `J24` order hook, request 2, sole terminal | all pass |
| E3 (T1) | `J8` no frame carries a `tool_use` block; `J9` the original terminal precedes the new hook; `J10` the new `prompt_id` differs; `J11` payload in request 2; `J12` two terminals, indices 0 and 1; `J25` order terminal, new hook, request 2, second terminal | all pass |
| E4 (P1) | `J13` the tool end marker precedes the original terminal; `J14` exactly one terminal at index 0; `J15` the new `prompt_id` differs; `J16` payload in request 2; `J17` the second terminal is index 1; `J18` two terminals, 0 and 1 once each; `J26` order tool end, terminal, new hook, request 2, new terminal | all pass |
| All runs | `J0` the measurement is established at all; `J19` raw request and result counts match the schedule; `J20` no `run_error`; `J21` no owned child left; `J22` B0's un-pushed payload is absent from both requests; `J27` every result frame has `is_error` false | all pass |

Counts and success are read from the raw frames. The probe's own exit code is
not used: it counts results and schedules a close without reading `is_error`,
so a failed native result would not reach it — which is why `J27` exists.

`J0` separates "not established" from "premise refuted". A run without
`sdk_start`, with a `run_error`, with the wrong frame counts, or without
`finished` yields no verdict at all rather than a negative one.

### Negative controls

Raw files were frozen; each mutation goes into the expectation or into the
judging predicate, never into the recorded data.

| Control | Mutation | Judgements it broke |
|---|---|---|
| N1 | expected body marker changed, ticket untouched | J2, J4, J5, J6, J24, J9, J10, J11, J15, J16, J25, J26 (17 across runs) |
| N2 | expected ticket changed, body untouched | the same 17 |
| N3 | expected fold prompt ID made to differ from the initial one | J5, J7 on F1 and F2 |
| N4 | expected new prompt ID made to equal the initial one | J10 on T1, J15 on P1 |
| N5a | one edge of F1's expected order swapped | J6, J24 |
| N5b | one edge of T1's expected order swapped | J9, J25 |
| N5c | one edge of P1's expected order swapped | J13, J26 |
| N6 | expected terminal count and indices changed | J12 on T1, J14 and J18 on P1 |
| N7 | the judge's byte-containment predicate forced true | the judge's own self-test fails |
| N8 | the extractor's byte-containment predicate bypassed | J3 on F1 and F2 |
| N9 | expected `is_error` set true | J27 on all five runs |
| N10 | a run cut before request 2 | J0 fails and the run is skipped, with no premise verdict drawn |

Two corrections to the designed control set, both found by running the controls
rather than by reading them:

- N8 reaches `J3` only, not `J7`. The extractor builds `hook_predictions` with
  an equality comparison, not with the byte-containment predicate, so bypassing
  that predicate cannot affect `J7`. `J7` is falsified by N3, which is what
  keeps it non-vacuous.
- N1 and N2 apply to every run that has a pushed payload, not only to the two
  fold runs. That is what makes `J9` falsifiable.

Three conditions assert an absence and so carry a positive control taken with
the same expression, in the same record: `J1` and `J22` (the byte predicate
does find the payload in request 2 of F1, T1, P1 and F2, and finds it nowhere
in B0, which never pushed) and `J8` (the same expression counts one
`tool_use`-bearing frame in B0, F1, P1 and F2, and zero in T1).

Three conditions have no falsifying control and no positive control: `J20`
(absence of `run_error`), `J21` (`owned_children` is 0) and `J17` (a second
terminal exists). `J17`'s content is covered by `J18`, which N6 does falsify.
For `J20` and `J21` the measured values are printed in the judgement lines, but
this record does not claim they are pinned.

### Observations kept out of the verdicts

These were recorded but are not conditions for any premise, because no premise
claims them:

| Observation | Value |
|---|---|
| O1 / O4 | the fold payload is 198 bytes inside a 618-byte `tool_result`; whole-block equality is false, i.e. wrapping exists |
| O2 | P1's first result string is empty; the others carry the scripted text |
| O3 | absolute start and finish times per run |
| O5 | in F1 and F2 the tool end marker appears before the fold hook (log positions 18 and 23) |
| O6 | the native child exited 0 with no signal in every run, read from the raw `child_exit` record |

### Limits of this measurement

- The seam does not go through kaoiro's own push path (`host.ts:1363`,
  `pushLiveInput`). E1 to E4 are therefore verdicts about the native mechanism,
  not about kaoiro's push reaching it. That second question is covered by the
  committed native suites, which run on the new pin: in particular
  `cli_delivery_policy_native.test.ts` exercises the built runner, the CLI and
  the pinned SDK over eight delivery cases.
- Control and format characters were deliberately left out of the payload, so
  that it stays comparable with 2026-09-28. CLI 2.1.311 changed how such
  characters are written in `stream-json` output while stating that parsed
  values are unchanged; this record does not measure that.
- The 2026-09-28 record's E5, R3 and S1 were not re-measured. The checklist asks
  for E1 to E4 only.
- `judge.mjs` is a throwaway judge, removed after the measurement. Its own
  failure mode is covered by N7 and nothing further.

## Step 5: lockfile, suites and the native checks

The lockfile is committed in `c0288185`, and the scope judgement above was
re-run against that committed lockfile rather than against a temporary one.

Three suites assert the installed SDK and CLI version so that a pin change
cannot land unreviewed; one also asserts the native executable's sha256. All
four expectations were moved to the measured values in `c96efe5b`, keeping
their previous shape:

| Test | Guard | Cases |
|---|---|---|
| `compact_resume_native.test.ts:26` | SDK and CLI version | 13 |
| `monitor_notification_advice_native.test.ts:33` | SDK and CLI version | 6 |
| `monitor_notification_advice_native.test.ts:166` | CLI version, on each notification row | 6 |
| `native_peer_opener.test.ts:34` | SDK version | 1 |
| `native_peer_opener.test.ts:41` | native executable sha256 | 1 |

The guard at `:166` was missed on the first pass and only appeared once `:33`
passed and the case bodies ran: the first guard shadows the second. Finding a
second instance of the same class is what prompted a scan of the whole tree
rather than another single fix. Searching every TypeScript, JavaScript, JSON
and Elixir file for the outgoing SDK version, the outgoing CLI version and the
outgoing binary hash returns no further assertion bound to the installed
artifact. The other matches are recorded captures and hashes of committed
fixture bytes, which stay on the version they were captured at:
`test/fixtures/monitor_notifications.{ts,json}`,
`test/fixtures/native_peer_opener.ts` with
`test/fixtures/native-peer-opener-2.1.306.json`,
`test/fixtures/claude-agent-sdk-0.3.306.models.json` with its two consumers,
`host.test.ts:9238` and `:9268`, `haiku55_catalog.test.ts:35`, and the
0.3.306 evidence directory.

Each guard was mutated once, on its own, and each turned its file red: a
one-digit change to the version pin failed 13, 6, 6 and 1 cases respectively,
and a one-character change to the pinned hash failed its case while the other
three in that file still passed. The `:166` mutation was run with `:33` left
intact, so it is pinned on its own rather than through the guard above it.

The whole `@kaoiro/claude-code` suite was also run on the candidate commit in
the project's remote heavy-test slot, with the wrapper and the runner built:
**55 files passed and 1 skipped; 1328 tests passed and 4 skipped**, in 111 s.
All twelve `*native*` files ran, `cli_delivery_policy_native.test.ts` among
them, so kaoiro's own push path is exercised against the new pin.

The Node and Elixir suites also run through the pre-landing CI on the candidate
commit; the two checks CI does not cover were run directly, because both need
the installed native executable:

| Check | Result |
|---|---|
| `KAOIRO_LIVE_CLAUDE=1 pnpm exec vitest run test/haiku55_native.test.ts` | 4 of 4 pass. Model resolution, the catalog projection, effort acceptance and `getContextUsage()` all come from the installed SDK and CLI. Its provider endpoint is loopback with scripted responses, so no real model ran |
| `node wrapper/claude-code/dist/probe.js` | exit 0, empty stderr, `ok: true`, `source: "init"`, 1337 ms, **13 rows** |

### Production catalog probe

The projection is **identical** to the 0.3.306 capture, field by field across
all 13 rows, so 2.1.311's `[1m]` change did not move it and no new fixture is
needed. The query's prompt iterator never yields a user message: this is an
initialization-only catalog measurement and establishes nothing about model
generation or tool policy. Credentials, the command list and account data are
not published here.

| value | resolved_model | effort_levels |
|---|---|---|
| `default` | `claude-opus-5-5` | low, medium, high, xhigh, max |
| `opus` | `claude-opus-5-5` | low, medium, high, xhigh, max |
| `fable` | `claude-fable-5-1` | low, medium, high, xhigh, max |
| `sonnet` | `claude-sonnet-5-5` | low, medium, high, xhigh, max |
| `haiku` | `claude-haiku-5-5` | low, medium, high, xhigh, max |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | (none) |
| `claude-sonnet-5` | `claude-sonnet-5` | low, medium, high, xhigh, max |
| `claude-opus-5` | `claude-opus-5` | low, medium, high, xhigh, max |
| `claude-fable-5` | `claude-fable-5` | low, medium, high, xhigh, max |
| `claude-opus-4-8` | `claude-opus-4-8` | low, medium, high, xhigh, max |
| `claude-opus-4-7` | `claude-opus-4-7` | low, medium, high, xhigh, max |
| `claude-opus-4-6` | `claude-opus-4-6` | low, medium, high, max |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | low, medium, high, max |

## Release-note candidates

These are operator-visible changes inherited from the vendor, not changes
kaoiro makes:

- **2.1.307** — `setModel()` now waits up to 15 seconds, rather than 5, for the
  API to confirm a model. A model switch from the dashboard can therefore take
  that long to settle.
- **2.1.319** — Bash deny and ask rules now cover commands written with quoted
  words, a `sed` path in accept-edits and auto mode, `which` with flags outside
  a lookup set, and an environment-prefix bypass. A peer that asks for
  permission may now be asked about commands that previously went through.
- **2.1.319** — Monitor's WebSocket watch follows Bash rules: a deny refuses it,
  and under an ask rule neither an allow on Monitor, nor bypass mode, nor auto
  mode skips the prompt.
- **2.1.314** — hooks matching Bash now also run on shell commands the Monitor
  tool starts, and `Monitor(...)` conditions match them as `Bash(...)` does.
- **2.1.316** — fast mode for Opus 4.8 is deprecated as of 2026-10-30 and is
  removed on 2026-11-30. After removal a fast-mode request on Opus 4.8 returns
  an error with no fallback to standard Opus 4.8. A peer that fell back to
  Opus 4.8 and uses fast mode is affected; migrating to Opus 5.5 keeps the
  speed-up. This bump neither causes nor fixes that deadline.

## Limits of this record

- The categories above record what was checked, not what applies. 105 relevant
  entries are marked "not checked": that is the absence of a check, not the
  absence of an effect, and none of them is used as grounds for believing the
  new pin safe.
- 2.1.313 and 2.1.315 have no published changelog entries, so their contents
  are unread.
- E1 to E4 are established for the five measured schedules only, on the
  composition described above.
- The suites, the two native checks and the catalog probe establish what their
  own assertions say. Production start-up behaviour is not established here;
  the production-shape start gate belongs to the release, which is out of
  scope for this change.
