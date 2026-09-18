# Codex wrapper internals

The public engine still uses `CodexHost` and `codex exec`. The app-server
modules are internal groundwork for [ADR-0058](../../docs/adr/0058-codex-app-server-turn-steer.md);
they are not exported from the package entry point or selectable at launch.

`AppServerTransport` owns one native child for its lifetime. `startThread` and
`resumeThread` initialize that child once; `startTurn` returns independent
thread, turn, host-token, request, and client-message identities plus a
single-consumer notification stream. Thread setup and turn admission reject
overlapping operations. Another turn is allowed after the terminal notification,
including when an earlier consumer still has buffered events to read.

`AppServerRpc` resolves the native executable from the installed, pinned Codex
package. One continuous JSONL reader routes responses and notifications,
retaining split UTF-8 and a final unterminated frame. Child exit does not end
routing before stdout drains. Events arriving before a start response are
retained until its turn id is known; unrelated thread/turn notifications do
not enter that turn's stream. A completed stream drains its buffered terminal
before ending, even if the process subsequently exits.

EOF and request timeout fail pending operations and close the child. A submitted
request that loses its response has an unknown outcome; the transport does not
retry or replace the process automatically. Graceful shutdown is bounded at five
seconds before killing only the owned child. RPC waits default to 25 seconds.
Stopping iteration detaches the consumer, not the running turn: admission stays
closed until its terminal event. Host watchdog/interrupt integration is a later
stage.

Approval policy is pinned to `never`, reviewer to `user`, analytics disabled,
and `experimentalApi` false. Unexpected server requests receive an explicit
JSON-RPC rejection and an optional diagnostic without their payload. The
`stderrTail` accessor retains up to 16,384 characters for diagnostics; callers
must redact it before logging. There is no steer or external-message submission
API. Host/IA lifecycle and wiring history into `HistoryReplayer` remain later stages.

`AppServerSession` composes the transport with the existing `ToolHost` and
`dist/bridge.js`. It binds one thread per lifetime, using either start or
resume, and supplies the same thread configuration in both cases. Developer
instructions are a thread field; user text and local images use an ordered,
closed input converter. Other input kinds, including external messages, are
rejected. Relative image paths are rejected before turn admission or RPC,
avoiding ambiguity between the child process and thread working directories.
Caller-owned image files are neither copied nor removed. Host/launch
integration must supply materialized absolute image paths.

Both exec and app-server use `BRIDGE_MCP_POLICY`: `required = true`,
`startup_timeout_sec = 30`, `default_tools_approval_mode = "approve"`, and a
310-second tool timeout. This changes normal launch behavior: a bridge startup
failure now fails the turn through the existing operator-visible result/error
path, instead of continuing silently without kaoiro tools. The pinned CLI
otherwise omits pending optional MCP servers after a one-second grace. See
[ADR-0058 Appendix C](../../docs/adr/0058-codex-app-server-turn-steer.md#ci-follow-up-required-bridge-startup)
for the source references and measurements.
App-server thread start/resume with a bridge has a 35-second RPC deadline to
receive the CLI's 30-second startup outcome. Other RPCs retain 25 seconds;
an explicit transport timeout still takes precedence. The session does not
send a turn before thread opening succeeds.

`features.multi_agent` is always explicit and defaults to true, matching `CodexHost`; false disables internal subagents. No descriptors
means the session adds no kaoiro MCP server configuration. Socket creation uses
`ToolHost.listen` unchanged, inside its fresh private directory. Session shutdown
and failed initial setup close the tool host and remove only that directory.
Shutdown stops new tool connections and aborts existing handlers synchronously
before waiting for the child. The caller supplies the active turn's abort signal;
connecting that callback to `CodexHost` and its coordinator/lease/queue is still
pending.

Tests cover protocol faults, request correlation, pre-response notifications,
consumer abandonment, buffered termination, and process shutdown. The real CLI
integration test uses the default constructor and an isolated Codex home with
a local Responses provider. It needs neither external model access nor auth,
but inherits CLI startup traffic and therefore does not assume fast offline
startup. Its isolated configuration disables analytics and plugins; external
plugin clones otherwise write into the temporary home and can outlive child
shutdown, racing cleanup. Other startup traffic, such as update checks, is
still possible. Network namespaces are not required by the test.
The session integration test also executes a real bridge handler, checks image
bytes and developer instructions at the provider, closes the child, then resumes
with a new bridge and repeats those checks. Its attachments come from the real
`materializeLocalImages` function. It verifies transport and tool execution
against a fixed local response, not external model reasoning.

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
answer exists. Text and error details use the existing shared bounds; eventual
host relay still goes through `makeResult`. The local-provider integration
test verifies two final answers, one result, and MCP call/result logs through
the real CLI on both start and resume. Failure/interruption, duplicate frames,
foreign identities, malformed items, and EOF projection use deterministic
fixtures. This API is internal and does not connect to `CodexHost` or launch.

Turn projection retains native `last` and `total` token counts plus the nullable
model context window. Usage notifications yield detached snapshots, and the
projected turn's `usage` getter retains the latest valid snapshot after terminal
completion. No percentage or peer-facing context payload is inferred from those
counts. Unsupported/malformed usage does not replace the last known value.

`AppServerTransport` receives `account/rateLimits/updated` independently of any
active turn. `AppServerSession` reads account limits once during start/resume;
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
evidence. The pinned 0.153.4 capture recorded zero such legacy notifications;
this is a statement about that capture, not a guarantee it can never appear.
The captured item pair is also replayed through the projector in a test.

Real-CLI tests cover usage, limit notifications, and the unauthenticated read
path. Successful account reads, multiple buckets, stale-read races, and invalid
telemetry use schema fixtures. The compaction trace used a local provider and
manual `thread/compact/start`; automatic model-triggered compaction and actual
account quotas have not been measured. Native path conversion rejects `~/x`
and accepts Windows absolute paths only when running on Windows.


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
The default-session CLI tests verify persisted resume, two final answers, MCP
output, IA exclusion, and the 200-row tail with a local provider. Legacy/full
views, malformed responses, cursor failures, and race conditions use schema
fixtures. This API is internal: `CodexHost` still uses exec, and the existing
synchronous `HistoryReplayer` is not yet connected to the asynchronous reader.

The internal session accepts per-turn model, effort, cwd, and sandbox/network
settings. Approval remains `never` with reviewer `user`. A synchronous
`onDispatch` callback runs after default resolution, immediately before
`turn/start`; throwing prevents submission. Its host token and client message
id remain separate from the eventual app-server turn id and RPC request id.
`interrupt(hostTurnToken)` targets only that active turn, defers until its start
response supplies an id, and skips an already buffered terminal. An interrupt
RPC acknowledgement does not release turn admission; the terminal still does.

`resetEffort` requires a target model and cannot accompany an explicit effort.
The pinned CLI retains thread effort on null/omission. The session instead reads
`config/read(cwd)` immediately before submission and uses its explicit effort,
or the target model's `model/list.defaultReasoningEffort`. An unavailable default
rejects with `default_effort_unavailable` before dispatch; the prior effort is
never silently retained. Configuration changes after this read do not change
the submitted value, whereas a newly spawned exec samples at process startup.
App-server does not support `--profile`; current Host/SDK/session launch does not
expose that option. Exec behavior is unchanged. Host switch-error reporting and
pending/rollback wiring remain subsequent increments; these APIs are internal.

The default-session control integration exercises live rollout visibility before
child shutdown, sequential policy changes, both effort resolution paths,
unresolvable defaults, interruption, and a following turn in the same session.
Pre-response interruption, dispatch rejection, catalog faults/cursor bounds,
and connection/close races have deterministic fixture coverage.

Permission/settings helpers are internal preparation for Host integration.
`beforeDispatch` waits for permission synchronization after default-effort
resolution; the synchronous `onDispatch` callback then validates the captured
selection and receives an immutable concrete model/effort receipt. A changed
selection or blocked gate raises `permission_superseded` before `turn/start`.
The Host integration must prepare the same unstarted queued turn again with a
new snapshot. Close/EOF releases a pending synchronization wait.

The permission attempt captures a separate execution id and a rollout boundary.
Only the first dispatch of a known newly started thread may use a fresh boundary:
`thread/start` can return before its rollout exists. A missing resume baseline is
not trusted. Completion requires matching thread, host token, current submission
(revision, requested axes, execution id), and the terminal's app-server turn id.
A newer pending selection does not invalidate the current execution. Missing or
contradictory evidence remains unknown; RPC acceptance never means applied.
Assessment, diagnostics and observation fields share the existing exec rules;
exec's rollout reader still permits omission of the expected turn id.

Initial settings come from the thread start/resume response. Explicit effort
survives compatible model changes. Only reset intent or a model change with
default intent resolves a new default. Successful reset uses the resolved
receipt, not the display catalog's default. Rollback explicitly resends the
previous successful model/effort; default intent resolves again. Unknown
baseline/default fails with `default_effort_unavailable`, without exposing raw
RPC errors. Host queue/lifecycle wiring and normal launch selection remain
pending; existing exec behavior is unchanged.
