---
title: Engine adapter contract
description: Exact common lifecycle, control, pending-state, and Tool-conversion contract implemented by concrete engine adapters.
status: accepted
last_updated: 2026-09-19
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
