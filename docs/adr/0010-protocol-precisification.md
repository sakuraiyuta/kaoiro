---
title: Finalize only empirically verified envelope type/payload; reserve the rest as names
status: accepted
date: 2026-06-11
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [protocol, agent-sdk-events]
related_adrs: [9, 11, 12, 15, 16, 19, 22, 27, 28, 47]
---

# ADR-0010 — Finalize Only Empirically Verified Envelope Type/Payload; Reserve the Rest as Names

## Status

Accepted

## Context

[protocol](../specs/protocol.md) fixed only the outer frame keys as v0; the
`type`/`payload` type system, directional message types, and versioning policy
were undecided (open-question protocol-precisification, filed 2026-06-04).

Options considered:

| Option | Content | Evaluation |
|----|------|------|
| A | Finalize only the range verified by real consumers and reserve the rest as names | Adopted |
| B | Finalize all types theoretically first | Risk of mismatch with the actual SDK/implementation and rework (the same as the "theory-first" approach rejected when the issue was filed) |
| C | Defer finalization and proceed as provisional | Abandon the purpose of Phase 1.5 (finalizing with real consumers) |

Basis for the judgment: The SDK-side event specification is finalized
([agent-sdk-events](../specs/agent-sdk-events.md)). The Phase 1.5 tracer bullet
brought the real consumers (server and client) together, and the only things
that actually traveled over the wire were `type: state_change` envelopes and
server → client `snapshot`/`envelope` events (Phase 2/3 features do not yet
exist).

## Decision

- Make `type` a **closed enum**, and finalize the payload type only for the
  proven `state_change`. List `log` / `permission_request` / `result` as
  **reserved names**, and add their payloads when implementing the phase that
  uses them.
- Finalize the three existing directional message types (wrapper → server
  `envelope`, server → client `snapshot` / `envelope`). Add bidirectional
  messages (instructions and approvals: client → server → wrapper) when Phase 3
  begins.
- Versioning policy: The receiver **ignores unknown keys** (forward
  compatibility). Key additions and additions of reserved types keep the same
  version. Raise `version` only for breaking changes such as changing the
  meaning of or deleting an existing key. `ext` is the filter namespace and is
  not interpreted by the core.
- Update [protocol](../specs/protocol.md) to `status: accepted`. Handle
  subsequent changes as ordinary spec revisions plus an ADR when necessary.

## Consequences

### Positive

- The protocol becomes accepted with the implementation and specification in
  agreement, completing Phase 1.5's purpose (finalizing the protocol with real
  consumers).
- The reserved-name approach avoids incorrectly fixing the bidirectional design
  for Phase 3 in advance.

### Negative

- The payloads for `log`/`permission_request`/`result` and bidirectional
  messages remain undefined, requiring spec addenda when each phase begins.

### Neutral

- Versioning of the transport layer (Channels V2) is carried by `vsn`
  negotiation ([ADR-0009](0009-client-transport.md)). The version in this ADR
  is for the application-layer envelope.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Theoretically finalize all types (Option B) | Risk of rework due to mismatch with the Phase 3 implementation; the same as the theory-first approach rejected when the issue was filed |
| Defer finalization (Option C) | The protocol remains provisional, abandoning the significance of Phase 1.5, which is to finalize it with real consumers |
