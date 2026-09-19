---
title: Plugin model (migration stub)
description: Migration stub; every section links to its new canonical page.
status: accepted
related: [architecture, protocol]
---
<!-- markdownlint-disable MD033 -->

# Plugin model

The extension architecture moved to [Extensions](../architecture/extensions.md),
the adapter contract to [Engine adapter contract](../reference/engines/adapter-contract.md),
the session capability advertisement to
[Session capability advertisement](../architecture/extensions.md#session-capability-advertisement)
and [Session capabilities](../reference/protocol/capabilities.md), and the
Claude catalog contract to
[Claude model catalog](../reference/engines/claude-model-catalog.md).

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

Moved to [Session capability advertisement](../architecture/extensions.md#session-capability-advertisement) (design intent) and
[Session capabilities](../reference/protocol/capabilities.md#extsession_capabilities-2026-07-11-adr-0034-f1f2) (field contract).

### Claude model catalog live refresh and bootstrap default floor ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md), implemented in Phase 18)

Moved to [Claude model catalog live refresh and bootstrap default floor](../reference/engines/claude-model-catalog.md#claude-model-catalog-live-refresh-and-bootstrap-default-floor-adr-0037-implemented-in-phase-18).

### Transparent canonical IDs and two-pass catalog-row matching ([ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) F9 addendum, implemented 2026-07-31)

Moved to [Transparent canonical IDs and two-pass catalog-row matching](../reference/engines/claude-model-catalog.md#transparent-canonical-ids-and-two-pass-catalog-row-matching-adr-0037-f9-addendum-implemented-2026-07-31).

## Constraints

Moved to [Constraints](../architecture/extensions.md#constraints).

## See Also

Moved to [See Also](../architecture/extensions.md#see-also).
