---
title: "Codex app-server context-meter qualification"
status: measured
last_updated: 2026-10-03
---

# Codex app-server context-meter qualification

The operator [chose Adopt](https://github.com/sakuraiyuta/kaoiro/issues/485#issuecomment-5954688714)
after the [initial research](context-usage-2026-10-02.md). This follow-up measures
its five missing paths and supplies the evidence for the
[proposed ADR-0040 addendum](../../plans/issue-485-context-meter-addendum.md).
It changes no executable code and does not enable the capability.

## Composition and limits

All captures use production `runCodexCli()` and its default `CodexHost`,
`AppServerSession`, transport and native process. No CLI dependency, host factory
or session factory was injected. A local Phoenix endpoint supplies connection
and persona data only. Observers forward spawn arguments, RPC requests/returns
and native stdout chunks unchanged. The native account is real, authenticated
ChatGPT; no account identifier or credential is transcribed.

The source remains `ea567492d43a12bc8f68d9c215db27ecc92984d5`, on research branch
`issue-485-codex-context-meter`. The pinned binary reports `codex-cli 0.159.3`,
SHA-256 `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The shell's inherited `CODEX_HOME` was an unauthenticated tool directory; the
successful captures explicitly use the same authenticated Codex home as the
initial research. Its recorded configuration contains no context-window or
automatic-compaction-limit override, and the capture configuration adds none.
Ordinary turns use `gpt-6.1-sol`, effort `low`; the reasoning probe uses the
public `setEffort("high")`, and the switch probe uses `setModel("gpt-6-sol")`.

The follow-up covers four threads, fifteen ordinary turns, three compactions,
nineteen native usage notifications and four successful TUI context comparisons.
The compaction estimates are exactly the three zero-breakdown checkpoints below;
subsequent ordinary snapshots are provider-backed. The date is Asia/Tokyo;
individual events retain UTC timestamps.

## Compaction boundaries and immediate resume

| Capture | Snapshot before boundary | Boundary estimate | Next ordinary snapshot | Native reported window |
| --- | ---: | ---: | ---: | ---: |
| Explicit compaction, with subsequent TUI comparison | 23,881 | 5,699 | 23,843 | 258,400 |
| Explicit compaction, no TUI between wrapper close/resumes | 23,881 | 5,667 | 23,802 | 258,400 |
| Automatic compaction on turn 7 | 272,534 | 69,748 | 136,486, within the same turn | 258,400 |

Each native boundary has this order:

1. `item/started` with `type: "contextCompaction"`.
2. `thread/tokenUsage/updated` with a nonzero `last.totalTokens`, but zero
   input, output and reasoning breakdown.
3. `item/completed` for the same compaction item.
4. `turn/completed` with status `completed`.

The automatic path inserts a provider-backed snapshot after item completion and
before the turn terminal: `136479 + 7 = 136486`. The existing projection reports
compaction completion only at the successful turn terminal. A meter requiring
the raw boundary order must observe thread-level item notifications, rather than
infer boundary completion from the current projection's delayed event.

In the direct lifecycle capture, the next wrapper launch resumes the compacted
thread with no intervening TUI writer or model turn. Two consecutive resumes
complete their default history reads and each emit zero usage notifications.
The following normal turn reports `23793 + 9 = 23802`. The first resume RPC is
approximately 47 seconds after the prior wrapper's recorded child closure;
this establishes the next operation after compaction, not a millisecond timing
guarantee. Another resumed explicit-compaction thread behaves the same way.

After automatic compaction, a resume also emits no usage, although the original
turn emitted its ordinary 136,486-token snapshot before closing. The next
ordinary response after resume reports `136504 + 7 = 136511`; `/status` then
shows `49% left (137K used / 258K)`. The immediate post-compaction TUI reads do
not show a context row within 35 seconds. Consequently resume replay is optional
telemetry, not an availability guarantee or a safe way to restore a cached
reading from another generation.

## Automatic compaction and an out-of-window snapshot

The default composition receives seven bounded turns of inert synthetic text,
with short responses, without tools/subagents or a forced compaction threshold.
The first six last totals are 65,294; 106,742; 148,190; 189,638; 231,086; and
272,534. Turn 7 automatically compacts and recovers as described above. Cumulative
usage remains 1,013,484 at its estimate and rises to 1,149,970 at the next normal
snapshot; it still measures accumulated request usage rather than occupancy.

The sixth response is accepted by the native process even though
`272534 / 258400` is **105.4698% of the upstream-reported window**. This reported
window is not proof of the provider's hard admission limit or the automatic
compaction trigger. A meter must neither invent a larger window nor silently
replace the raw count. The proposed addendum preserves the finite raw ratio,
including values above 100; existing dashboard bars remain visually clamped.
No TUI context comparison was captured at that particular overshoot checkpoint.

## Model switch and reasoning

The model-switch capture first resumes the reasoning thread, replaying the
preceding 24,218-token reading under its preceding turn ID. A new ordinary turn
reports 24,240. The public setter requests `gpt-6-sol`; the next native
`turn/start` explicitly carries that model and succeeds with `28435 + 6 = 28441`.
The native TUI then shows `93% left (28.4K used / 258K)`.

All these notifications report the same 258,400-token window and contain no
model name. A matching window therefore cannot qualify a reading after a model
change. The host must bind a reading to its own dispatch's model/generation and
turn identity. This capture establishes a successful switch, not a live switch
between different reported window sizes. A resumed notification cannot by
itself establish which model generated its prior snapshot.

The high-effort response reports:

```text
last.inputTokens           = 23955
last.outputTokens          = 263
last.reasoningOutputTokens = 252
last.totalTokens           = 24218
```

Reasoning is included in output and therefore in `last.totalTokens`:
`23955 + 263 = 24218`. Adding 252 again double-counts it. `/status` displays
`95% left (24.2K used / 258K)`. The mathematical answer is not part of the
measurement claim; the evidence is the native nonzero usage breakdown.

Inspection of the retained events also found a completed `agentMessage` or
`reasoning` item before each of the fifteen ordinary usage snapshots, within
the same native turn. This supports the proposed response-item qualification
on this sample, not an invariant of every future release.

All four available TUI raw fractions agree within their display rounding. Their
remaining percentages use the pinned release's 12,000-token baseline, as in
the initial research, rather than the proposed raw occupancy denominator.
Current [app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes the item lifecycle, and current
[reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning)
describes reasoning as output. These documents orient the probes; the pinned
binary's captures, not current documentation, establish these release-specific
observations.

## Availability policy supported by the measurements

The proposed meter uses the atomic native `last.totalTokens` and
`modelContextWindow`, never cumulative usage or a reconstructed input/output
sum. It clears the reading at compaction start, on an accepted model change,
on a new session/thread generation and on disconnect/close. It suppresses
boundary estimates and replayed usage, and restores only after a successful
owned turn supplies a qualified ordinary-response snapshot in the current
generation. A null/missing window remains unknown; no window is inferred.

There was no live null window. The initial research's nine controlled parser/
projection cases remain unchanged; they establish nullable input handling only.
The Claude source precedent is narrower than this proposed freshness policy:
Claude invalidates at the boundary, but assigns the next successful reading to
its display unconditionally. Its settling gate controls threshold notices,
not restoration of the displayed reading. Codex's stricter qualification must
stand on the native events measured here, rather than be attributed to Claude.

## Verification, retention and remaining limits

[Machine-readable evidence](context-usage-qualification-2026-10-03.json) contains
every captured usage snapshot, ordering indices, the operator decision, process
exit codes and content bindings. Raw captures remain under
`/home/yuta/git/kaoiro/worktrees/fuji-485/tmp/fuji-485-capture/qualification-2026-10-03/`
until issue #485 closes. The new manifest SHA-256 is
`1701c30bec357261de06e3c65d7807fca3b13a0c1d72938f31cbcb32fee1954e`;
it binds 75 capture/script files and 114 built runtime assets plus the native
binary. All 57 original capture files and seven original runtime bindings still
match the preceding manifest. No source or built runtime asset was changed.

- The actual capture checker exits 0: 15 ordinary turns, 3 compactions,
  19 usage notifications and 4 TUI comparisons. It checks native raw-capture
  equality, boundary order, recovery, nonzero reasoning, model request wiring,
  missing resume telemetry and content hashes.
- Removing exactly one native compaction-start notification from a disposable
  capture makes the same checker exit 1 with
  `missing or duplicate native compaction start`. The unchanged original then
  exits 0. The disposable copy is removed; later capture mutations are zero.
- Twelve captures exit 0. Three initial resume captures exit 1 with
  `already has an active writer` after TUI reads. They are retained and excluded
  from successful measurements. No forced takeover or host-wide process search
  was used. Native writer lifetime/lease behavior is unmeasured.
- Selected events contain no forbidden account-identity field or email
  identifier. Public SSH git remote strings are classified separately. All
  separately recorded owned PIDs are absent, and dedicated tmux socket
  directories are gone. The existing TUI helper does not print held PIDs when
  no context row appears; no separate PID-absence claim is made for those exits.
- No full regression suite is claimed for this research/doc-only change. The
  future source guards and consumer wiring are still unimplemented and require
  their own mutation checks and default-composition test after design approval.

Remaining coverage limits are other releases/providers/accounts, images and
tool-heavy responses, live null windows and live changes between different
window sizes. The measurements qualify the five requested paths on this pinned
composition; they do not establish an exact count of the next provider request.

The revised order check confirms all 15 ordinary snapshots follow a completed
`agentMessage` or `reasoning` item after the last compaction boundary in the same
turn; replacing the automatic turn completion with a start makes that check fail.
