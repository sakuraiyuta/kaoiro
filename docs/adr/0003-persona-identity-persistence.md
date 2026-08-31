---
title: Persona Identification Persistence
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [4, 8, 24, 26, 29]
---

# ADR 3

## Status

Accepted

## Context

Even if multiple agents are operated in , the character’s identity and mood are maintained over the restart.
(mast requirements). In the volatile ID of execution generation, the identity is lost by restart, and the attachment is
Not growing

## Decision

`agent_id`**Stable ID fixed by setting**(Do not use volatile ID when execution is generated).
- `persona`(id / solid name / standing picture set) is specified in the wrapper initial setting.
  **"display name" is the old**—— The `name` here defines pack
canonical well-known and session during immutations
  [ADR-0029](0029-persona-server-sot-and-pack-distribution.md) F9).
`display_name`
  ([issue #209](https://github.com/sakuraiyuta/kaoiro/issues/209)
  D19).
- **The user ifies which host/process agent is responsible for**.
- server/client lasts `agent_id`(+`persona.id`) to the key.

## Consequences

### Positive

- Reboot and multi-operation, permanent identity and attachment.
- Easy to identify and understand which character you are in charge.

### Negative

- Persona-defined schemas and set-up reference approach management is required.
- Drawing type (static difference / animation / 3D)
[ADR-0004](0004-client-rendering-staged.md)

### Neutral

- Persona is a wrapper-side setting, so   remains agent-independent.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|execution ID|Iden  loss and dist  cannot be maintained by restart|
|Dynamic assignment on the server side|The user is unable to send a request and the operation is intuition|
