---
title: "Codex app-server context-usage research"
status: measured
last_updated: 2026-10-02
---

# Codex app-server context-usage research

Research for [issue #485](https://github.com/sakuraiyuta/kaoiro/issues/485).
The recommendation is to retain `supports_context_usage: false` while the five
qualification gaps below remain unresolved, pending the operator's adoption
decision. [ADR-0040 D3](../../adr/0040-context-usage-capability.md#d3-codex-adapter-sets-capabilityfalse-and-does-not-project-estimates)
rejects an `input_tokens` proxy and explicitly leaves room to reconsider settled
upstream telemetry; it does not rule out reconsidering this native snapshot meter.
In this capture, the upstream estimate is the single 16,444-token compaction
checkpoint; the next ordinary response returns to a provider-backed snapshot.
This research changes neither the adapter nor the accepted ADR.

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

## Specification recommendation and operator decision

Retain false until the unestablished paths below are qualified and the operator
decides whether to adopt the meter. This is a recommendation based on incomplete
coverage, not a restriction imposed by D3. Its rejected proposal substituted
`turn.completed.usage.input_tokens` for context; the new evidence identifies
`last.totalTokens` and a native window, matching the upstream-telemetry direction
D3 expressly leaves open. A compaction decrease is expected for context occupancy
and should not itself be used to reject this snapshot.

The operator's question is: **adopt the app-server native context meter, or do
not adopt it?**

| Choice | Result and follow-up |
| --- | --- |
| Adopt | Proceed to qualify the five gaps below and design the app-server meter. It would make native context snapshots available when qualified, with explicitly unavailable intervals. Record the contract in an ADR addendum and review the design before implementation; this choice does not immediately enable the capability. |
| Do not adopt | Keep `supports_context_usage: false` and omit `ext.context`. Close this research without implementing the meter or running the additional qualification probes. No ADR addendum is needed to preserve the current behavior. |

D3 leaves room for this adoption question, while its current capability remains
false. The recommendation favors retaining false while qualification is
incomplete; it does not decide the operator's choice or rule out later adoption.
Automatic-compaction and reasoning probes remain deferred until that choice is
made.

If adopted, the candidate snapshot formula is:

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

### Compaction-boundary candidate and Claude precedent

One candidate is to invalidate the previous reading when a compaction boundary
is identified, display unknown through that boundary, and restore the meter only
when a qualifying ordinary-response snapshot for the current thread, model and
generation arrives. Under this candidate the estimated 16,444-token checkpoint
is not displayed. A missing post-compaction resume snapshot also leaves the
meter unknown. The boundary detector and freshness criteria are not established
by this single explicit-compaction capture; a zero input/output breakdown alone
has not been qualified as a general boundary detector.

The inspected Claude implementation at `ea567492d43a12bc8f68d9c215db27ecc92984d5`
provides a precedent for this invalidation pattern:

- [`#contextEpochGate`](https://github.com/sakuraiyuta/kaoiro/blob/ea567492d43a12bc8f68d9c215db27ecc92984d5/wrapper/claude-code/src/host.ts#L968)
  records that a reading immediately after a boundary can still describe the
  previous epoch.
- [`#invalidateContextEpoch`](https://github.com/sakuraiyuta/kaoiro/blob/ea567492d43a12bc8f68d9c215db27ecc92984d5/wrapper/claude-code/src/host.ts#L4036)
  increments the generation, sets the cached context to null, and emits the
  current state when a reading had existed before requesting another refresh.
- [`#settleContextEpoch`](https://github.com/sakuraiyuta/kaoiro/blob/ea567492d43a12bc8f68d9c215db27ecc92984d5/wrapper/claude-code/src/host.ts#L4233)
  uses boundary metadata or a bounded three-reading allowance. That allowance
  is a liveness rule, not proof that every accepted reading is fresh. These
  SDK-specific criteria are not validated for Codex and must not be copied as
  a Codex freshness guarantee. This comparison is code inspection, not a new
  Claude SDK or dashboard measurement.

### Unestablished adoption prerequisites

| Prerequisite | Established by this capture | Still unestablished |
| --- | --- | --- |
| Compaction boundary handling | One completed explicit compaction produced a nonzero estimated last total with a zero input/output breakdown. | Which notifications identify and order each boundary; invalidation, suppression of its estimate, and qualification of the later reading. The unknown-until-qualified policy above is a candidate. |
| Resume immediately after compaction | One wrapper history read emitted no usage before the next turn; the TUI context row was not observed within 35 seconds. | How availability is restored consistently, including repeated resumes and rejection of earlier-generation replays. No carry-over of another model's or generation's window is justified. |
| Model switching | All ten usage notifications used the same 258,400-token window. | Invalidation of counts and window on a switch, model/generation association of subsequent events, and rejection of stale or in-flight snapshots. No model switch was measured. |
| Automatic compaction | The measured operation was one explicit `thread/compact/start`. | Automatic compaction's notification shape, ordering, checkpoint values and recovery behavior. No additional automatic-compaction measurement has been run. |
| Reasoning output | The captured turns had zero reasoning-output usage. | Whether native last totals include nonzero reasoning usage as needed by the meter, and parity with the TUI on that path. No additional reasoning measurement has been run. |

No ADR-0040 addendum is needed to retain false. Adoption would require an
addendum replacing the app-server portion of D3's current unsupported decision,
defining native snapshot semantics, the raw percentage, boundary and unknown
states, and resume/model-generation behavior. The exec backend stays false.
Whether to publish or suppress an estimated checkpoint is part of that contract,
not a blanket prohibition already present in D3. Record the new telemetry and the
context-occupancy meaning of compaction decreases in the addendum rather than
rewriting the historical decision.

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
  again with exit 0. No subsequent capture mutation was performed.
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
