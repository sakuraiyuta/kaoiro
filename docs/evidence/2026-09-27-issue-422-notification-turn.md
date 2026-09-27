---
title: Claude background-notification reply origin reproduction
description: Actual SDK and production-host observations for issue 422, including a no-background control.
status: measured
last_updated: 2026-09-27
---

# Claude background-notification reply origin reproduction

## Baseline and method

Measured on Linux at production source commit
`b71674a28baa0b1e4b113dca40ce02b220e6373c`, built with
`pnpm --filter @kaoiro/claude-code... build` (exit 0, no build warnings).
The installed SDK was `@anthropic-ai/claude-agent-sdk` 0.3.280; its actual
`system/init` reported Claude Code 2.1.280 and `claude-sonnet-5`.
`pnpm install --offline --frozen-lockfile` exited 0 with expected pre-build
missing-probe-bin warnings and an ignored `tesseract.js` build-script warning.

Both probes used the built, unmodified `AgentHost`, `buildKaoiroMcpServer`,
`InterAgentTool`, `ToolOrigins`, and `ReplyBasis`. A transparent query iterator
recorded the real SDK stream. The resolver recorded and returned the real
`host.toolOrigins.resolve(id)` result; the shared tool's invocation was also
recorded without changing its result. `onTurnStart`/`onTurnEnd` called the
production `beginReplyInput`/`endReplyInput` methods. A synthetic peer input
with basis 1 was prepared at the start. The only send sink was a recording
callback returning an acceptance: no real peer or server received test traffic.
This proves local admission/rejection, not server acceptance semantics.

Fresh SDK sessions used an isolated scratch cwd, `settingSources: []`,
`model: "sonnet"`, `effort: "low"`, tools `Bash` and the actual kaoiro MCP server,
`ENABLE_TOOL_SEARCH=false`, and `bypassPermissions`. The permission choice
exercises the MCP-handler guard without the separate `canUseTool` guard;
the SDK warned that `canUseTool` was shadowed. Authentication remained the
operator's existing SDK authentication; no credentials were recorded.

[Captured evidence](2026-09-27-issue-422-notification-turn.json) contains selected
raw events, source baseline, SHA-256 values for the built modules, SDK module
and types, disposable probe programs, and original logs. Thinking blocks,
signatures, account limits, and unrelated initialization fields were omitted.
The source files governing the measured behavior were also unchanged between
this production baseline and the documentation branch base `b1d9b2e5`.

## Actual event order

Run 1 (`events.jsonl`) used one query and two wrapper inputs:

1. Send `CONTROL` to the test peer without Bash or Agent, then finish.
2. Launch `sleep 12; printf BACKGROUND_DONE` with `run_in_background=true`.
   End the response with `WAITING`, without polling or `TaskOutput`. On the
   automatic completion notification, send `BACKGROUND` once and finish.

| Sequence | Actual observation |
| --- | --- |
| 3, 6–10 | Host input starts; normal `send_to_agent` tool ID resolves to its live token; transport records one send with `in_reply_to: 1` |
| 12–14 | Control result ends its token; second wrapper input starts |
| 16–23 | Background Bash starts; assistant says `WAITING`; SDK emits a successful result; host ends the second token |
| 26–28 | SDK emits `system/task_notification`, host records task completion, then SDK emits another `system/init` |
| 30–33 | SDK emits a new root assistant `send_to_agent` tool use; `_meta` supplies its matching ID; resolver returns no origin; shared tool returns `unbound_tool_call` with `send_not_attempted: true` |
| 35–36 | Successful SDK result has `origin: {kind: "task-notification"}`; host's end callback has no `turnToken` |
| 37 | Probe finishes with three results and one transport send total |

There is no host input start between the task notification and failed send.
The original snapshot and origin are retired before that notification.
`host.ts` observes the new ID, but `ToolOrigins.observe()` ignores it because
there is no current origin. This is not a missing MCP tool ID or an expired
ticket. The SDK's successful result describes completion of model processing,
not successful delivery of the rejected inter-agent message.

Run 2 (`replay-events.jsonl`) repeated only the background case with
`extraArgs: {"replay-user-messages": null}` and SDK debug logging. It replayed
the explicit wrapper input (sequence 6), but emitted no corresponding
user-role notification input before the continuation's tool call. The same
unbound rejection occurred; zero sends reached the recording sink.
Both runs used fresh sessions. The result's `origin` arrives too late to
constitute a pre-tool authorization boundary. `system/task_notification`
reports task completion, not necessarily that its content has entered a new
model turn. Run 2 does not establish that every possible SDK option lacks an
earlier boundary; it rules out this particular replay option on this version.

Both probe processes exited 0 with no unhandled errors. In addition to the
SDK permission warning, the host warned about unrecognized `task_updated`
and states such as `thinking`/`tool_running` without an active turn. Those
warnings are observations of the same untracked continuation, not passing
lifecycle checks.

## Model usage and limits

| Measurement | Run 1 | Run 2 |
| --- | ---: | ---: |
| Explicit SDK `query()` invocations | 1 | 1 |
| Main-model round trips (`num_turns`, checked against distinct response IDs) | 6 | 4 |
| SDK results | 3 | 2 |
| Recorded transport sends | 1 | 0 |
| SDK final cumulative estimated USD | 0.1421598 | 0.0581536 |

Total: two queries, ten main-model round trips, estimated USD **0.2003134**.
Both runs also report internal Haiku usage. Run 2 debug output directly records
five API dispatches: four Sonnet and one Haiku. Run 1 lacked debug logging;
its six main-model calls and nonzero Haiku usage establish at least seven
calls, but do not establish the exact number of internal calls or hidden
transport retries. Thus **at least twelve model API calls overall**, not
merely two. No further model calls were made to improve that accounting.
These SDK estimates are not billing statements.

A disposable checker read the retained JSON and asserted the actual ordering,
matching tool ID resolution, absence of a host start/send in each continuation,
unbound error, result origin, normal control send, and usage counts (exit 0).
Changing the retained failure code to a different value made that checker
exit 1 with `AssertionError`; the final unmodified artifact passed again.
The checker and probes are investigation tools, not committed product tests.

This establishes the background-Bash failure mechanism with a real model and
actual host. It does not reproduce the exact production Ao transcript, a
448-second Agent invocation, nested subagents, concurrent wrapper inputs,
resume schema caching, or every permission mode. The production incident is
consistent with the mechanism, but its exact event order was not independently
retrieved. Do not claim a successful general notification-origin fix from
these baseline measurements.
