---
title: Persona identity persistence
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [4, 8, 24, 26, 29]
---

# ADR-0003 — Persona Identity Persistence

## Status

Accepted

## Context

Even when operating multiple agents in parallel, the character's identity and
mood must be maintained across restarts (a MUST requirement). With a volatile
ID generated at runtime, identity is lost on restart and attachment cannot grow.

## Decision

- `agent_id` is a **stable ID fixed by configuration** (do not use a volatile
  ID generated at runtime).
- `persona` (id / proper name / standing-picture set) is specified in the
  wrapper's initial configuration. **The term "display name" is outdated**—the
  `name` here is the pack-defined canonical proper name and is immutable during
  a session (later [ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
  F9). A commonly used name that can change while running is provided by a
  separate `display_name` field ([issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209)
  D19).
- **The user specifies which persona is assigned to the agent on which
  host/process.**
- The server/client persist display and mood keyed by `agent_id` (+ `persona.id`).

## Consequences

### Positive

- Persistent identity and attachment across restarts and multiple-agent
  operation.
- Easy identification, making it immediately clear which persona is assigned to
  which agent.

### Negative

- Management of persona-definition schemas and the standing-picture-set
  reference method is required.
- The drawing type (static variants / animation / 3D) is linked to
  [ADR-0004](0004-client-rendering-staged.md).

### Neutral

- Persona is a wrapper-side setting, so the server remains agent-independent.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Runtime-generated ID | Identity is lost on restart, and mood cannot be maintained |
| Dynamic assignment on the server side | The user cannot specify the assignment, making operation unintuitive |
