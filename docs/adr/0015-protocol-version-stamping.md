---
title: Add version to all communication and warn on mismatch (best-effort acceptance)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [10, 14, 19, 25, 47]
---

# ADR-0015 — Add Version to All Communication and Warn on Mismatch

## Status

Accepted

## Context

The envelope already has `version`, and the versioning policy was that the
receiver "ignores unknown keys (silent forward compatibility)"
([protocol](../specs/protocol.md)). However, two gaps remain: (1) version is
present only on wrapper → server envelopes, while non-envelope payloads such as
`instruction` / `permission_decision` / `snapshot` have no version; and (2) a
mismatch is silently accepted, so compatibility problems cannot be noticed. A
mismatch among the wrapper, server, and client needs to be detected.

## Decision

- Add version as a **flat outer-frame key to messages in all three components**
  (Option A). Add `version` to non-envelope payloads as well, matching the
  existing envelope design, which already has `version` / `ts` / `seq` as flat
  outer-frame keys.
- However, `attach_chunk` is a binary transport frame rather than a JSON object,
  so it cannot hold flat keys. As a **permanent carve-out**, exclude it from
  version stamping and validation. Adding version to the binary header would
  require a breaking wire change and a protocol-version bump, which is not worth
  the benefit.
- The receiver treats **exact equality with its own version as the only normal
  case**, and emits a **warning log** on mismatch.
- However, **accept and continue processing on a best-effort basis** (do not stop
  on a mismatch).
- Keep the current behavior for unknown elements (unknown envelope keys are
  silently ignored under the existing forward-compatibility policy).
- In the future, common metadata such as `ts` can also be added to every message
  under the same "common frame key" framework (only version is added now).

## Consequences

### Positive

- Compatibility mismatches become visible through warnings.
- Common metadata such as version/ts can be handled consistently across all
  communication (the same convention as the existing envelope).

### Negative

- Version stamping and validation must be added at every message-generation and
  message-reception point.

### Neutral

- version is currently a single value, `"0"`; exact matching is a comparison
  against that single value.
- It is independent of the transport-layer version (Channels `vsn` negotiation,
  [ADR-0009](0009-client-transport.md)).
- It is also independent of **build identity** ([ADR-0053](0053-build-identity.md),
  issue #218 addendum). The version here is wire-message shape compatibility,
  while the artifact (runner / server image)'s originating git commit is a
  separate axis—confusing them would lead to an incorrect design in which a
  docs-only commit causes a compatibility error.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Option B (unify all messages as `{version, kind, payload}` envelopes) | Two layers and redundancy with the existing envelope's `type`; the churn of reworking the settled v0 design is not worthwhile |
| Silently accept mismatches (current behavior) | Compatibility problems cannot be noticed |
| Immediately reject mismatches with an error | Operations stop; best-effort acceptance is prioritized |

## Related

- Spec: versioning policy in [protocol](../specs/protocol.md).
- Related ADRs: [0010](0010-protocol-precisification.md) and
  [0014](0014-session-resume-and-restore.md).
- Origin: my-idea-brief (rough note "adding version information to the
  communication protocol").

## Addendum (issue #208 Fuji review MF-1, 2026-08-21): Permanent `attach_chunk` carve-out

**Decision.** `attach_chunk` is a binary transport frame made of a fixed-length
header and raw bytes. Because it cannot have JSON flat outer-frame keys, it is
permanently excluded from version stamping and validation. This is the carve-out
already made explicit in the existing Decision, and the ADR's status remains
Accepted.

Adding version to the binary header would require a breaking change to the
existing frame and a protocol-version bump. It is not adopted because the cost
does not justify the benefit for an implementation constraint that prevents the
same keys as a JSON frame from being carried. The "version inventory" in
[protocol](../specs/protocol.md) is authoritative for the application points and
wire shape.

**Origin.** This is must-fix 1 from the Fuji review of issue #208. It resolves
the inconsistency in which only the lower-level spec declared the exception, by
revising this ADR's Decision.
