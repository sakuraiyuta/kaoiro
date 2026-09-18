---
title: "Codex app-server projection and history evidence"
status: recorded
last_updated: 2026-09-18
---

# Codex app-server projection and history evidence

Historical excerpts from [ADR-0058](../../adr/0058-codex-app-server-turn-steer.md). Each increment
retains its original scope and tense; “now”, “above” and “remaining” describe that
record, not a new claim of present implementation or release.

The artifact, binary/schema hashes, reference SDK and initial procedure cited as
“above” are in the [compatibility record](stage1-compatibility.md).

Scratch paths and hashes below identify the recorded experiments, not a promise
that temporary files remain available. Measurement dates are retained per record;
`last_updated` refers to the source text, not a new measurement.

### Increment (4a): result and progress projection

The internal `AppServerSession.startProjectedTurn` wraps one raw turn stream
with `app_server_projection.ts`. Thread/turn identity gates precede item
projection; started/completed item ids deduplicate within that turn. Known
assistant, reasoning, command, file-change, MCP and web-search items reuse
the exec adapter after closed shape conversion. File-change `inProgress`
has no exec SDK counterpart, so its start is projected explicitly rather
than cast into a completed SDK item. Textual `functionCallOutput` content has
an explicit display-only mapping; unsupported item kinds are not inferred.
Plan updates use the existing bounded `normalizeTasklist` implementation.

Completed assistant items each produce a log. `turn/completed.itemsView=summary`
does not overwrite those logs. Only the matching terminal notification yields
one result, retaining completed/failed/interrupted status. The last
`final_answer` supplies result text, or the last unphased message when no final
answer exists. EOF without a terminal is an error; a retry notification is
not itself terminal. Log and result bounds reuse agent-common, including the
error-detail boundary used by `makeResult`; envelope emission remains the
future host's responsibility.

External shape references are the same pinned stable schema artifact as the
compatibility gate above: `ItemStartedNotification`, `ItemCompletedNotification`
(`ThreadItem`), `TurnStartedNotification`, `TurnCompletedNotification` (`Turn`,
`TurnStatus`), `AgentMessageDeltaNotification`, reasoning/command output delta
notifications, `McpToolCallProgressNotification`, `TurnPlanUpdatedNotification`,
and `ErrorNotification`. The schema's deprecated `FileChangeOutputDeltaNotification`
also maps to tool progress; its schema explicitly says the server no longer
emits it, so coverage is fixture-only. Final-answer selection
also follows the recorded Python reference's `_run.py` phase fallback.

The default-session integration test now takes an attachment produced by
`materializeLocalImages` and verifies its exact PNG bytes at the local Responses
endpoint. Relative paths are rejected before RPC to avoid ambiguity between
the process and thread working directories. Session close
does not remove the caller-owned materialized image.

For both start and resume, the real 0.153.4 child executes the kaoiro MCP probe
and projects its call/result logs. The local provider then supplies two ordinary
assistant messages with `phase=final_answer` in one response: both completed
rows survive, and exactly one terminal result uses the second answer. This
requires neither steering nor external-message input. Malformed/duplicate
notifications, foreign identities, interruption/failure, and missing terminals
are tested with fixtures, not claimed as live model behavior.

Telemetry/compaction (4b) and history (4c) are separate review/landing units.
Normal launch, `CodexHost`, IA lifecycle, capabilities, protocol version, and
this ADR's status remain unchanged.

### Increment (4b): telemetry and compaction

`app_server_telemetry.ts` preserves native token counts (`last`, `total`, and
nullable `modelContextWindow`) without deriving a context percentage. The
projected turn retains its latest valid usage and emits detached snapshots.
Account notifications are routed before the transport's active-turn filter.
Start/resume performs one `account/rateLimits/read`; an RPC error means unknown
read availability, while independently observed notification buckets survive.
Connection failure is not converted to unknown. Newer reads and notifications
fence older read results. Buckets remain separate by `limitId`; credits, plan,
account identity, and opaque response fields are excluded. Only the numeric
window conversion is shared with `rollout.ts`, with exec routing and finite
out-of-range semantics pinned unchanged.

On the same pinned 0.153.4 binary (SHA-256
`56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da`),
an isolated, unauthenticated home and loopback provider captured:

- One `contextCompaction` item start and matching completion, followed by that
  compaction turn's successful `turn/completed`.
- Zero `thread/compacted` notifications **in this capture**. Projection therefore
  requires only the item pair and successful terminal; a legacy companion is
  ignored as duplicate evidence, not required for completion.
- Four `account/rateLimits/updated` notifications without thread/turn ids.
  Provider headers produced `limitId=codex`, primary `usedPercent=12` /
  `windowDurationMins=300`, and secondary `34` / `10080`.
- Both `resetsAt` fields were null in this capture. The probe's reset-header
  names were not established as valid; no CLI reset-time behavior is inferred.
- `account/rateLimits/read` before and after a turn returned `-32600`,
  `codex account authentication required to read rate limits`.

Capture drained both stdout (including an unterminated final line) and child
close before saving. Probe and checker exited 0. Removing exactly the
`contextCompaction` item completion from a copy of the trace made the same checker
exit 1 (`compaction pair missing`, 1 start / 0 completions); the unchanged
original trace still exited 0. The retained notification subset in
`wrapper/codex/test/fixtures/app_server_compaction.json` is replayed through the
production projector, rather than a handwritten compaction shape.

Evidence hashes:

| Artifact | SHA-256 |
| --- | --- |
| Full trace | `a7642eb8629fc5e3ee95f21242ebcb4163100f4ff292dc7c4ce69f9f0602dc8a` |
| Probe | `b2183de9b6eccfe4021f8540fa3c3b76eb49329d944d694768b0d7aae3ab2973` |
| Checker | `4aa6c6236a5675ecfb0a29f6973bf66091a36fc8de42377a533c165fd052d47c` |

The default-session real-CLI test additionally verifies usage and account
notifications across start/resume. Successful account reads and multiple
meters remain unmeasured against a real account: tests use the generated
`GetAccountRateLimitsResponse` / `RateLimitSnapshot` schema. Invalid values and
stale-read races are also fixture tests. Manual compaction used a controlled
local response; automatic compaction and external model/account behavior are
not claimed. History (4c), host/IA integration, launch selection, protocol,
capabilities, and ADR status remain outside this increment.


### Increment (4c): display history

`app_server_history.ts` acquires metadata with `thread/read(includeTurns=false)`
before choosing a source. The generated schema defaults absent `historyMode`
to legacy and absent `itemsView` to full. Only a legacy full-item snapshot is
accepted directly; paginated mode or any summary/notLoaded turn causes a
complete switch to `thread/items/list`. Earlier full/summary rows are not mixed
with pages. Descending pages are restored to chronological order, deduplicated
by `(threadId, turnId, item.id)`, and limited by the existing exec reader's
exported `MAX_HISTORY` of 200 **display rows**, after filtering. Repeated/cyclic
cursors, pages without new identities, and a separate 100-page bound stop reads.
The last bound handles abnormal but continually changing cursors independently
of the display cap.

The returned coverage distinguishes full history, a bounded tail, and an
incomplete read with a closed reason. RPC rejection does not become an empty
full result. Disconnect/timeout remains a connection error. Live and history
share item-to-log conversion; history constructs log envelopes only. It reuses
`isFormattedInterAgentMessage`, retains both final-answer rows, and uses the
provided clock because ThreadItem/ThreadItemEntry contain no timestamp. No turn
result, lifecycle transition, acknowledgement, or compaction event is replayed.
History and live turn admission are mutually exclusive; a turn submitted during
history acquisition is rejected immediately. Close/EOF releases request waiters.

The pinned 0.153.4 binary (path and SHA-256 recorded in Appendix C above) was
measured with an isolated unauthenticated home, analytics/plugins disabled, and
a loopback provider. Three turns were persisted, the child was closed, and a
new child resumed the thread with `experimentalApi=false`. Metadata reported
`historyMode=paginated` and no embedded turns. A separate diagnostic
`includeTurns=true` read returned all three turns with `itemsView=full`, but the
reader still follows the paginated source selected by metadata.

`thread/items/list(limit=2)` worked in both ascending and descending directions:
three pages each, non-null progressing cursors on the first two, null on the
third. Each direction contained exactly the six full-read items in the expected
order. Thus pagination is measured on this pin, not merely fixture coverage.
The capture checker compared complete item/turn identities with the full read
and verified child/stdout shutdown. Removing one page item made that checker
exit 1; the original capture exited 0.

| Artifact | SHA-256 |
| --- | --- |
| `ThreadReadParams.json` | `dfe040c6ac71d30795b8be3f3ff232e66f362a37f883b491e5d1ea367f470db4` |
| `ThreadReadResponse.json` | `a76583d07f6096fee33045da2dc9caed84d858f8f2d39b37bb38528dbaf32511` |
| `ThreadItemsListParams.json` | `ff56040c327ecdd30ef02affac9bc71fab64031e8980f2b4fea9fd8a888160b4` |
| `ThreadItemsListResponse.json` | `886369490fec07067597460301b3d5c1dc9aedc41ea42522cae397d8babe6156` |
| Full history trace | `f7143042002ff87532dcca5aa45e06ace33652a846f896c7e98a4f6b7af9d1d0` |
| Probe | `462abd953953bdd5d36a587c225f7db687d68bf43c3d376b6108e0e6a5fc7195` |
| Checker | `29f33f9418c7c88bc2b3580c82120520aee3fbc03b0398a14fad542cd854cd42` |

Schemas were generated into `stable/v2` from the same pinned executable;
reference types are the corresponding v2 definitions in the official
[app-server protocol](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2.rs).
The default-session integration tests additionally read persisted assistant and
MCP output after resume, exclude injected IA text, and retain the last 200 rows
from a 205-answer local response. Legacy defaults/full views, summary/notLoaded
fallback, unknown/malformed responses, cursor failure, page-budget exhaustion,
and read/turn/close races are fixture cases rather than claimed real CLI faults.

Host and `HistoryReplayer` wiring remains stage (5); the latter's synchronous
transcript callback is not silently replaced with an asynchronous reader here.
Normal launch, protocol, capabilities, and this ADR's status remain unchanged.


The (4c) review found that the live converter's empty output conflated corrupt
known items with intentionally ignored ones. History now decodes display,
ignored, and invalid items before either snapshot or page admission. Known
assistant/user messages, commands, file changes, MCP calls, web searches, and
function outputs validate their stable display fields, including nested text
and tool result/error shapes. Invalid items report `incomplete/invalid_response`;
unknown item kinds and normal hidden items remain forward-compatible. This is
a display-boundary check, not a full schema validator for unused extensions or
MCP's explicitly arbitrary JSON content. The live converter remains unchanged.
Tests cover each known family through both history sources, retention of prior
page logs on a later invalid item, and ignored-item pagination progress.

## Wrapper test coverage and limits

The following coverage notes were retained from the package README at migration
baseline `81570847`. They do not extend the dated measurements above.

The local-provider integration
test verifies two final answers, one result, and MCP call/result logs through
the real CLI on both start and resume. Failure/interruption, duplicate frames,
foreign identities, malformed items, and EOF projection use deterministic
fixtures.

The pinned 0.153.4 capture recorded zero such legacy notifications;
this is a statement about that capture, not a guarantee it can never appear.
The captured item pair is also replayed through the projector in a test.

Real-CLI tests cover usage, limit notifications, and the unauthenticated read
path. Successful account reads, multiple buckets, stale-read races, and invalid
telemetry use schema fixtures. The compaction trace used a local provider and
manual `thread/compact/start`; automatic model-triggered compaction and actual
account quotas have not been measured. Native path conversion rejects `~/x`
and accepts Windows absolute paths only when running on Windows.

The default-session CLI tests verify persisted resume, two final answers, MCP
output, IA exclusion, and the 200-row tail with a local provider. Legacy/full
views, malformed responses, cursor failures, and race conditions use schema
fixtures.
