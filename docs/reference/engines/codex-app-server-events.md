---
title: "Codex app-server events and telemetry"
status: implemented
last_updated: 2026-09-26
---

# Codex app-server events and telemetry

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [evidence record](../../evidence/codex-app-server/projection-and-history.md).

`startProjectedTurn` returns the same independent identities and one projection
iterator owning the raw notification stream. Known items reuse the exec adapter
for progress and bounded log payloads; file-change starts and textual function
outputs have explicit app-server mappings. Unknown item kinds are ignored.
Plan snapshots use `normalizeTasklist`. Started/completed item ids are deduplicated
within a turn; unrelated thread/turn notifications cannot affect its projection.
Deltas affect progress only, while completed assistant messages each yield a
transcript row. Two final answers therefore remain two rows, including when the
terminal contains only a summary of the last one.

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
completion. No percentage or peer-facing context payload is inferred from those
counts. Unsupported/malformed usage does not replace the last known value.

`AppServerTransport` receives `account/rateLimits/updated` independently of any
active turn. `AppServerSession` reads account limits once during start/resume;
the host consumes that post-thread snapshot after its separate fresh-idle
account probe, when both exist. The later native snapshot takes precedence.
RPC errors, including unauthenticated reads, yield `readStatus=unavailable`
without erasing notification evidence. Connection failures remain errors.
Read responses cannot overwrite notifications received during that read or a
newer read's result. Snapshots distinguish each `limitId`, including an anonymous
null id, and each supported window; the keyed multi-bucket read is authoritative
when present. Credits, plan, account identity, and opaque backend data are not
retained. Numeric window conversion is shared with the exec rollout reader,
whose finite-value conversion and existing routing remain unchanged.

Compaction projection emits `started` for a `contextCompaction` item and
`completed` only after the matching item completion and successful turn terminal.
Failed/interrupted turns and incomplete pairs do not report compaction success.
Duplicate item notifications are suppressed. `thread/compacted` is treated as
a redundant companion, not a requirement or a substitute for missing item
evidence.
