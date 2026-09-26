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
| Claude Code wrapper's direct CLI child | SIGKILL 4000ms after host abort if still alive | `AgentHost`'s bounded custom spawner; the child's piped stdio currently keeps the wrapper alive, while the referenced timer protects against a future SDK change that closes those pipes |
| Codex exec child + its sandboxed grandchild | both gone ~50ms after SIGTERM | measured offline, `workspace-write` and `danger-full-access`, 2 runs each — issue #401 |
| Codex app-server child | SIGKILL 2000ms after stdin EOF if still alive | `shutdownTimeoutMs`, wired by `CodexHost` below `RESET_TERMINATION_GRACE_MS` |

The wrapper's 4000ms direct-child deadline completes before runner reset's
5000ms escalation. The SDK's later 7000ms escalation remains a fallback.
The wrapper owns only the CLI child, not processes launched by Claude tools:
a loopback Bash test found that a normal `sleep` exited after CLI `SIGTERM`
(3/3), while a Node descendant that ignored `SIGTERM` survived (3/3).
Codex grandchildren under macOS seatbelt remain unmeasured; Linux observations
do not establish their behavior on macOS. See issue #401 and
[the measurement plan](../../plans/issue-401-orphan-shutdown.md).

The mechanism behind Codex exec's grandchild also terminating (whether
`codex-linux-sandbox`'s own PDEATHSIG-style propagation, a process-group
signal, or something else in the Rust binary) is *not* measured — only the
observed timing and outcome are. Issue #401 tracks the mechanism and the
macOS (seatbelt) case.
