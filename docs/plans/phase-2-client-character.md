---
title: Phase 2 — Client + Characters + State-Based Expressions
description: Display agents as characters in the Web client and map their states to expressions.
status: done
phase: 2
depends_on: [phase-1.5-minimal-server-client]
last_updated: 2026-06-16
---

# Phase 2 — Client + Characters + State-Based Expressions

## Goal

Display agents as character art in the Web client (TS) and visualize the Phase 1
state changes as expressions (emotion NLP is not included yet).

## Acceptance Criteria

- [x] State → expression mapping works
- [x] Apply the persona (standing-art set) to the client
- [x] Rendering switches between static variations for each persona
- [x] Produce expression-variation assets in bulk with ComfyUI (by state + persona)
- [x] The client triggers notifications (desktop notification + sound) on transitions
  to waiting_input / waiting_permission (#7)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2-1 | Client scaffold (subscribe to state → display) | ✅ | Reference dashboard (Svelte 5 + Vite, `dashboard/`, issue #12). The protocol layer is the Svelte-independent `protocol.ts` |
| 2-2 | State → expression mapping | ✅ | Sprite version implemented (2026-06-11): implemented the manifest + delivery from stage 1 of [ADR-0008](../adr/0008-persona-asset-distribution.md); cards prefer sprites and fall back to CSS faces. `disconnected` is idle in grayscale |
| 2-3 | Bulk production of expression variations with ComfyUI | ✅ | 3 personas x 7 states = 21 images complete. Officially placed in `server/priv/personas/`. Policy, specification, and provenance are in [specs/personas](../specs/personas.md) |
| 2-4 | Waiting notification (desktop notification + sound) | ✅ | On transitions to waiting_input / waiting_permission, trigger `Notification` + state-specific wav sounds (`input.wav` / `permission.wav`, HTMLAudioElement) (#7, `dashboard/src/lib/notify.ts`). Trigger only on live transitions in `onEnvelope`, not on snapshots. Sound is best-effort subject to autoplay policy |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- Investigate animation/3D rendering in the future ([ADR-0004](../adr/0004-client-rendering-staged.md)).

## Outcome notes

- The mixed kuroe touch was adopted based on actual-screen evaluation (2026-06-11).
  The reference implementation values catalog-like diversity; unification is a
  client-side decision (reflected in the basic policy of [specs/personas](../specs/personas.md)).

## Open Questions Blocking This Phase

None.

## See Also

- Specs: [architecture](../specs/architecture.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md)
- Previous: [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md)
