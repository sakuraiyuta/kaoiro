---
title: Plugin model (migration stub)
description: Migration stub retaining session capability advertisement until U03 moves it; other sections link to their new canonical pages.
status: accepted
related: [architecture, protocol]
---
<!-- markdownlint-disable MD033 -->

# Plugin model

The extension architecture moved to [Extensions](../architecture/extensions.md),
the adapter contract to [Engine adapter contract](../reference/engines/adapter-contract.md),
and the Claude catalog contract to
[Claude model catalog](../reference/engines/claude-model-catalog.md). The
session capability advertisement remains below until U03 moves it.

## Purpose

Moved to [Purpose](../architecture/extensions.md#purpose).

## Definition

Moved to [Definition](../architecture/extensions.md#definition).

### Two extension points — design them separately

Moved to [Two extension points — design them separately](../architecture/extensions.md#two-extension-points--design-them-separately).

### Common event boundary

Moved to [Common event boundary](../architecture/extensions.md#common-event-boundary).

### Package structure and entity extension

Moved to [Package structure and entity extension](../architecture/extensions.md#package-structure-and-entity-extension).

### EngineAdapter interface

Moved to [EngineAdapter interface](../reference/engines/adapter-contract.md#engineadapter-interface).

### Session capability advertisement (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md))

This path communicates **session-scoped capability** (auth mode / plan tier /
wrapper implementation differences) that an engine name cannot express to the
UI. Do **not add** a capability-getter hook to `EngineAdapter`; each adapter
builds `ext.session_capabilities` directly in its state-stamp path (equivalent
to `#statusExt`) and advertises it in the envelope
(ADR-0034 F4).

- **Reason**: A capability is not a “static fact” over the session lifetime;
  it is the composition of adapter implementation + spawn-time selection + auth
  mode. Building it inside the adapter in sync with state reflects reality, and
  keeps the envelope consistent as SoT (the principle in
  [ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).
- **Stamp timing**: **from the first state_change** directly after spawn (do not
  wait for a session_init-equivalent event). Codex delays `thread.started` until
  the first turn because it spawns a new `codex exec` process every turn; waiting
  for session_init would make a newly started Codex agent display falsely as
  “no capability” under the fail-closed default
  ([codex-sdk-events](../reference/engines/codex-exec-events.md)). Claude also stamps from its first
  state_change for symmetry.
- **UI decision principle**: The UI must not determine capability from the
  engine name (`ext.engine`) (review prohibition,
  [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3). Look only
  at boolean / conditional arrays in `ext.session_capabilities`.
- **Current advertised values**:
  - `wrapper/claude-code`: `supports_attachments: true` /
    `supports_user_input_dialog: true` (unconditional; omit
    `attachment_types` = no type restriction)
  - `wrapper/codex`: `supports_attachments: true` /
    `attachment_types: ["image"]` / `supports_user_input_dialog: true`. The UI
    limits picker / paste / drop to images (changed from the original planned
    `false` when attachments were added in phase-14)
  - `wrapper/antigravity`: `supports_attachments: false` /
    `supports_user_input_dialog: true` / `supports_model_switch: true` /
    `supports_effort_switch: false` / `supports_context_usage: false`
- **`supports_model_switch` / `supports_effort_switch`** (implemented in
  phase-16, 2026-07-13, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md)
  F4): Advertise whether `set_model` / `set_effort` are accepted mid-session.
  Claude is always `true` because its SDK supports them; Codex is `true` when
  the catalog resolver can return `EngineModelInfo[]` (auth mode and plan are
  known), and `false` when unknown / the catalog is empty. The engine updates
  the advertisement whenever catalog / auth mode changes.
- **`supports_permission_switch` / `permission_switch_axes`**: Codex and
  Antigravity advertise runtime permission selection only after permission-sync
  negotiation. Antigravity additionally requires all runner-supplied sandbox,
  network-access, and approval ceilings; absent capability fields remain
  fail-closed for legacy peers.

### Claude model catalog live refresh and bootstrap default floor ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md), implemented in Phase 18)

Moved to [Claude model catalog live refresh and bootstrap default floor](../reference/engines/claude-model-catalog.md#claude-model-catalog-live-refresh-and-bootstrap-default-floor-adr-0037-implemented-in-phase-18).

### Transparent canonical IDs and two-pass catalog-row matching ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) F9 addendum, implemented 2026-07-31)

Moved to [Transparent canonical IDs and two-pass catalog-row matching](../reference/engines/claude-model-catalog.md#transparent-canonical-ids-and-two-pass-catalog-row-matching-adr-0037-f9-addendum-implemented-2026-07-31).

## Constraints

Moved to [Constraints](../architecture/extensions.md#constraints).

## See Also

Moved to [See Also](../architecture/extensions.md#see-also).
