---
title: "Codex app-server transport"
status: implemented
last_updated: 2026-09-23
---

# Codex app-server transport

Current implementation contracts, extracted from the package README. The
[backend architecture](../../architecture/codex-backends.md) links the neighboring contracts;
[ADR-0058](../../adr/0058-codex-app-server-turn-steer.md) retains the decisions and staged authorization.
Measured coverage and limits are in the [evidence record](../../evidence/codex-app-server/stage1-compatibility.md).

`AppServerRpc` resolves the native executable from the installed, pinned Codex
package. One continuous JSONL reader routes responses and notifications,
retaining split UTF-8 and a final unterminated frame. Child exit does not end
routing before stdout drains. Events arriving before a start response are
retained until its turn id is known; unrelated thread/turn notifications do
not enter that turn's stream. A completed stream drains its buffered terminal
before ending, even if the process subsequently exits.

EOF and request timeout fail pending operations and close the child. A submitted
request that loses its response has an unknown outcome; the transport does not
retry or replace the process automatically. Graceful shutdown (`shutdownTimeoutMs`)
defaults to five seconds before killing only the owned child; `CodexHost` overrides
this to 2000ms (issue #391) so the child's own SIGKILL escalation stays below the
runner's reset grace — see
[adapter-contract.md](adapter-contract.md#sigterm-handling-and-process-termination-timing).
RPC waits default to 25 seconds.
Stopping iteration detaches the consumer, not the running turn: admission stays
closed until its terminal event. The internal Host backend wires token-fenced
interrupt and immediate shutdown; the CLI composition is exercised below.

Approval policy is pinned to `never`, reviewer to `user`, analytics disabled,
and `experimentalApi` false. Unexpected server requests receive an explicit
JSON-RPC rejection and an optional diagnostic without their payload. The
`stderrTail` accessor retains up to 16,384 characters for diagnostics; callers
must redact it before logging. There is no steer or external-message submission
API. IA continues through the existing coordinator and queue, without steering.
