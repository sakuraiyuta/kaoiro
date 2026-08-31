---
title: The envel  type/payload only determines the validation range, and the rest is the reservation name
status: accepted
date: 2026-06-11
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [protocol, agent-sdk-events]
related_adrs: [9, 11, 12, 15, 16, 19, 22, 27, 28, 47]
---

# ADR-0010 — Envel  type/payload only confirms its validity and the rest is reserved

## Status

Accepted

## Context

[protocol](../specs/protocol.md) is fixed as v0,
`type`/`payload` type system, directional message type, and versioning policy are not confirmed
open-question protocol-precisification, 2026-06-04

Considered Options:

|||Japanese term|
|----|------|------|
| A |Only the extent demonstrated by real consumers, and the rest are reserved names|Contact Us|
| B |Completed on the desk first|The actual situation of the SDK/implementation and the risk of being created (same as “on-desk precedence” rejected at the time of vote)|
| C |See the confirmation and proceed with provisional|waiver of Phase 1.5|

Judgment Material: The event specification of the SDK is confirmed
[agent-sdk-events](../specs/agent-sdk-events.md) Phase 1.5 Tracer
A real consumer (Clients client) in a varette, actually flowing wire
`type: state_change` Envel s and Clients
`snapshot`/`envelope` Events only (Phase 2/3 features still exist).

## Decision

`type`**close enum**and payload type only for proven `state_change`
Contact Us `log` / `permission_request` / `result`**Reservation**and
payload adds to the implementation of the use phase.
- 3 types of messages (wrapper →   `envelope`,
`snapshot` / `envelope`)  
(Instruction and approval: Client →   → wrapper) will be added to Phase 3
- Versioning Policy: The receiving side is**I re unknown keys**(forward compatibility). Add Key
The order of the reservation type remains the same version. Change or delete existing keys
Raise `version` only. `ext` is the namespace of the filter.
Not interpreted.
- Update [protocol](../specs/protocol.md) to `status: accepted`.
Any subsequent changes will be handled by the usual  revision + ADR according to required.

## Consequences

### Positive

- The protocol is accepted in the state where the implementation and specifications match, and the
The purpose (protocol confirmation by real consumers) is completed.
- Booking name approach does not falsely fix the design of Phase 3 in advance.

### Negative

`log`/`permission_request`/`result`
Leave undecided right, and try to repairJapanese termーHome at each phase.

### Neutral

- Transport layer (Channels V2)
([ADR。9](0009-client-transport.md)). This ADR version is
App layer envel。.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|All types are determined on the desk (draft B)|Phase 3 Risks to make implementations Same as the front of the desk that was rejected at the time of vote|
|Determination (Draft C)|waives the significance of Phase 1.5 that the protocol remains provisional and is determined by real consumers|
