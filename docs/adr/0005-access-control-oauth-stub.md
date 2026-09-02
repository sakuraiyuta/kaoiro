---
title: Access control is OAuth + RBAC; the prototype is a stub
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [7, 8, 11, 13, 42]
---

# ADR-0005 — Access Control Is OAuth + RBAC; the Prototype Is a Stub

## Status

Accepted

## Context

How to control client ↔ server user access was a problem. Multi-user access and
permission assignment will be needed in the future, but implementing full
authentication and authorization at the prototype stage is burdensome. This is
a separate layer from wrapper authentication
([ADR-0002](0002-local-wrapper-websocket-topology.md)).

## Decision

- **OAuth authentication** enables multi-user access, with **RBAC** (view-only /
  instruction-capable, etc.).
- **The prototype is a stub**, managing allowed email accounts with a **text or
  SQLite whitelist**.

## Consequences

### Positive

- A basis for multi-user access is established early, while the full
  implementation can be deferred.

### Negative

- The migration cost from the stub to the full implementation.
- The OAuth provider and permission granularity remain undecided (to be worked
  out later).

### Neutral

- The granularity of the permission model (view-only / instruction-capable /
  approval-capable, etc.) will be settled at implementation time.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| No authentication | Public operation is not possible |
| Full OAuth + RBAC from the start | Overkill for the prototype and slows development |
