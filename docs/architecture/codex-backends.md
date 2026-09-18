---
title: "Codex backends and ownership"
status: implemented
last_updated: 2026-09-18
---

# Codex backends and ownership

The staged transport decision is recorded in [ADR-0058](../adr/0058-codex-app-server-turn-steer.md).
The exec contract is documented in [Codex exec events](../reference/engines/codex-exec-events.md).
For app-server, read [transport](../reference/engines/codex-app-server.md),
[session and bridge](../reference/engines/codex-app-server-session.md),
[events and telemetry](../reference/engines/codex-app-server-events.md),
[settings and permission](../reference/engines/codex-app-server-settings.md) and
[display history](../reference/engines/codex-app-server-history.md).
Launch selection and rollback remain in the [package entry](../../wrapper/codex/README.md)
and [production runbook](../operations/production.md).
The [Host composition evidence](../evidence/codex-app-server/host-composition.md)
separates real-CLI coverage from deterministic fixtures.

`AppServerTransport` owns one native child for its lifetime. `startThread` and
`resumeThread` initialize that child once; `startTurn` returns independent
thread, turn, host-token, request, and client-message identities plus a
single-consumer notification stream. Thread setup and turn admission reject
overlapping operations. Another turn is allowed after the terminal notification,
including when an earlier consumer still has buffered events to read.

`AppServerHostRuntime` is an internal execution owner above `AppServerSession`;
`CodexHostOptions.backend = "app-server"` selects it explicitly. The CLI alone
translates the validated startup config into that option; constructing a Host
directly does not read config or environment hints.
It creates one session, opens or resumes once, and rejects overlapping calls.
The Host owns the existing serial queue.

Abnormal child disconnection propagates once through transport/session/runtime
to Host. Idle disconnection closes admission and reports error without inventing
a turn/result; active disconnection settles the existing turn once and retires
queued inputs. Intentional close does not report an abnormal disconnect. Neither
path creates a replacement child or falls back to exec.

`runCodexCli({ backend: "app-server" })` is an internal composition seam. The
ordinary entrypoint calls `runCodexCli()` with no arguments and selects from
`config.codex_backend ?? "exec"`. Only internal tests may override this with the
dependency object; environment and flags cannot select a backend.
The optional watchdog clock supplies only time and timer operations. Settings,
interrupt, fail-stop and lifecycle callbacks are the production implementation.

During fail-stop, the CLI explicitly retires
each cancelled, unstarted Host batch before forgetting its ownership. Coordinator
pending batches are retired at freeze; the SDK-active batch is not retired and
cannot produce a late result. Both exec and app-server exercise this ordering.

Host admission failure never creates another app-server child or selects exec.
The runner Supervisor has a separate existing policy: unexpected wrapper exit
can restart a **new wrapper lifetime**, within its restart budget, without
replaying the initial prompt. Deliberate stop does not restart.
