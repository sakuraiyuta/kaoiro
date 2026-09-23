---
title: Engine adapter contract
description: Exact common lifecycle, control, pending-state, and Tool-conversion contract implemented by concrete engine adapters.
status: accepted
last_updated: 2026-09-23
related: [extensions, protocol]
---

# Engine adapter contract

The structural source of truth is
[`EngineAdapter`](../../../wrapper/agent-common/src/engine.ts); this page defines
the adapter contract around that type.

## EngineAdapter interface

The `EngineAdapter` interface in the common AI-agent layer
`wrapper/agent-common` ([ADR-0032](../../adr/0032-codex-adapter.md) F1, F4bc, F9)
declares the contract concrete adapters must implement:

- State derivation: engine-specific event stream (Claude `SDKMessage` /
  Codex `ThreadEvent`) → common `AdapterEvent`
- Lifecycle and control: `run` / `send` / `interrupt` / `close` /
  `setModel` / `setEffort` / `setPermission` / `setPermissionMode`
- Pending-state projection: `setPendingPermission` / `setPendingQuestion`
  and revision-fenced `renameDisplayName`
- Convert the common Tool description layer (JSON Schema + handler pair) to
  engine-specific APIs (Claude: Zod + `createSdkMcpServer` in-process / Codex:
  `dynamicTools`)

## SIGTERM handling and process-termination timing

`runner` stop / delete / restart send a plain `SIGTERM` to the wrapper pid
with no runner-side escalation of their own (`runner/src/supervisor.ts`,
`runner/src/spawn.ts`); only `reset` escalates to `SIGKILL` after
`RESET_TERMINATION_GRACE_MS` (5000ms). Each wrapper CLI registers a
`SIGTERM` handler that calls `close()` directly — never `interrupt()` — the
same shape as [ADR-0057](../../adr/0057-antigravity-adapter.md) F2a
(Antigravity): `SIGTERM` is an external "stop now", not an operator action,
so it must not manufacture an `interrupted` settlement for a turn the
operator never asked to interrupt. `SIGINT` keeps
`interrupt().finally(close())` on all three wrappers. The handler is
registered once per CLI invocation and removed in `finally`, mirroring
[ADR-0057](../../adr/0057-antigravity-adapter.md) F2a's listener-accumulation
fix (a leaked listener across repeated invocations broke vitest teardown).

Per-engine timing (measured where noted; Linux unless stated otherwise):

| Layer | Bound | Source |
|---|---|---|
| runner `reset` escalation | SIGKILL 5000ms after SIGTERM | `RESET_TERMINATION_GRACE_MS`, `runner/src/supervisor.ts` |
| runner `stop`/`delete`/`restart` | bare SIGTERM, no escalation | `runner/src/supervisor.ts`, `runner/src/spawn.ts` |
| systemd service backstop | SIGKILL 30000ms after SIGTERM | `TimeoutStopSec`, service-level, not per-agent |
| Claude Code SDK child | SIGTERM ~2000ms, SIGKILL ~7000ms after `close()` | `ProcessTransport.close()`, `@anthropic-ai/claude-agent-sdk` 0.3.280's bundle (measured) |
| Codex exec child + its sandboxed grandchild | both gone ~50ms after SIGTERM | measured offline, `workspace-write` and `danger-full-access`, 2 runs each — issue #401 |
| Codex app-server child | SIGKILL 2000ms after stdin EOF if still alive | `shutdownTimeoutMs`, wired by `CodexHost` below `RESET_TERMINATION_GRACE_MS` |

Claude Code's SIGKILL bound (~7000ms) lands *outside* the runner reset
grace (5000ms): a child that ignores both stdin EOF and SIGTERM survives a
runner-initiated reset as an orphan. The SDK also tracks spawned children
and sends them SIGTERM on the *wrapper process's own* `exit` event as a
second line of defense — but that event fires only on an ordinary Node
exit, never on a SIGKILL (measured: a SIGTERM-killed wrapper with no
handler leaves its child orphaned, `ppid` reparented to init). Open orphan
risks (this bound, Claude Code tool-shell grandchildren, and Codex
grandchildren on macOS) are tracked in issue #401, out of scope for this
contract.

The mechanism behind Codex exec's grandchild also terminating (whether
`codex-linux-sandbox`'s own PDEATHSIG-style propagation, a process-group
signal, or something else in the Rust binary) is *not* measured — only the
observed timing and outcome are. Issue #401 tracks the mechanism and the
macOS (seatbelt) case.
