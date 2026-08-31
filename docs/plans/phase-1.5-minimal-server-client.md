---
title: Phase 1.5 — Minimal Server + Minimal Client (Tracer Bullet)
description: Establish the vertical slice with a minimal Phoenix server and minimal text/color-only Web display, and finalize the envelope with a real consumer.
status: done
phase: 1.5
depends_on: [phase-1-wrapper-state-machine]
last_updated: 2026-06-11
---

# Phase 1.5 — Minimal Server + Minimal Client (Tracer Bullet)

## Goal

Drive the wrapper → Phoenix server → Web client (text/color only) vertical slice
through a minimal implementation. Finalize the kaoiro envelope (type/payload) with
a real consumer and eliminate TS↔Elixir boundary integration risk before character
art (Phase 2) (decision history: issue #2).

## Acceptance Criteria

- [x] The minimal Phoenix server accepts one wrapper's WebSocket connection and
      relays state events to the client (E2E smoke-tested)
- [x] The minimal Web display (text/color only) follows state changes in the browser
      (Playwright confirmed tracking and snapshot restoration after reload)
- [x] A real consumer verifies envelope type/payload and allows
      [protocol](../specs/protocol.md) to be updated to `accepted`
      ([ADR-0010](../adr/0010-protocol-precisification.md))
- [x] Decide the client connection method
      ([ADR-0009](../adr/0009-client-transport.md): consolidate on Channels,
      decided based on the June 2026 investigation)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.5-1 | Investigate and decide the client connection method | ✅ | issue #11. Decided to consolidate on Channels ([ADR-0009](../adr/0009-client-transport.md)) |
| 1.5-2 | Minimal Phoenix server (receive one wrapper → relay) | ✅ | `server/` (Channels relay + AgentStates) + wrapper-side `ServerLink`. Authentication and multi-agent aggregation are deferred to Phase 3 |
| 1.5-3 | Minimal Web display (text/color only) | ✅ | `server/priv/static/` — dependency-free direct Channels V2 implementation (demonstrated feasibility of implementing the public protocol). Replaced with the Svelte version in issue #12 ([ADR-0007](../adr/0007-client-separation-reference-dashboard.md)) |
| 1.5-4 | Finalize envelope type/payload | ✅ | Finalized only the demonstrated scope ([ADR-0010](../adr/0010-protocol-precisification.md)). Promote the protocol spec to accepted |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Scope Boundaries

- Character art and expression mapping are out of scope (Phase 2).
- Multi-agent aggregation, bidirectional routing, and authentication/TLS are out of scope (Phase 3).
- The display is text/color only; do not polish its appearance.

## Open Questions Blocking This Phase

None (client-transport is resolved by [ADR-0009](../adr/0009-client-transport.md);
protocol-precisification is resolved by
[ADR-0010](../adr/0010-protocol-precisification.md)).

## See Also

- Specs: [protocol](../specs/protocol.md),
  [architecture](../specs/architecture.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0009](../adr/0009-client-transport.md)
- Previous: [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md)
- Next: [phase-2-client-character](phase-2-client-character.md)
