---
title: "Codex app-server display history"
status: implemented
last_updated: 2026-09-18
---

# Codex app-server display history

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [evidence record](../../evidence/codex-app-server/projection-and-history.md).

`AppServerSession.readHistory(config, now)` reconstructs display logs for its
bound thread. It reads metadata first; only legacy turns with full item views
are accepted directly. Paginated history and summary/not-loaded views use
`thread/items/list` in descending order until the source ends or enough display
rows have been collected. Full-read and paged snapshots are never spliced.
Deduplication uses thread, turn, and item identity. Results return chronological
logs capped by the existing `history.ts` `MAX_HISTORY` (200 display rows).
Completed tools may contribute two rows; ignored items do not consume the cap.

Coverage is `full` when the source ends within the cap, `tail` when the display
limit omits older rows, and `incomplete` on an RPC rejection, malformed response,
cursor/identity non-progress, or the separate 100-page safety bound. The bound
stops abnormal changing cursors even if every page contains only hidden items.
Partial page logs remain explicitly incomplete; connection failure throws.
Known display items are decoded separately from ignored items: missing or
malformed required display data makes either history source incomplete with
`invalid_response`. Normal non-display items and future item kinds remain
ignored without reducing coverage. The decoder checks the stable display
boundary, not opaque/unused extension fields or arbitrary MCP content JSON.
Unknown items are not guessed into display events. IA framing uses the same
exclusion as exec history. Projection produces only log envelopes, using the
supplied `now()` because stable items have no timestamp; it does not replay
results, acknowledgements, lifecycle transitions, or compaction notices.

History reading excludes live turn submission, thread changes, and concurrent
history reads; conflicting operations reject immediately rather than queue.
Close/EOF rejects outstanding requests. Normal RPC deadlines still apply.

The internal app-server Host prepares successful snapshots before
passing them to the existing synchronous `HistoryReplayer`.

The history coordinator reads the constructed Host's backend. Exec retains
its synchronous rollout reader. App-server hydration occupies one replaceable Host job, after current
turn settlement and image cleanup but before the next queued turn. Resume can
read before its first turn; a fresh Host with no session id replays an empty
window without opening a thread. History does not require turn permission.

`full` and `tail` both publish the existing reset/log/IA/complete cycle. Complete
means restoration of the retained display window, not retrieval of the entire
transcript. `incomplete` emits one `history_unavailable` diagnostic without any
reset, entries, IA replay, or completion; turn admission stays open. A new modern
hydration `replay_id` retries once, while duplicate verdicts do not. Legacy
servers retain the single resume-startup attempt, including after incomplete
history. Child failure remains a connection failure and closes admission.

`ServerLink.captureHistoryReplayFence()` is read-only. The asynchronous result
must still belong to the joined, connected socket generation before publication;
obsolete results never enter Phoenix's disconnected push buffer. User logs
received during the read-to-publication window are retained separately, capped
by `MAX_HISTORY`, then sent after completion (or after incomplete diagnosis
without a reset). Console output and Host instruction admission continue. A
superseded read passes these rows to the replacement job. Instructions logged
before this window but not yet executed are not in the transcript and are not
restored by this buffer; solving that wider queued-instruction case is deferred.
