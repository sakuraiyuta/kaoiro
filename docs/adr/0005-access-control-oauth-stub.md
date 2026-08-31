---
title: OAuth + RBAC
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [7, 8, 11, 13, 42]
---

# ADR 5 — Access control is OAuth + RBAC, the prototype is stub

## Status

Accepted

## Context

How to control client ↔ server user access was a problem. In the future
Multi-person access and permission are required, but it is necessary to set up full authentication and authorization at the prototype stage.
heavy. [ADR-0002](0002-local-wrapper-websocket-topology.md)
It is a separate layer.

## Decision

- **OAuth authentication**Multi-person access**RBAC**(Only viewing/instructible etc.)

- **Prototype is stub**and allow email accounts in text or SQLite
Manage with Whitelist**.

## Consequences

### Positive

- This implementation can be rotated backward while having multiple bases early.

### Negative

- The cost of migration to this implementation.
- OAuth provider permission particle size is not confirmed (for future).

### Neutral

- The particle size of the permission model is determined at the time of implementation.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|No certification|No public operation|
|OAuth + RBAC|Over-prototype and delayed development|
