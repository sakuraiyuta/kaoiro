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
API. Telemetry, compaction, history restoration, and host/IA lifecycle
integration remain later stages.

`AppServerSession` composes the transport with the existing `ToolHost` and
`dist/bridge.js`. It binds one thread per lifetime, using either start or
resume, and supplies the same thread configuration in both cases. Developer
instructions are a thread field; user text and local images use an ordered,
closed input converter. Other input kinds, including external messages, are
rejected. Relative image paths are rejected before turn admission or RPC,
avoiding ambiguity between the child process and thread working directories.
Caller-owned image files are neither copied nor removed. Host/launch
integration must supply materialized absolute image paths.

The bridge retains exec's `default_tools_approval_mode = "approve"` and
310-second tool timeout. `features.multi_agent` is always explicit and defaults
to true, matching `CodexHost`; false disables internal subagents. No descriptors
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
startup. Network namespaces are not required by the test.
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
