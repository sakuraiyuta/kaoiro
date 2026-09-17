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
API. MCP/configuration parity, attachments, result projection, compaction,
history restoration, and host/IA lifecycle integration remain later stages.

Tests cover protocol faults, request correlation, pre-response notifications,
consumer abandonment, buffered termination, and process shutdown. The real CLI
integration test uses the default constructor and an isolated Codex home with
a local Responses provider. It needs neither external model access nor auth,
but inherits CLI startup traffic and therefore does not assume fast offline
startup. Network namespaces are not required by the test.
