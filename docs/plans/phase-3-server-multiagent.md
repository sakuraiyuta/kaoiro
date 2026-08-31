---
title: Phase 3 — Server Aggregation + Multiple Agents + Bidirectional Routing
description: Aggregate multiple wrappers in an Elixir/Phoenix server and route instructions and approvals bidirectionally.
status: done
phase: 3
depends_on: [phase-2-client-character]
last_updated: 2026-06-11
---

# Phase 3 — Server Aggregation + Multiple Agents + Bidirectional Routing

## Goal

Aggregate multiple wrappers over WebSockets in the server (Elixir/Phoenix),
visualize multiple agents simultaneously, and enable sending instructions and
approvals to a specific agent.

## Acceptance Criteria

- [x] Run multiple Claude Code instances concurrently and visualize them together (three simultaneous connections verified on real machines)
- [x] Make it immediately clear “which one is doing what / which one is waiting”
- [x] Send instructions to any one agent (bidirectionally)
- [x] Allow/reject permission approvals from the client UI (relay verified on a real machine; the ask path was also confirmed through SDK measurement — issue #1 resolved, [agent-sdk-events](../specs/agent-sdk-events.md))
- [x] Let the user specify persona assignment (which host/process has which persona) (wrapper config, since Phase 1)
- [x] Preserve personas across restarts (stable agent_id + config, [ADR-0003](../adr/0003-persona-identity-persistence.md))
- [x] Connection loss (`disconnected`), token authentication, TLS, and heartbeat (TLS terminates at the proxy)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3-1 | Aggregate multiple wrappers with Phoenix Channels | ✅ | One channel process per connection + `AgentStates` (owner tracking prevents reconnect races). Implemented since Phase 1.5, complete with disconnected derivation (2026-06-11) |
| 3-2 | Bidirectional instruction/approval routing | ✅ | Implemented and verified on a real machine: `instruction` / `permission_decision` relay + approval UI + wrapper `PermissionBroker` (600-second deny, [ADR-0011](../adr/0011-phase3-reliability-and-auth.md)). Also resolved the trigger conditions for the canUseTool ask path (issue #1, verification note in [agent-sdk-events](../specs/agent-sdk-events.md)) |
| 3-3 | Wrapper token authentication + TLS + heartbeat | ✅ | Per-agent_id tokens ([ADR-0011]). TLS terminates at the proxy (decided 2026-06-11), and heartbeat is built into Channels. Disconnect is derived by the server from terminate as `disconnected` |
| 3-4 | User access-control stub (allowlist) | ✅ | User token + role (viewer/operator, [ADR-0011]). Unset env means dev mode (all connections are operators) |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- Full OAuth + RBAC is future work ([ADR-0005](../adr/0005-access-control-oauth-stub.md)).
- Operational verification with multiple real Claude Code instances (the feature
  is verified with three fake-wrapper connections + SDK measurements; long-term
  stability in real operation will be confirmed through use).

## Open Questions Blocking This Phase

None.

## See Also

- Specs: [architecture](../specs/architecture.md),
  [protocol](../specs/protocol.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0003](../adr/0003-persona-identity-persistence.md),
  [0005](../adr/0005-access-control-oauth-stub.md)
- Previous: [phase-2-client-character](phase-2-client-character.md)
