---
title: "Codex app-server events and telemetry"
status: implemented
last_updated: 2026-10-02
---

# Codex app-server events and telemetry

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [projection evidence](../../evidence/codex-app-server/projection-and-history.md)
and [rate-limit refresh evidence](../../evidence/codex-app-server/rate-limit-refresh-2026-10-02.md).

`startProjectedTurn` returns the same independent identities and one projection
iterator owning the raw notification stream. Known items reuse the exec adapter
for progress and bounded log payloads; file-change starts and textual function
outputs have explicit app-server mappings. Unknown item kinds are ignored.
Plan snapshots use `normalizeTasklist`. Started/completed item ids are deduplicated
within a turn; unrelated thread/turn notifications cannot affect its projection.
Deltas affect progress only, while completed assistant messages each yield a
transcript row. Two final answers therefore remain two rows, including when the
terminal contains only a summary of the last one.

A `userMessage` item start that carries a `clientId` (a steered input) yields a
content-free `input_item` projection, which the runtime routes to the host's
steer records rather than to progress or the transcript.

Only `turn/completed` produces a terminal result. Its status retains the
completed/failed/interrupted distinction; retry notifications alone do not end
a turn, and EOF without a terminal throws. Result text uses the last
`final_answer`, falling back to the last unphased message only when no final
answer exists. Text and error details use the existing shared bounds;
Host relay goes through `makeResult`.

The internal Host backend consumes this projection; normal launch defaults to exec.

Turn projection retains native `last` and `total` token counts plus the nullable
model context window. Usage notifications yield detached snapshots, and the
projected turn's `usage` getter retains the latest valid snapshot after terminal
completion. Unsupported/malformed usage does not replace that internal getter.

Peer-facing context has a separate Host-owned publication rule: a valid native
`last.totalTokens` and positive `modelContextWindow` become `used_tokens` and
`max_tokens`, with `used_percentage = 100 * (used_tokens / max_tokens)`. A native
value above the reported window is retained without wire clamping. Publication
requires a completed response item after the last compaction boundary, a named
owned turn, positive input breakdown, and successful settings commit. Replays,
estimates and unrelated/late events cannot publish. Missing/invalid windows and
malformed current-owned readings retract context; windows are never inferred or
reused from an earlier event. Compaction start, accepted model changes and
session close invalidate immediately. Unknown omits `ext.context` while retaining
`supports_context_usage: true`. Exec remains unsupported. The complete contract
is in [ADR-0040](../../adr/0040-context-usage-capability.md#addendum-2026-10-03--app-server-context-snapshots).

`AppServerTransport` receives `account/rateLimits/updated` independently of any
active turn. `AppServerSession` reads account limits once after opening or
resuming a thread. The host treats that read as native: if it arrives before
the separate fresh-idle probe finishes, the probe cannot replace it. If it
arrives later, the native read replaces the startup snapshot.
RPC errors, including unauthenticated reads, yield `readStatus=unavailable`
without erasing notification evidence. Connection failures remain errors.
Read responses cannot overwrite notifications received during that read or a
newer read's result. Snapshots distinguish each `limitId`, including an anonymous
null id, and each supported window; the keyed multi-bucket read is authoritative
when present. Credits, plan, account identity, and opaque backend data are not
retained. Numeric window conversion is shared with the exec rollout reader,
whose finite-value conversion and existing routing remain unchanged.

Accepted `account/rateLimits/updated` notifications also forward the detached
telemetry snapshot from `AppServerTransport` through `AppServerSession` and
`AppServerHostRuntime` to `CodexHost`, independently of an active turn. The
host projects only the `limitId=codex` bucket and suppresses unchanged values.
Each accepted notification replaces its complete bucket; supported windows are
not merged with older values. The runtime drops notification callbacks after
close.

Rate limits are the last values reported by the app-server. No idle refresh is
scheduled, so an expired window can remain visible until a later notification,
thread open, or resume supplies a newer snapshot.

Compaction projection emits `started` for a `contextCompaction` item and
`completed` only after the matching item completion and successful turn terminal.
Failed/interrupted turns and incomplete pairs do not report compaction success.
Duplicate item notifications are suppressed. `thread/compacted` is treated as
a redundant companion, not a requirement or a substitute for missing item
evidence.
