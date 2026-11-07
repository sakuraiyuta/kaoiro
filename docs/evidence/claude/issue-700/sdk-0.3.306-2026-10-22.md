---
title: Claude Agent SDK 0.3.306 compatibility and catalog measurement
status: measured
last_updated: 2026-11-07
---

# Claude Agent SDK 0.3.306 compatibility and catalog measurement

[Issue #700](https://github.com/sakuraiyuta/kaoiro/issues/700) raises the SDK
from 0.3.293 to **0.3.306**, based on develop
`6fc38d11bdc9d8818136e4990d181d0048ad6471`. The selected release is the
requested latest candidate; its installed manifest and native executable
both identify **Claude Code 2.1.306**. This clears the minimum version for
command-hook `onFailure: "block"`, documented as 2.1.295 in the
[hooks reference](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails).
The downstream hook configuration is outside this change.

Only the dependency, its platform packages in the lockfile, and measurement
documentation change. No new SDK feature or permission policy is enabled by
kaoiro. pnpm 10.20.0 preserves the existing Anthropic API SDK, MCP SDK, Zod,
and other resolved dependency versions. An unrelated refreshed deprecation
annotation was excluded from the lockfile diff.

## Changelog review and integration boundary

The SDK [0.3.293–0.3.306 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/9c59e061a0e49a4a99012218de66915bd407c96d/CHANGELOG.md)
was read in full for this range, including parity-only releases.
The following upstream changes are relevant; compatibility conclusions are
source inspection, not a claim to have reproduced every upstream fix.

| Surface | Upstream changes reviewed | Existing kaoiro path checked |
|---|---|---|
| Stream messages | 295: citation/rate-limit metadata, result caps and missing non-execution tags; 299: optional elicitation field and omitted merged origin body; 302: refusal results | host.ts consumes discriminated messages and optional metadata; no admission decision reads origin.body. Existing result-origin, notification and receipt tests remain authoritative |
| Permission callback | 295/296: oversized permission updates denied; 300: connector option rollback; 301: optional MCP policies; 302: omitted-mode behavior | host.ts supplies an explicit initial permissionMode and returns decisions via canUseTool, with signal/tool-use ownership. It does not depend on the removed hint or emit bulk permission updates |
| Interrupt/input folding | 299: queued-block separators and rewind handling; 300: background-report turn separation and rewind ordering | Query.interrupt and stream input remain the transport boundary. Prompt-id hooks, notification ownership and fold receipts are checked by existing host/CLI suites; kaoiro does not invoke rewind_conversation |
| Catalog | 296: CLI version in initialize; 301: setModel fix; 304: context metadata; 305: usage additions | probe.ts projects initialization models with supportedModels fallback. Extra fields do not change the projection. The real compiled probe is measured below |
| Hooks/startup | 295: equals-form arguments; 296: sandbox merge; 300: hook-input validation; 304/305: startup hook timeout fixes | host.ts composes UserPromptSubmit/PreToolUse/Stop/StopFailure/CwdChanged callbacks. These return empty responses; tool updatedInput remains on canUseTool. Custom process spawning forwards argv. No new startup/prewarm path is adopted |
| Other defaults | 302 enables fork subagents in SDK sessions | No fork-specific option is introduced. Existing subagent/notification handling stays in scope of regression gates; this measurement does not establish live fork execution behavior |

0.3.294, 297, 298, 303 and 306 list CLI parity updates without an additional
SDK API change. Browser-only APIs and new convenience exports are not adopted.
Type declarations retain the callback signal, tool-use identity and typed
interrupt receipt consumed by kaoiro. Any new behavior in the vendor binary
is inherited; the table does not mean its defaults were frozen by kaoiro.

## Production catalog probe

After the normal wrapper build, the existing production executable was invoked:

```sh
node wrapper/claude-code/dist/probe.js
```

It returned exit 0, empty stderr, `ok: true`, `source: "init"`, and **13 rows**.
The query's prompt iterator never yields a user message. This is an
initialization-only catalog measurement, not a model-generation or tool-policy
acceptance test. Authentication was inherited through the normal probe path;
credentials, commands, usage/account data and transcripts are not published.

The projected rows are preserved in
[sdk-0.3.306-catalog-2026-10-22.json](sdk-0.3.306-catalog-2026-10-22.json).
The value/resolved-model/effort projection matches the 0.3.293 capture; the
old fixture is unchanged. No synthetic menu row or bootstrap model was added.

| value | resolved_model | effort_levels |
|---|---|---|
| `default` | `claude-opus-5-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `opus` | `claude-opus-5-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `fable` | `claude-fable-5-1` | `low`, `medium`, `high`, `xhigh`, `max` |
| `sonnet` | `claude-sonnet-5-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `haiku` | `claude-haiku-5-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` | — |
| `claude-sonnet-5` | `claude-sonnet-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-opus-5` | `claude-opus-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-fable-5` | `claude-fable-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-opus-4-8` | `claude-opus-4-8` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-opus-4-7` | `claude-opus-4-7` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-opus-4-6` | `claude-opus-4-6` | `low`, `medium`, `high`, `max` |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | `low`, `medium`, `high`, `max` |

## Bundled CLI changelog entries (2.1.294 to 2.1.306)

The bundled CLI changelog is the public
[`CHANGELOG.md`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/CHANGELOG.md)
at commit `0ed94698aa0aeee471465fc9c867c2e8434c4d68`. The range has headings
for 2.1.294 to 2.1.306 except 2.1.297 and 2.1.298, which the changelog does
not list. The bullets were first filtered by keyword (folding and queued
input, interrupts, permissions, hooks, model switching). The nine entries
below were selected from that filtered list as relevant to kaoiro. The
selection is a judgment, not a line-by-line check of every bullet.

| CLI | Area | Entry (verbatim) |
|---|---|---|
| 2.1.299 | Folding and queued input | "Fixed queued prompts sent as content blocks over `--input-format stream-json` running together without a line break when merged into one turn" |
| 2.1.304 | Model switching and interrupts | "Fixed model switches, messages and interrupts waiting behind a context usage check in SDK and desktop sessions" |
| 2.1.302 | Permissions | "Changed `claude -p` and Agent SDK sessions with no permission mode to start in `default` mode on third-party providers, with telemetry off or on a fresh install; `--permission-mode auto` keeps auto" |
| 2.1.299 | Permissions | "Fixed a cloud session sometimes ignoring the answer to a permission prompt or a question when the answer was given while the session's worker was being replaced" |
| 2.1.295 | Hooks | "Added `onFailure: "block"` for command and HTTP hooks: a hook that can't start, times out, or exits with an unexpected code blocks the action instead of letting it through" |
| 2.1.300 | Hooks | "Changed hooks: `updatedInput` from PreToolUse and PermissionRequest hooks is now validated like Claude's own input: unknown keys are dropped, and input the tool rejects denies the call" |
| 2.1.304 | Hooks | "Fixed a PreToolUse hook's deny reason being replaced by a timeout error when an Agent SDK callback hook on the same tool call timed out" |
| 2.1.299 | Hooks | "Changed `UserPromptSubmit` hooks to run before a skill or custom slash command expands, so a hook that blocks the prompt now also stops its embedded shell commands" |
| 2.1.305 | Model switching | "Fixed `/effort` and `/autocompact` settings not applying when the model name differed from a `modelOverrides` value by letter case or a `[1m]` tag" |

The two 2.1.294 entries concern `prompt` and `agent` hooks, which the table
above does not list as touched by kaoiro. They are not selected.

The fold re-measurement (E1 to E4) for SDK 0.3.306 is not recorded in this
repository: no evidence file exists and no issue comment records it, so this
section does not restate it.

## Artifact identity and limits

| Artifact | SHA-256 |
|---|---|
| `wrapper/claude-code/src/probe.ts` | `f45bc21c838a26a88e935e67d36300782c1af7130709a131ff6a89e89b7d0da6` |
| `wrapper/claude-code/dist/probe.js` | `9ed0c719535b98059df78a29162f0f7103f060f8b3322732f0058ea089a6dbf8` |
| `wrapper/claude-code/src/host.ts` | `81d7b0204e7ff517921984715f0656531252edc71c5087de5de9d57df5eb1cfd` |
| `sdk.mjs` | `48480d49d4493e2aec28227d8db8f8432743c7aa32facbdb9a7ce0a0363f7503` |
| `manifest.json` | `2c2e75d5231f4169ca23e4a14f62608bd862bca4e21d7eb64456e8a9140f7896` |
| `linux-x64-claude` | `520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe` |

The native executable matches the Linux x64 checksum in the installed manifest.
Build and catalog evidence are bound to these exact bytes. Full regression
gates and their command exits, warnings, baseline comparisons and cleanup are
recorded separately for the implementation-review handoff. No release,
deployment, runner restart or downstream settings change is part of this work.
