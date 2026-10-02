---
title: "Codex app-server context meter implementation verification"
status: pending-implementation-review
last_updated: 2026-10-03
---

# Codex app-server context meter implementation verification

The [approved plan](../../plans/issue-485-context-meter-addendum.md) implements
[ADR-0040's app-server addendum](../../adr/0040-context-usage-capability.md#addendum-2026-10-03--app-server-context-snapshots).
The implementation branch starts at develop `d68a0165`. Source commit is
`ed421f40b3845d4ef426290dca7a17cd6dd8484d`. [The JSON manifest](context-meter-implementation-2026-10-03.json)
binds source bytes, built runtime assets and local evidence files by SHA-256.
Documentation-only commits after this code commit do not change those sources.

The Host publishes native `last.totalTokens` / `modelContextWindow` only after
the owned response qualifies and settings commit succeeds. Typed facts pass
through transport, session and runtime; raw compaction invalidates even while
idle. Accepted model switches, malformed/missing-window owned usage, close and
watchdog retirement withdraw the reading. Exec remains explicitly unsupported.
The server replaces the extension without context; directory projection and the
same mounted dashboard detail lose the meter. Dashboard fatigue follows the
existing 60% rule; existing labels and bars clamp at 100 while wire values and
raw counts are preserved.

## Package checks

| Package/check | Exit | Passed |
| --- | --- | --- |
| core | 0 | 366 |
| agent-common | 0 | 516 |
| codex | 0 | 1336 |
| runner | 0 | 947 |
| dashboard | 0 | 1078 |
| server | 0 | 1826 |

All listed typechecks and dashboard check exited 0; dashboard check reported
zero errors and warnings. Server `mix precommit` includes compilation with
warnings as errors, unused dependency unlock, format and full tests; its final
result was 1,826 passed and 1 excluded. Tests ran with `CODEX_HOME` unset and
packages separately. Runner initially lacked the Claude/Antigravity built
artifacts: its first test/typecheck failed; building both and runner resolved
those setup failures. No runner or other-engine source was changed.

## Production default composition and negative controls

The credentialed gate invokes the built `runCodexCli()` with no dependencies,
and uses the default Host/session/transport, pinned Codex 0.159.3 and the real
account against a local Phoenix wire fixture. Spawn/Host/RPC observers forward
calls and bytes unchanged; no native responses or factories are injected.
Account identity and login output are not copied into the evidence.

After committing source, the same invocation ran positive → publication callback
cut/rebuild → restoration/rebuild/positive, with exits **0 → 1 → 0**. The negative
fails its `missing outward context after successful real response` assertion.
The final snapshot was 23,888 / 258,400 tokens, 9.2446% of the native reported window; capability stayed true while explicit
compaction withdrew context, and its estimate did not restore the meter. Every
held native child was awaited through close in all three invocations. Signal
mutation and process discovery were not used.

Twenty-five deterministic controls all exit 1 at assertions: atomic total,
reasoning double-count, wire clamping, invalid-window withdrawal, boundary
withdrawal/emission/order/deduplication, estimates, response completion/item
identity, settings commit, unknown/model/token/thread/native-turn ownership,
model setter/rejection, watchdog close, session callback, runtime close, stale
RPC and transport retirement. The transport's redundant entrypoint checks are
cut together for stale RPC/retirement. An earlier isolated closing-only cut
survived because failure already retired that child. The finite-percentage check
is mathematically redundant with valid safe counts/window and is not separately
pinned. An early thread-owner cut exposed a test gap; the final test also rejects
a mismatched terminal commit of a valid candidate and the cut fails.

The plan's revised evidence order predicate found 15/15 ordinary snapshots with
a completed response item after the latest boundary and before usage. Changing
the automatic response completion to a start makes that same checker fail.

## Limits and retained artifacts

The new live publication gate covers ordinary response and explicit compaction.
Automatic compaction, immediate resume, model switch and nonzero reasoning use
the frozen [qualification captures](context-usage-qualification-2026-10-03.md)
and deterministic publication/wiring tests. Null and distinct windows are
controlled tests, not new live observations. Capability remains true through
unknown intervals; idle resume replays deliberately do not restore readings.

Keep `worktrees/fuji-485/tmp/fuji-485-capture/` and
`worktrees/fuji-485-impl/tmp/fuji-485-implementation/` until issue close.
The old research branch is frozen, and the new implementation worktree is
retained for independent implementation review. Mutable mutation copies were
restored; temporary order-control copies were deleted. Production deployment
and merge remain with the director/operator.
