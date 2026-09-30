---
title: "Codex app-server session and bridge"
status: implemented
last_updated: 2026-09-26
---

# Codex app-server session and bridge

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [evidence record](../../evidence/codex-app-server/session-and-bridge.md).

`AppServerSession` composes the transport with the existing `ToolHost` and
`dist/bridge.js`. It binds one thread per lifetime, using either start or
resume, and supplies the same thread configuration in both cases. Developer
instructions are a thread field; user text and local images use an ordered,
closed input converter. Other input kinds, including external messages, are
rejected. Relative image paths are rejected before turn admission or RPC,
avoiding ambiguity between the child process and thread working directories.
Caller-owned image files are neither copied nor removed by the session. The Host
supplies materialized absolute image paths and removes its turn directory after completion.
The Host serializes its startup orphan sweep with image materialization through
directory registration, including when an instruction arrives before `run`.
The sweep's duration can grow with the number of matching entries under `/tmp`.
Both backends preserve the materialized image until its turn consumes it.
Before the main app-server session starts, the Host aborts and awaits any
in-flight account probe. This prevents two app-server children of one Host
from initializing the same empty `CODEX_HOME` concurrently. It does not
coordinate separate wrappers. Instead the transport retries `initialize`:
a child that exits before any reply with `failed to initialize sqlite state
runtime` on its stderr is respawned, up to 3 attempts in total, after a
uniform 100 to 400 ms wait and then a uniform 400 to 1600 ms wait. The stderr is
read only after the failed child has closed. A JSON-RPC error reply, a
timed-out request, a transport that is closing, and a failure after
`initialize` succeeded are never retried, so at most one attempt can run to the
25 s request timeout: the worst case is about 29 s for the main session and
about 32 s for the startup probe. The signature covers sqlite initialization
failures in general, so a permanent one is retried too and then reaches the
caller with the attempt count and the signature line. Each retry writes one
redacted line to stderr and to the `onDiagnostic` option. Measurements are in
the [evidence note](../../evidence/codex-app-server/initialize-sqlite-race-2026-09-30.md);
deployment ordering for large migrations is in the
[backend runbook](../../operations/codex-backend-switch.md). Production keeps
its state in a dedicated `CODEX_HOME`, so the global CLI is not a source of the
collision ([Codex home for production](../../operations/codex-home.md)).
The probe opens no thread or bridge grandchild, so its pipes close with its
child; the transport escalates an EOF-ignoring child to SIGKILL after five
seconds, bounding the main session's startup wait to that shutdown interval.

Both exec and app-server use `BRIDGE_MCP_POLICY`: `required = true`,
`startup_timeout_sec = 30`, `default_tools_approval_mode = "approve"`, and a
310-second tool timeout. This changes normal launch behavior: a bridge startup
failure now fails the turn through the existing operator-visible result/error
path, instead of continuing silently without kaoiro tools. The pinned CLI
otherwise omits pending optional MCP servers after a one-second grace. See
[ADR-0058 Appendix C](../../evidence/codex-app-server/session-and-bridge.md#ci-follow-up-required-bridge-startup)
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
before waiting for the child. The Host supplies its active turn scope; interrupt,
terminal and shutdown abort that signal. Coordinator/lease composition is
covered by the CLI tests below.

## Input-bound inter-agent replies

See [the reply-basis contract](../inter-agent/reply-basis.md) for negotiated protection, native tool origin binding, inline recovery, and the staged rollout boundary.
