---
title: Claude Agent SDK 0.3.321 bump for Claude Fable 5.2, fold premises and catalog measurement
status: measured
last_updated: 2026-11-10
description: The dated record for raising @anthropic-ai/claude-agent-sdk from 0.3.319 to 0.3.321 in wrapper/claude-code — changelog reads, the E1 to E4 fold re-measurement, the catalog and real-model checks for Claude Fable 5.2, one measured regression and the limits.
---

# Claude Agent SDK 0.3.321 bump for Claude Fable 5.2, fold premises and catalog measurement

This record covers the steps of the
[Agent SDK bump checklist](../../../contributing/agent-sdk-bump.md) for
`wrapper/claude-code` ([issue #1063](https://github.com/sakuraiyuta/kaoiro/issues/1063)).
Everything below is bound to the commits and artifact hashes named here; a
later change to any of them invalidates the measurement. The measurements ran
on 2026-11-09 UTC (2026-11-10 JST). The previous pin's record is the
[0.3.319 one](../issue-1044/sdk-0.3.319-2026-11-07.md).

One result needs a reader's attention before the rest: the new CLI shortens a
background command's label in the notification it shows the model, and
kaoiro's continuation proof then refuses that completion. It is measured in
[A regression on long background-command labels](#a-regression-on-long-background-command-labels).

## Versions, commits and artifact identity

| Item | Before | After |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` range | `^0.3.319` | `^0.3.321` |
| Bundled CLI (installed `manifest.json` `version`) | 2.1.319 | 2.1.321 |
| Native executable self-report | `2.1.319 (Claude Code)` | `2.1.321 (Claude Code)` |

Commits on `issue-1063-sdk-fable-5-2`, on top of `develop`
`6bdc90155feb5d2831507ad7573f4352f2851705`:

| Commit | Contents |
|---|---|
| `8997bcfef6b185cc1aa2de1d357086c76293ca90` | the pin and the lockfile |
| `edb7cbe0e93e79e1a30172a7fbcc3226c6686a0f` | the five native guards re-pinned |

Artifact identity, read from the installed tree at `edb7cbe0`:

| Artifact | sha256 |
|---|---|
| `sdk.mjs` | `20524b5de1d5e69f4b98005994e0970f0426c99ec55e9b9dae1af1f270d86ab7` |
| native `claude` (linux-x64), 341910032 bytes | `426c33815ca6645a772f722fbff10dbf2cbdb124a8aeab733c1365dbf8bbf61f` |

The native binary's measured sha256 and size equal the
`platforms["linux-x64"]` `checksum` and `size` the package's own
`manifest.json` declares. The manifest also records `commit`
`76bc735070b3499364675700dea5f5a133152e2e`, `buildDate`
`2026-11-09T17:01:59Z`, `sdkCompat.harnessSchema` 1 and 30
`testedWrapperVersions` entries spanning 0.3.287 to 0.3.319, which include the
previous pin and not the version itself, the same shape as before.

## Step 1: version choice

`0.3.321` — the latest published version, which is the checklist default. The
registry reported `dist-tags.latest` and `dist-tags.next` both at `0.3.321`,
published `2026-11-09T19:03:36.409Z`.

`0.3.320` is skipped because upstream never published it: the registry has no
such version (a request for it returns 404), and its changelog entry is one
line recording parity with Claude Code v2.1.320.

The dependency shape does not move. `peerDependencies` are identical
(`zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk
^1.29.0`), the same eight platform packages stay optional, the `exports` map
is unchanged (seven entries) and `engines.node` stays `>=18.14.0`. kaoiro
imports only the root entry.

## Classification, release class and the lockfile scope

Classified **L**: one of the six surfaces (the dependency lock), a safety
valve (the behaviour of a new SDK and CLI is an unmeasured external premise),
and a change an operator can see — a peer whose model is the alias `fable`
moves from Claude Fable 5.1 to Claude Fable 5.2 at the release. kaoiro's own
code does not change.

Release class: **TL only** (turn lifecycle, claude-code engine). **FS does not
apply**, measured on the committed lockfile: the runner declares no dependency
on the SDK, and every changed line falls inside the bump's own scope.

| Measurement on `8997bcfe` | Value |
|---|---|
| Changed lines, `pnpm-lock.yaml` | 74 (37 added, 37 removed) |
| Changed lines, `wrapper/claude-code/package.json` | 2 (1 added, 1 removed) |
| Lockfile entries containing a changed line | 37 |
| Changed lines outside the allowed set | **0** |

The allowed set is "an entry whose name contains `claude-agent-sdk`, or the
importer `wrapper/claude-code`". The 37 entries are the importer, and the main
package and its eight platform packages at the two versions, counted once in
the `packages` section and once in `snapshots` (1 + 18 + 18). Negative
control: replacing the allowed set with a package name that does not exist
puts **74 of 74** changed lines outside it; allowing only the importer leaves
70 outside, which accounts for exactly the importer's four lines. The
importer's three resolved peers (`@anthropic-ai/sdk@0.105.0`,
`@modelcontextprotocol/sdk@1.29.0`, `zod@4.4.3`) are unchanged.

The release standby follows the table row in
`docs/operations/high-risk-change-release.md`, which puts an engine pin change
under "plain shell only". The lockfile measurement above is the ground for
"TL only"; it is not a ground for a lighter standby.

## What the bump changes for Claude Fable 5.2

The premise the issue started from — a model appears in the list only once the
bundled CLI knows it — did not hold. Measured on the same day, with the
previous pin and the new one, through an initialization-only probe that yields
no user message:

| `value` | 0.3.319 `resolved_model` | 0.3.321 `resolved_model` |
|---|---|---|
| `fable` | `claude-fable-5-1` | **`claude-fable-5-2`** |
| `claude-fable-5-2` | `claude-fable-5-2` (its own row) | no row; the `fable` row carries it |
| `claude-fable-5-1` | no row; the `fable` row carries it | `claude-fable-5-1` (its own row) |
| the other 12 rows | the same | the same |

Both lists have 14 rows. The 2026-11-07 record measured 13 rows on the same
0.3.319 pin, so the `claude-fable-5-2` row arrived without a version change.
The 0.3.319 native executable does not contain the string `claude-fable-5-2`
at all (0 occurrences; the same search finds `claude-fable-5-1` 37 times
there, and finds `claude-fable-5-2` 25 times in the 0.3.321 executable).

So the bump is not what makes the row appear. What it changes is what the
bundled CLI knows about the model: the alias `fable` now resolves to
`claude-fable-5-2`. Where the rows come from was not measured; the record
states only that one pin returned different rows on two dates.

### Production catalog probe on the new pin

`node wrapper/claude-code/dist/probe.js` at `edb7cbe0`: exit 0, empty stderr,
`ok: true`, `source: "init"`, 1285 ms, **14 rows**. Its value, resolved-model
and effort projection equals the throwaway same-day capture used for the table
above, row by row. The complete rows are in
[the catalog capture](sdk-0.3.321-catalog-2026-11-10.json). The probe's command
list and anything about the account are not published here. No user message
was yielded, so this establishes nothing about generation.

| value | resolved_model | effort_levels |
|---|---|---|
| `default` | `claude-opus-5-5` | low, medium, high, xhigh, max |
| `opus` | `claude-opus-5-5` | low, medium, high, xhigh, max |
| `fable` | `claude-fable-5-2` | low, medium, high, xhigh, max |
| `sonnet` | `claude-sonnet-5-5` | low, medium, high, xhigh, max |
| `haiku` | `claude-haiku-5-5` | low, medium, high, xhigh, max |
| `claude-fable-5-1` | `claude-fable-5-1` | low, medium, high, xhigh, max |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | (none) |
| `claude-sonnet-5` | `claude-sonnet-5` | low, medium, high, xhigh, max |
| `claude-opus-5` | `claude-opus-5` | low, medium, high, xhigh, max |
| `claude-fable-5` | `claude-fable-5` | low, medium, high, xhigh, max |
| `claude-opus-4-8` | `claude-opus-4-8` | low, medium, high, xhigh, max |
| `claude-opus-4-7` | `claude-opus-4-7` | low, medium, high, xhigh, max |
| `claude-opus-4-6` | `claude-opus-4-6` | low, medium, high, max |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | low, medium, high, max |

The list has no row whose `value` is `claude-fable-5-2`. A peer pinned to that
exact ID keeps it: the host looks for an exact `value` first and then for a
row whose `resolved_model` equals the pin (`host.ts:4342`, `#findCatalogEntries`
below it), and passes the string it was given to the SDK
(`host.ts:3092-3094`). Two committed tests hold that path and ran in the suite
below: `host.test.ts:6604-6636` asserts that a canonical ID set before the
first query reaches `Options.model` unchanged, and `host.test.ts:6638-6672`
that a persisted canonical ID matching only an alias row's `resolved_model`
keeps its value and source and raises no `switch_error`.

### Real-model turns

Three turns went to the real provider, one each, through the SDK installed at
`edb7cbe0`. Each is one `query()` with the prompt "Reply with the single word
OK.", `tools: []`, `mcpServers: {}`, `maxTurns: 1`, `effort: "low"`,
`settingSources: []`, `persistSession: false`, in an empty throwaway
directory. Only identifiers and counters were recorded: no reply text, account
data or credential.

The pass rule was fixed before the turns ran. The responding model is read
from one field, the `model` of the assistant messages. A turn passes when the
output has no error field, there is exactly one result, that result is
`success` with `is_error` false, and the set of assistant-message models is
exactly the expected one. The model named by `system/init` is the accepted
request, not the response, and is not used; neither are the keys of
`modelUsage`.

| Turn | Requested model | Expected responding model | Result |
|---|---|---|---|
| T1 | `fable` | `claude-fable-5-2` | **pass**, `num_turns` 1 |
| T2 | `claude-fable-5-1` | `claude-fable-5-1` | **pass**, `num_turns` 1 |
| T4 | `claude-fable-5-2` | `claude-fable-5-2` | **pass**, `num_turns` 1 |

No turn was retaken. T1 also asked for the context usage after its result:
`maxTokens` 1000000, `autoCompactThreshold` 967000. Negative control on the
recorded outputs: scoring T1 and T4 against `claude-fable-5-1`, and T2 against
`claude-fable-5-2`, fails each of them, so the rule reads the response and is
not a constant. In all three the `modelUsage` keys also include
`claude-haiku-5-5`; what that call is was not measured.

T2 is what shows that an explicit Fable 5.1 pin is not rewritten by the new
CLI. It covers the path where the host keeps a pin because a catalog row
matches it. It does not cover the CLI's own migration of *saved* picks, which
reads settings this probe does not load, nor an account whose list has no
`claude-fable-5-1` row, where the host would fall back to `default` and pass
no model at all (`host.ts:4375`, `:4376-4383`).

Before the bump, two turns on the previous pin (0.3.319 with
`claude-fable-5-2`, 2026-11-09T19:40Z and 19:41Z) passed by the same rule,
with the same context values. That is why the previous pin could serve as a
stopgap, and why this bump is about the CLI's knowledge of the model rather
than about reachability.

These turns measure the SDK, the CLI and the account. They are not a kaoiro
peer's turn: what kaoiro adds is handing `Options.model` over, which the unit
tests above and `haiku55_native` cover on the new pin. A peer finishing a turn
on the new pin is confirmed at the release.

## Step 2: SDK changelog 0.3.320 to 0.3.321

Read in full: 2 version headings and 12 bullets.

Source: `anthropics/claude-agent-sdk-typescript` `CHANGELOG.md` at `main`
commit `1f565ec639edf56fafd0c12b745f082b10d2a452` (committer date
`2026-11-09T19:22:11Z`); the fetched text hashes to
`30488d262de90a02fb77bfc30a7fb609446459290f5acba1f91d161f00738009`.

| SDK | Entry, verbatim | kaoiro code path and finding |
|---|---|---|
| 0.3.321 | "Changed queued subagent reports in auto mode to share one model call: each keeps its own message and result, and all but the last end in an empty `result` with `num_turns: 0`" | `adapter.ts:208-209` maps each result frame to one result event and `adapter.ts:329-331` copies a successful result's `result` string into the payload text. A peer in permission mode `auto` whose background subagents report together therefore sends one result with an empty text per report but the last. `num_turns` is read nowhere in `src`. **Not reproduced**: it needs a real auto-mode session with two or more waiting subagents |
| 0.3.321 | "Fixed `canUseTool` getting the app's own PreToolUse hook reason in `decisionReason` when another hook also asked" | `host.ts:3150-3156`: the callback reads `options.signal` only. `decisionReason` appears nowhere in `src`. No effect |
| 0.3.321 | "Fixed a PreToolUse hook's `ask` being lost when another hook's `defer` finished first and could not be honored" | `host.ts:3104-3111`: kaoiro's PreToolUse callback returns `{}` or an `updatedInput`, never `ask` or `defer` |
| 0.3.321 | "Fixed every hook being dropped when one event in the `hooks` option is set to `undefined`" | `host.ts:3098-3147` sets eight events, each to an array. `host.ts:3099` spreads the caller's `hooks` first, and the production entry (`cli.ts:1598`, `queryOptions`) passes none |
| 0.3.321 | "Improved `resume` and `continue` on the bundled Claude Code binary: `initialize` is read during boot, so start-up work is less likely to run before your hooks are registered" | the resume path; `compact_resume_native.test.ts` ran its 13 cases on the new pin |
| 0.3.321 | "Fixed `reloadSkills()`, `reloadPlugins()` and `system/init` dropping project skills, commands or agents that a worktree lacks after Claude entered it" | `host.ts:3951-3952` reads `slash_commands` from init. The two reload methods are not called |
| 0.3.321 | "Fixed sessions hanging on save, and `importSessionToStore()` never rejecting, when memory ran out while a transcript was being read" | a hang would end at the turn watchdog (`turn_watchdog.ts:15-16`) |
| 0.3.321 | "Changed an SDK MCP server named `claude-in-chrome` to follow the organization's Claude in Chrome policy: where the policy denies it, the server is not connected" | kaoiro's one SDK MCP server is named `kaoiro` (`inter_agent_sdk.ts:78-79`) |

The remaining entries touch surfaces kaoiro does not use, which appear nowhere
in `src`: `WarmQuery.query()` after `startup()`, and `setMcpServers` with
`SpareProcess.claim()`. The last two are the parity lines for 2.1.321 and
2.1.320.

## Step 3: bundled CLI changelog 2.1.320 to 2.1.321

Source: the public
[anthropics/claude-code `CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
at `main` commit `a4fcccc70a89df6607e66cc30682d551269d0680` (committer date
`2026-11-09T19:22:09Z`); the fetched text hashes to
`09e4c8acf9a2d6907dc8bd07d572b112666447b07d57111d36cc7b8140457824`.

**Gap in the source: there is no heading for 2.1.320**, although the SDK
records parity with it, and no 0.3.320 package exists to read instead. Its
contents are unread and stay unclassified. The suites and measurements below
test the contracts their own assertions state, across the difference between
2.1.319 and 2.1.321; they are not a way to classify entries that were never
published, and a green suite is not used here as a statement about 2.1.320.

2.1.321 was read in full: 118 bullets. All 118 were read and each was placed
once, by its topic rather than by a keyword search.

| Column | Meaning |
|---|---|
| Reaches kaoiro | a kaoiro code path is named by `file:line` |
| Conditional | it reaches kaoiro under a stated condition |
| Not checked | not checked against a kaoiro path. **Not** a claim that it does not apply |

| Category | Entries | Reaches | Conditional | Not checked |
|---|---:|---:|---:|---:|
| Folding and queued input | 11 | 4 | 0 | 7 |
| Permissions | 18 | 11 | 2 | 5 |
| Hooks | 9 | 4 | 0 | 5 |
| Model switching | 9 | 5 | 0 | 4 |
| Total, counted once per category | 47 | 24 | 2 | 21 |

The 47 are 41 distinct entries: six belong to two categories. Such an entry is
quoted once, under the category its text leads with, and marked. Of the other
77 bullets, 8 are outside the four categories but touch a kaoiro path and are
listed at the end; 69 name no kaoiro path and are not quoted.

Where an entry's own sentence names a surface, that is recorded, but naming a
surface only describes the entry's text. It is not proof that the change
cannot reach a kaoiro path, and none of the "not checked" entries is used as a
ground for believing the new pin safe.

Every quote in this section and in step 2's table was checked to appear
verbatim as a whole bullet of the fetched text; changing one word of one quote
makes that check fail.

### Folding and queued input

| Entry, verbatim | kaoiro code path |
|---|---|
| "Fixed auto mode losing a background subagent's report that had started a turn when the conversation was compacted before Claude answered it" (also permissions) | `request_compact.ts`, `continuation_proof.ts`, `compact_resume_native.test.ts`; applies to a peer in permission mode `auto` |
| "Fixed one request carrying far more background agent reports than intended after Claude was stopped while several were waiting" | `host.ts:1846` (`interrupt()`), `continuation_proof.ts`, `native_continuation_host.test.ts` |
| "Improved auto mode in headless sessions, the desktop app and VS Code: reports from background subagents that wait together are answered in one model call, as in the terminal" (also permissions) | `adapter.ts:208-209`, `adapter.ts:329-331`; applies to a peer in permission mode `auto`. See the SDK table |
| "Changed background command notifications and TaskStop results to show Claude only the start and end of a command over 1,000 characters, which saves context" | `continuation_proof.ts:95`, `host.ts:786-812` (`parseNotificationPrompt`), `monitor_notification_advice_native.test.ts`; **measured below, with a regression** |

### Permissions

| Entry, verbatim | kaoiro code path |
|---|---|
| "Fixed a case where a read-only Bash command ran outside the sandbox without a permission prompt" | `host.ts:3150` (`canUseTool`), `host.ts:3661` (`#canUseTool`) |
| "Fixed a case where Bash permission checks judged a file write from the wrong folder and didn't prompt" | `host.ts:3150`, `host.ts:3661` |
| "Fixed deny rules and protected-file prompts not applying to the file that a `cp` or `mv` into a directory writes" | `host.ts:3150`, `host.ts:3661` |
| "Fixed Bash reads such as `grep -r foo \"$PWD/src\"` asking for permission when the same command with the path typed out runs without asking" | `host.ts:3150`, `host.ts:3661` |
| "Changed `AskUserQuestion` in `claude -p` and SDK sessions to deny a host's permission answer that sets the undocumented `afkTimeoutMs` input field" | `host.ts:3776-3779`: the allow answer is `{ ...input, answers }`. See the note below |
| "Changed `cp` and `mv` spelled by a path, such as `/bin/cp`, to get the same path checks as `cp` and `mv`" | `host.ts:3150`, `host.ts:3661` |
| "Changed the account email check to refuse only a shell command that holds your email and names a User-Agent, without asking, so other commands and scheduled runs no longer stop at its prompt" | `host.ts:3150`, `host.ts:3661` |

On `afkTimeoutMs`: the host adds one field, `answers`, to the input it was
given, so a field already present in the input is returned with it. The SDK's
own types declare `afkTimeoutMs` only on `AskUserQuestionOutput`
(`sdk-tools.d.ts:3992`); `AskUserQuestionInput` declares `questions`,
`answers`, `annotations` and `metadata`. The entry calls the field
undocumented, so the types cannot rule out that the CLI sends it. No native
test passes through AskUserQuestion, so the round trip is **not measured**.

### Hooks

| Entry, verbatim | kaoiro code path |
|---|---|
| "Fixed a large hook output pointing Claude to a file that held another hook's output from the same tool call" | `host.ts:3100-3147`: each kaoiro hook callback returns `{}` or one `updatedInput` |
| "Fixed apps that embed Claude Code getting their own PreToolUse hook's `ask` reason instead of another hook's when both asked" (also permissions) | `host.ts:3150-3156`: the callback reads `options.signal` only; `decisionReason` appears nowhere in `src` |
| "Fixed a PreToolUse hook's `ask` being lost when another hook's `defer` finished first and could not be honored" | `host.ts:3104-3111`: kaoiro's PreToolUse callback returns `{}` or `updatedInput`, never `ask` or `defer` |
| "Fixed NotebookEdit reporting success to hooks and telemetry when the edit failed, for example when the notebook changed while the permission prompt was open" (also permissions) | `host.ts:3112-3119` (`PostToolUse`, `PostToolUseFailure`, `#nativePostTool`) |

### Model switching

| Entry, verbatim | kaoiro code path |
|---|---|
| "Added Claude Fable 5.2 (`claude-fable-5-2`), now the default Fable model — 1M context, $8/$40 per Mtok with $0.20/Mtok cache reads" | `probe.ts:243-256`, `host.ts:4342` (`#findPinnedCatalogEntries`); the catalog probe and turn T1 above |
| "Fixed the fallback model sometimes declining a request or mentioning a stopped response when the first model was blocked before replying" | `adapter.ts:642-648`, `:661-687` (`refusal_fallback`, `refusal_no_fallback`) |
| "Fixed fast mode losing replies, switching models or retrying for minutes when fast serving is rate-limited, overloaded or failing; it now tries standard speed on the same model first" | `host.ts:1011` (`#fastMode`), `:1487`, `:3305`, `:3957` |
| "Changed saved Fable 5.1 model picks to move to `fable`: on Pro and Max plans at once, on Team and Enterprise plans once your organization allows it; use `/model claude-fable-5-1` to switch back" | `host.ts:3092-3094`, `host.ts:4375`, `:4376-4383`; turn T2 above |
| "Changed the Cyber Verification Program sentence on a cyber safeguard block to use the same words as claude.ai" | `adapter.ts:661-687` matches the notice by `subtype`; the sentence is matched nowhere in `src` |

### Conditional entries

| Entry, verbatim | Condition |
|---|---|
| "Changed mods Claude writes to turn on without asking in auto and bypass modes, even with managed `allowUnsandboxedCommands: false` or `allowManagedDomainsOnly`, and not to load in `dontAsk` mode" | the peer runs in permission mode `auto`, `bypassPermissions` or `dontAsk` (`wrapper/core/src/persona.ts:34-41`, `host.ts:3060-3063`) and Claude writes a mod in that session |
| "Changed mods' own tool calls (`$.tool.call`, `$.mcp.call`) to raise no permission prompt, even under your own ask rules or in `dontAsk` and `-p` runs; deny rules and organization policy still apply" | a mod is loaded in the peer's session; its own tool calls then raise no prompt, so they do not arrive at `canUseTool` (`host.ts:3150`) |

The second entry bears on the permission broker's premise. kaoiro shows an
operator a permission request when the CLI calls `canUseTool`. A tool call a
mod makes is, by this entry's text, never asked about, so it would not reach
the operator even for a peer in an asking mode. Whether kaoiro's PreToolUse
callback still sees such a call was **not measured**.

### Entries not checked against a kaoiro path

Each is recorded as not checked, which is the absence of a check and not the
absence of an effect.

| Entry, verbatim | Categories | What the entry text names |
|---|---|---|
| "Fixed the \"Draws from usage credits\" note showing after a switch to Fable on Enterprise seats whose plan includes Fable" | Model | a note shown on Enterprise seats |
| "Fixed `/config` showing Manual as the default permission mode when new sessions start in auto mode; pressing Space on \"Auto (default)\" now saves Don't Ask, not Plan" | Permissions | the interactive terminal UI (`/config`) |
| "Windows: Fixed `FileChanged` hooks stopping for paths set through `watchPaths` after the first shell command, when the session's working directory had a lowercase drive letter" | Hooks | Windows |
| "Fixed a rare crash on permission prompts and background tasks" | Permissions | no surface |
| "Fixed messages from a Claude Desktop Code tab session to your other sessions staying paused after you typed while Claude was still working" | Folding | Claude Desktop |
| "Fixed `claude agents` ignoring `--permission-mode`, `--dangerously-skip-permissions`, `--model`, `--effort` or `--agent` typed before `agents` when a flag such as `--verbose` was also on the line" | Permissions, Model | the `claude agents` entry point |
| "Fixed a Remote Control message sent with \"Queue for later\" reaching Claude in the middle of the running turn" | Folding | Remote Control |
| "Fixed remote sessions giving no reply after a restart when a `UserPromptSubmit` hook blocked a replayed permission answer; these hooks no longer run on that replay" | Hooks, Permissions | remote sessions |
| "Fixed `PreToolUse` `mcp_tool` hooks on stdio and HTTP MCP servers being skipped when their answer was over 16 MiB; the tool call is now refused" | Hooks | `mcp_tool` hooks |
| "Fixed background agents being reported as stopped by the user, and refused a resume, when a service interrupted a cloud session and nobody pressed Stop" | Folding | a cloud session |
| "Fixed a restarted cloud session dropping a message with a large image when the restart came before Claude's first reply to it" | Folding | a cloud session |
| "Fixed a restarted cloud session leaving a subagent's message to the main conversation unanswered" | Folding | a cloud session |
| "Fixed Claude not being told when you stop or pause a running workflow, so it no longer says the workflow is still running" | Folding | a workflow the user stops or pauses |
| "Improved the `/model` picker: \"More models\" is now an unnumbered row below every other, and older models open under it without renumbering the rest" | Model | the interactive terminal UI (the `/model` picker) |
| "Changed the fast mode labels in `/fast`, `/config` and `/model` to name your current model when it supports fast mode, and removed \"(Opus only)\" from the VS Code row" | Model | the interactive terminal UI (`/fast`, `/config`, `/model`) |
| "Changed OpenTelemetry hook events in non-interactive sessions to leave two built-in hooks out of `num_hooks` and `num_success` after Bash and PowerShell calls" | Hooks | OpenTelemetry events |
| "Changed the number of messages a Claude Desktop Code tab session can send to your other sessions before it waits for you to type again from 10 to 20" | Folding | Claude Desktop |
| "Changed Cowork cloud sessions: a PostToolUse hook can no longer replace the answer to AskUserQuestion or the plan in ExitPlanMode's result; Claude reads the originals" | Hooks | Cowork cloud sessions |
| "[VSCode] Fixed a plugin's permission request showing a name with hidden characters: it now reads \"a plugin\"" | Permissions | the VS Code extension |

### Outside the four categories

| Entry, verbatim | kaoiro code path |
|---|---|
| "Fixed context usage estimates overcounting tool definitions when exact token counts are unavailable" | `host.ts:4605` (`getContextUsage()`) |
| "Fixed project skills, commands and agents staying missing after their folder was removed and came back mid-session, such as with `git stash`, including after entering a worktree" | `host.ts:3951-3952` (`slash_commands` from init), `host.ts:3885` |
| "Fixed project skills, commands and agents disappearing from the menu in SDK and desktop sessions after Claude entered a worktree" | `host.ts:3951-3952` |
| "Fixed a turn ending with \"API Error: EPROTO: The TLS handshake failed\" when the connection broke partway through a reply; the partial reply is kept or the request is retried, as before 2.1.302" | `adapter.ts:323-345` (the error payload of a result) |
| "Fixed an MCP server sometimes showing as connected with no tools after it was reconnected or the session's directory changed while its tools were still loading" | `inter_agent_sdk.ts:78-79` (kaoiro's tools are one SDK MCP server), `host.ts:3136-3147` (`CwdChanged`) |
| "Fixed Bash commands sometimes running in the wrong folder when Claude sent several at once and an earlier one changed folders" | `host.ts:3136-3147` (`CwdChanged`, `#applyCwdChanged`) |
| "Fixed new messages not being saved, and `claude -p`, SDK and VS Code sessions hanging, when memory ran out while the transcript was being read" | `turn_watchdog.ts:15-16` |
| "Changed headless sessions to reload mods in `.claude/skills` when their files change; set `CLAUDE_CODE_PLUGIN_DIR_WATCH=0` to turn this off" | `host.ts:3064`: the child inherits `process.env`, so the variable set on the runner reaches the CLI |

## A regression on long background-command labels

The entry "Changed background command notifications and TaskStop results to
show Claude only the start and end of a command over 1,000 characters" reaches
an equality kaoiro depends on, and the committed suite does not exercise it:
every native test uses a short command.

When a background Bash command finishes, the CLI tells the model in a
`<task-notification>` block, and the SDK reports the same completion to the
host. kaoiro binds the model's next turn to the launch that started the
command only if the two agree, including on the summary text
(`continuation_proof.ts:95`; the path used when native continuations are off
compares the same two strings at `host.ts:2578`). The summary quotes a label:
the call's `description` when it has one, otherwise the command itself.

Measured in the remote heavy-test slot, with no network and no real model, by
running the committed `bash-idle` case of
`monitor_notification_advice_native.test.ts` with its command, its description
or both changed inside the run (the committed file was not changed). Label
lengths are in characters before XML escaping:

| Pin | Label | Outcome |
|---|---|---|
| 0.3.319 | description of 15; command of 1,339 behind it | bound; the report was sent |
| 0.3.319 | no description; command of 1,339 | bound; the report was sent |
| 0.3.321 | description of 15; command of 1,339 behind it | bound; the report was sent |
| 0.3.321 | no description; command of 839 | bound; the report was sent |
| 0.3.321 | no description; command of 899 | bound; the report was sent |
| 0.3.321 | no description; command of 1,339 | **refused**: `native_completion_unproved` |
| 0.3.321 | description of 1,000, 1,001 or 1,200; short command | **refused**: `native_completion_unproved` |
| 0.3.321 | Monitor with a description; command padded by 1,200 | bound; the report was sent |

The unchanged case passes on both pins.

The shortened form, read from the block and, where the proof refused, from
the SDK's report through a line added to the built proof inside the run: the
block keeps the first 480 and the last 275 characters of the label and puts
`\n\n... [N characters truncated] ...\n\n` between them, where N is the label
length minus 755 (445 for a label of 1,200, 245 for 1,000, 246 for 1,001, 584
for the command of 1,339). The SDK's report keeps the whole label. For the
1,339-character command the block's summary is 844 characters and the
report's 1,384. A label of 899 characters was not shortened and one of 1,000
was, so the threshold lies between them; the entry's "over 1,000" does not
describe the 1,000-character case. The exact threshold was not measured.

What a refusal does, as far as it was observed: the turn the notification
starts is not bound to the launch, so a kaoiro tool call in it is rejected. In
the run the scripted `send_to_agent` came back as `unbound_tool_call` and no
message was sent, where the control with a short description sent one. The
notification's turn still ended in a result that is not an error, the wrapper
process stayed up, and an inter-agent input sent afterwards started a turn
that also ended in a result that is not an error. The wrapper's output held
the one line `native continuation refused: native_completion_unproved` and no
line asking for a restart or reporting stopped admission. That is one
scripted scene; the server's journal and a production peer were not observed.

What triggers it: a Bash call run in the background whose label is about
1,000 characters or longer — a command that long with no `description`, or a
`description` that long. A short description hides a long command, and
kaoiro's registry only accepts a Monitor call that carries one
(`continuation_registry.ts:108`). How often a model omits the description was
not measured.

kaoiro's code is not changed by this bump, so the regression ships with the
pin. The way around it is to give a background Bash call a short description.
Teaching the proof the shortened form is a change to the continuation proof
and is left to a separate issue.

Runs, the first three on `edb7cbe0` or `6bdc9015` and the last two on the
record's own commit, whose source is the same as `edb7cbe0`:
`kohaku-edb7cbe-longcmdnew-1110063127-40cd.3094e34cc5337a95`,
`kohaku-6bdc901-longcmdold-1110063127-e24e.3141c60342b67430`,
`kohaku-edb7cbe-longcmd2-1110063347-e366.31cb6d19b7f00275`,
`kohaku-77fc9cd-longcmd3-1110064237-47ff.b97831f750016c81` and
`kohaku-77fc9cd-longcmd5-1110064358-3070.5bd53947721db69d`.

## Step 4: re-measurement of the input-folding premises E1 to E4

No verdict is carried forward. The premises, the five schedules, the judgement
table and the negative controls are those of the
[0.3.319 record](../issue-1044/sdk-0.3.319-2026-11-07.md#step-4-re-measurement-of-the-input-folding-premises-e1-to-e4),
which describes each of them; this section records what was run this time.

| Premise | Statement | This measurement (SDK 0.3.321 / CLI 2.1.321) |
|---|---|---|
| E1 | live input reaches the next model request verbatim, ticket included | **established** for the measured running-Bash fold |
| E2 | fold hook text and live-owner prompt ID match | **established** |
| E3 | input queued before a tool-free turn ends starts a new root prompt | **established** |
| E4 | `priority: now` waits for the running tool, ends the turn once, and starts the input as a new turn | **established** |

### Harness identity

The previous record's throwaway harness was removed after that measurement.
It was restored rather than rewritten, by replaying the recorded edits against
the retained 2026-09-28 originals, and the four files hash to the values the
0.3.319 record lists:

| File | sha256 |
|---|---|
| `probe.mjs` | `e9cc98e0ffb6540db999106676b79607047f1873f22c9b510f36f55e52eb234f` |
| `seam.mjs` | `bbf7827080ff04116423b8789b374a719d353ff309a75dcffb6fd671ce4d7c54` |
| `checker.mjs` | `da79901013d581bcd85c2d56140684467835e21f321ff4aadf09a7ff589de1d8` |
| `judge.mjs` | `919e0ef3d863b0179d60cce22c9b0592ab709458147bf71335a33d386ee42807` |

The byte match with a committed record is the whole ground for calling this
the same judge; it does not rest on the controls below. The container driver
is not covered by that record, so no identity with the earlier run is claimed
for it; as run here it hashes to
`aa5dc3d9a661c3e5088a20eb769169097445c24d4c18a23d681c157caf961902`, and it
differs from the copy used for the baseline in one line, the version in the
native executable's path.

The run checks the four hashes before it starts a probe. That gate was shown
to bite on the real path: the same run with one byte appended to `judge.mjs`
in the archive ended in the prepare stage with exit 1, and the measurement
body never started (run
`kohaku-edb7cbe-e1e4g1neg-1110062531-d67c.b2818a2d10bf11c4`).

Because the judge is byte-identical, it has the gaps the 0.3.319 record names:
`J17`, `J20` and `J21` have no falsifying and no positive control, and N7
covers only the judge's own byte predicate. This record neither widens nor
narrows them.

### The runs

Both in the remote heavy-test slot, class `test` (no network), on the image
`sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`,
with a scripted provider on loopback and a dummy key: zero real model
requests. The container reported uid/gid 1001, `HOME=/w`, `CI=true` and Node
v22.23.3.

| | Baseline | New pin |
|---|---|---|
| Run | `kohaku-6bdc901-e1e4base2-1110062136-31e8.340ab37af25e7f29` | `kohaku-edb7cbe-e1e4new-1110062531-4638.e1cb781025c6195c` |
| Commit | `6bdc9015` | `edb7cbe0` |
| SDK / CLI | 0.3.319 / 2.1.319 | 0.3.321 / 2.1.321 |
| Native sha256, read in the run | `dabafec8…8eed` | `426c3381…bf61f` |
| Judgements | 55 pass, 0 fail, 0 skipped | **55 pass, 0 fail, 0 skipped** |
| Requests / results, B0 F1 T1 P1 F2 | 2/1, 2/1, 2/2, 2/2, 2/1 | 2/1, 2/1, 2/2, 2/2, 2/1 |
| `finished.duration_ms`, same order | 2132, 3926, 1276, 2149, 3928 | 2121, 3898, 1275, 2124, 3929 |
| `owned_children` | 0 in all five | 0 in all five |
| stdout sha256 | `79a8a587c10169a415c72b606d050d2133307c1951f7182b08da501bbc6444e0` | `ae9c79d8d9d7479ed2f754a66afa5bca5d69f3e13e131143c886007a8808541d` |

The baseline exists to show the restored harness is alive against today's
wrapper, and to give the new pin a same-day comparison on the same tree. The
two commits differ only in the pin, the lockfile and the five re-pinned guard
lines.

The comparison: the verdict lines, the lines each negative control prints and
the positive-control lines were extracted from both logs with one expression,
with UUIDs and millisecond offsets replaced. The 81 extracted lines are
**identical**. In particular each control broke the same judgements as on the
baseline, which are those in the 0.3.319 record's table: N1 and N2 17 each, N3
`J5` and `J7` on F1 and F2, N4 `J10` on T1 and `J15` on P1, N5a `J6` and `J24`,
N5b `J9` and `J25`, N5c `J13` and `J26`, N6 `J12`, `J14` and `J18`, N8 `J3` on
F1 and F2, N9 `J27` on all five, N10 `J0` with the run then skipped, and N7
failing the judge's self-test. The absence claims kept their positive
controls: the payload is found in request 2 of F1, T1, P1 and F2 and nowhere
in B0, and one frame carries a `tool_use` block in every run but T1. The two
runs' stderr is also identical once timestamps, UUIDs and process IDs are
replaced.

### Limits of this measurement

The limits of the 0.3.319 record apply unchanged: the seam does not go through
kaoiro's own push path, control and format characters are left out of the
payload, and E5, R3 and S1 of the 2026-09-28 record were not re-measured.
E1 to E4 are established for the five measured schedules only.

## Step 5: lockfile, guards, suites and the native checks

Five guards in three suites hold the installed artifact so that a pin change
cannot land unreviewed. They moved to the measured values in `edb7cbe0`,
keeping their shape:

| Test | Guard |
|---|---|
| `compact_resume_native.test.ts:26` | SDK and CLI version |
| `monitor_notification_advice_native.test.ts:33` | SDK and CLI version |
| `monitor_notification_advice_native.test.ts:168` | CLI version, on each notification row |
| `native_peer_opener.test.ts:34` | SDK version |
| `native_peer_opener.test.ts:41` | native executable sha256 |

That they are bound to the installed artifact: on `8997bcfe`, with the pin
moved and the guards not yet, the three files failed — 21 tests failed and 2
passed, 13 and 6 on the version pair, and the two `native_peer_opener` pins
(run `kohaku-8997bcf-nativered-1110062335-1aec.eddeeba09688d069`). The guard
at `:168` sits behind `:33`, so it was mutated on its own on `edb7cbe0`: one
digit changed in its expected version failed all 6 cases with `:33` intact
(run `kohaku-edb7cbe-mut168-1110062717-0675.088827a6d2241463`).

The scan the previous bump's miss called for: searching the whole tracked
tree outside `docs/` and the lockfile for the outgoing SDK version, the
outgoing CLI version, the outgoing native hash and the outgoing `sdk.mjs` hash
returns nothing after the re-pin. The same search for the new values returns
the pin line and the five guards. Older captures, such as
`test/fixtures/claude-agent-sdk-0.3.306.models.json`, stay on the version they
were recorded at.

`native_peer_opener.test.ts:34` asks for a review of the native framing on
each SDK update. The two framing constants kaoiro hard-codes
(`native_peer_opener.ts`) were searched for in both native executables, split
at newlines, quotes and non-ASCII characters: every piece occurs the same
number of times in 2.1.321 as in 2.1.319, and a one-letter mutation of a piece
occurs in neither.

The whole `@kaoiro/claude-code` suite on `edb7cbe0`, in the remote heavy-test
slot with the wrapper and the runner built: **55 files passed and 1 skipped;
1328 tests passed and 4 skipped**, exit 0, in 112 s (run
`kohaku-edb7cbe-ccsuite-1110062717-7215.dd748746206f8c32`). Eleven `*native*`
files ran, `cli_delivery_policy_native.test.ts` among them. The skipped file
is the opt-in `haiku55_native.test.ts`, which was then run on its own in the
same slot with `KAOIRO_LIVE_CLAUDE=1`: 4 of 4 passed. Its provider is a
scripted loopback endpoint, so no real model ran.

The Node and Elixir suites also run through the pre-landing CI on the
candidate commit.

## An observation kept apart

While this bump was being prepared, production ran the previous pin with one
peer set to the explicit model `claude-fable-5-2`. That peer reported
`model: claude-fable-5-2` with a 1,000,000-token context and worked through
its turns. In that session one harness notice named `claude-sonnet-5-5` as the
model's identity, at 2026-11-09T20:44:41Z. The director read the session
transcript and reported that every assistant message in it carried
`claude-fable-5-2`. This record did not verify that observation, did not
establish its cause, and does not treat it as a condition. A turn that
succeeds with the expected responding model and a CLI that describes the
model's identity correctly are two different properties; only the first is
measured above. If the notice appears on the new pin at the release, it is to
be reported apart from the connectivity result.

## Release-note candidates

These are operator-visible changes inherited from the vendor, not changes
kaoiro makes:

- **Claude Fable 5.2.** A peer whose model is the alias `fable` moves to
  `claude-fable-5-2` at the release. The vendor's entry gives a 1M context and
  $8/$40 per Mtok with $0.20/Mtok cache reads. A peer that must stay on 5.1
  sets `claude-fable-5-1`, which the new CLI honours (turn T2).
- **Long background-command labels.** A background Bash call whose
  description, or whose command when it has no description, is about 1,000
  characters or longer completes into a turn that cannot call kaoiro tools:
  `send_to_agent` and the others return `unbound_tool_call`. The previous pin
  does not do this. In the one scene observed the peer was not stopped and
  its next input ran normally. Give a background Bash call a short
  description to avoid it.
- **Auto mode.** Reports from background subagents that wait together are
  answered in one model call; all but the last arrive as a result with an
  empty text.
- **Bash permission checks.** A read-only command outside the sandbox, a
  write judged from the wrong folder, and the target of a `cp` or `mv` into a
  directory are now asked about or refused where they were not. A peer in an
  asking mode may be asked more often.
- **Mods.** A mod Claude writes turns on without asking in auto and bypass
  modes, and a mod's own tool calls raise no permission prompt, so they do not
  reach the operator's permission dialog.
- **Standby.** The release of an engine pin change is "plain shell only".

## Limits of this record

- 2.1.320 has no published changelog entries and 0.3.320 was never published,
  so their contents are unread and unclassified.
- The categories record what was checked, not what applies. The 21 "not
  checked" placements are the absence of a check.
- The new pin ships a measured regression: a background Bash call whose label
  is about 1,000 characters or longer completes into a turn kaoiro refuses to
  bind, so that turn cannot call kaoiro tools. It fails closed, and the
  previous pin does not do it. Its exact length threshold, what the server's
  journal records, and its behaviour on a production peer were not observed.
- Not measured: the auto-mode shared report call, the AskUserQuestion round
  trip, a mod's tool call against the PreToolUse callback, the CLI's migration
  of saved Fable 5.1 picks, and an account without a `claude-fable-5-1` row.
- The real-model turns show the SDK, the CLI and the account working for
  three model strings on one account on one day. A kaoiro peer's turn on the
  new pin is confirmed at the release, with `whoami` and a short turn for a
  peer on `fable` and for one on the explicit `claude-fable-5-2`.
- E1 to E4 are established for the five measured schedules only.
- The suites and the catalog probe establish what their own assertions say.
  Production start-up behaviour is not established here; the production-shape
  start gate belongs to the release.
