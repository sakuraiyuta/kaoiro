---
title: "Codex app-server context-usage research"
status: measured
last_updated: 2026-10-02
---

# Codex app-server context-usage research

Research for [issue #485](https://github.com/sakuraiyuta/kaoiro/issues/485).
The recommendation is to retain `supports_context_usage: false` under
[ADR-0040 D3](../../adr/0040-context-usage-capability.md#d3-codex-adapter-sets-capabilityfalse-and-does-not-project-estimates).
A native snapshot meter is technically feasible, but its values include an
upstream estimate after compaction. Adopting that meaning requires an explicit
policy decision; this research changes neither the adapter nor the accepted ADR.

## Target and composition

- Wrapper source: `ea567492d43a12bc8f68d9c215db27ecc92984d5`.
- Native binary: the workspace-pinned `@openai/codex` 0.159.3 Linux x64 binary,
  reporting `codex-cli 0.159.3`, SHA-256
  `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
- Real authenticated ChatGPT account, `gpt-6.1-sol`, ordinary-turn effort `low`.
  No account identifier or credential was transcribed.
- Production `runCodexCli()` with normal configuration parsing and the default
  `CodexHost`, `AppServerSession`, transport, and native RPC process. No CLI
  dependency, host factory, or session factory was injected. A local Phoenix
  endpoint supplied the wrapper connection and persona prompt; it supplied no
  Codex response or usage data.
- Observers forwarded spawn arguments, RPC return values, and stdout chunks
  unchanged. A captured native RPC issued `thread/compact/start`. Resume-history
  reads used the host's normal scheduling path. These were measurement actions.
- One native thread received five ordinary turns and one explicit compaction.
  The prompts retained a fixed marker and disposable text; captured items show
  no tool or subagent calls.

The wrapper was built successfully before the probes. The measurement JSON
binds seven built runtime assets and the observation scripts through the capture
manifest. The real binary generated the notification JSON schema. The shell's
unversioned `codex` was 0.157.0 and was not used.

TUI comparisons used the same pinned binary and thread, with `/status` entered
in a dedicated tmux terminal after the wrapper's owned app-server processes had
closed. MCP servers were disabled for this read-only TUI comparison. It submitted
no model prompt. The main agent's working directory remained unchanged.

## Observations

All ten captured usage notifications reported `modelContextWindow=258400`.
The table selects the latest notification at each successful native terminal;
resume replays account for the other notifications. Raw percentages below are
`100 * last.totalTokens / modelContextWindow`, not Codex TUI percentages.

| Checkpoint | `last.inputTokens` | `last.outputTokens` | `last.totalTokens` | `total.totalTokens` | Raw occupancy, out of 258,400 tokens | Native TUI `/status` |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Turn 1 | 28,060 | 1,203 | 29,263 | 29,263 | 11.3247% | `93% left (29.3K used / 258K)` |
| Turn 2 | 33,446 | 9 | 33,455 | 62,718 | 12.9470% | `91% left (33.5K used / 258K)` |
| Turn 3 | 33,481 | 17 | 33,498 | 96,216 | 12.9636% | `91% left (33.5K used / 258K)` |
| Explicit compaction | 0 | 0 | 16,444 | 96,216 | 6.3638% | No context row observed on the immediate TUI resume |
| First turn after compaction | 32,342 | 9 | 32,351 | 128,567 | 12.5197% | `92% left (32.4K used / 258K)` |
| Next turn after another CLI resume | 32,370 | 9 | 32,379 | 160,946 | 12.5306% | `92% left (32.4K used / 258K)` |

`last.inputTokens` omits output retained in the latest snapshot. Adding output
matches `last.totalTokens` for these ordinary turns, but produces zero immediately
after compaction, when the native context snapshot is 16,444. `total.*` accumulates
request usage and did not decrease during compaction. It is not context occupancy.
Cached input remains part of the context; subtracting it, or adding reasoning
and cached counts again, does not define a better context count.

The five available TUI context rows agree with `last.totalTokens` within the
TUI's display rounding. The pinned release's
[status card](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/status/card.rs#L356)
uses the last token-usage snapshot. Its
[percentage calculation](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/token_usage.rs#L38)
subtracts a fixed 12,000-token baseline from both the window and the used count,
then rounds the remaining percentage. That accounts for all five observed
percentages. The TUI percentage and its displayed raw token fraction have
different denominators; taking `100 - TUI remaining` would mix those meanings.

Compaction was confirmed by its completed `contextCompaction` item and successful
native turn terminal. The pinned release's
[compaction path](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core/src/compact.rs#L393)
calls
[recompute_token_usage](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core/src/session/mod.rs#L4846).
That function estimates history plus base instructions, stores the estimate in
the last total, and zeroes its input/output breakdown. This explains the live
nonzero total with a zero breakdown. The next normal response supplied a new
provider-backed snapshot of 32,351; the compaction snapshot is not a promise of
the exact token size of the next request.

The release source was inspected at commit
`01fc69f4026735edfdf6789820549727a4867b11`. Four relevant downloaded files matched
their immutable commit URLs byte for byte. Source inspection corroborates the
observations; it is not a substitute for the binary measurements.

## Resume and unknown window

An ordinary resume replayed the preceding turn's usage before any new model
turn. The final resume, for example, replayed `last.totalTokens=32351` and the
same 258,400-token window before producing 32,379 after its new turn. That
notification carries the previous turn ID. A consumer attached only to the new
turn's projection would miss it.

The first successful wrapper resume immediately following compaction completed
its native history read without any usage notification before the next turn.
The immediate TUI resume displayed `/status` but no context row was observed
during the 35-second capture window. A later normal turn restored both usage
notification and TUI context display. Missing telemetry must not mean zero usage
or silently reuse a denominator from another model or generation.

No live notification with `modelContextWindow=null` was observed. The native
generated schema allows a nullable or omitted window. Nine controlled checks
ran the actual built parser and projection against captured counts: null,
omission, and a positive window were accepted; zero, negative, and unsafe-integer
windows were rejected by the parser. The projection retained null for null and
omitted windows. These are controlled input checks, not evidence that this
account/provider emitted null. The current host continued to advertise false
and omitted `ext.context` throughout the captured default composition.

## Specification recommendation

Retain false for this research outcome. The available field identifies the
native context snapshot, but does not establish the exact current occupancy
required to remove ADR-0040's prohibition on estimates without a policy change.
In particular, importing an upstream estimate is still choosing to display an
estimate. This recommendation is about that accepted policy, not an inability
to consume the notification.

If the operator approves a **native snapshot estimate** as the meter's meaning,
the candidate formula is:

```text
used_tokens     = tokenUsage.last.totalTokens
max_tokens      = tokenUsage.modelContextWindow
used_percentage = 100 * used_tokens / max_tokens
```

Publish a value only when the complete snapshot is valid and `max_tokens` is a
positive safe integer. Preserve the native total instead of reconstructing it
from input/output counts. Do not infer a window from a catalog, reuse a stale
model's window, or use cumulative totals. Unknown/null window means unavailable,
not zero. The formula is a raw occupancy ratio and intentionally differs from
the TUI's baseline-adjusted percentage. Out-of-window snapshots and display
clamping would need an explicit contract in the subsequent design; this sample
did not exercise them.

No ADR-0040 addendum is required to retain the accepted false behavior. Adopting
the candidate requires an addendum that narrows or supersedes D3 for app-server,
authorizes native estimates, defines the percentage and unknown/resume behavior,
and leaves the exec backend's false behavior intact. A fall after compaction is
expected for current context occupancy; the historical Context §2(b) argument
should not be reused as a reason to reject this native snapshot. Record that
clarification in the addendum rather than rewriting the historical decision.

The subsequent implementation design would also need thread-scoped telemetry
for resume and explicit compaction outside an active turn. Adding a consumer
only to `kind: "usage"` in the existing per-turn projection is insufficient.
That design and all source changes are outside this research assignment.

## Verification and retained artifacts

Machine-readable observations and the content binding are in
[context-usage-2026-10-02.json](context-usage-2026-10-02.json). Raw selected-field
captures, scripts, full failure logs, generated schema, and the manifest remain
under `/home/yuta/git/kaoiro/worktrees/fuji-485/tmp/fuji-485-capture/` until the
issue closes. The manifest SHA-256 is
`0178a4c415f3bd8e4bf40772d3f472d4a44fa1d32d773ae8b655e6845d3e4e28`.
The committed JSON preserves the numeric observations even after scratch cleanup.

- Production wrapper build: exit 0; all wrapper packages built. No source was
  modified, and no full regression-suite claim is made for this research.
- Capture checker: exit 0; five ordinary turns, one compaction, ten raw usage
  notifications, five TUI context comparisons, and nine controlled input cases.
- Negative control: removing the native compaction usage lines from a temporary
  copy made the same checker exit 1. The original remained unchanged and passed
  again with exit 0. No subsequent mutation was performed.
- Recorded owned app-server and successful TUI/tmux PIDs were absent at cleanup
  audit; no dedicated tmux socket directory remained. Signals targeted only
  the held PIDs of processes created by the probe.
- Account RPC responses and full TUI account/status rows were excluded from the
  capture. The selected event objects contained no account-identity field.

Failed measurements are retained rather than counted as passing gates. The
initial and continuation captures each completed a native turn but exited 1
because TUI acquisition failed. `turn-3`, `post-compaction-retry`, and `resume`
exited 0. `compact-retry` completed the native compaction but exited 1 because
the resumed TUI context row was unavailable. Earlier `compact` and
`post-compaction` attempts exited 1 during native resume. The latter captured
the exact native error `already has an active writer`; subsequent delayed
attempts succeeded. The cause and ownership lifetime of that refusal were not
determined, and no host-wide process search or forced thread takeover was used.

Expected fixture/startup diagnostics included absent Phoenix protocol/delivery
negotiation and an empty model catalog when `chatgpt_plan` was not configured.
Manual compaction was reported as a foreign turn with enforcement disabled.
These observations do not establish behavior for automatic compaction, multiple
compactions, model switching, nonzero reasoning-output usage, images, other
models/providers, or other Codex releases.
