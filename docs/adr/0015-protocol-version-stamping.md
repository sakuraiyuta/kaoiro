---
title: Warning for unmatched versions to all communications (best-effort acceptance)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [10, 14, 19, 25, 47]
---

# ADR-0015 — Warning when version is unmatched to all communications

## Status

Accepted

## Context

There is already `version` in the envel , and the versioning policy is "reception key"
[protocol](../specs/protocol.md) However,
There is a lack of two points: (1) wrapper for the version → server envel ,
`instruction` / `permission_decision` / `snapshot`
No version. (2) Impairment is accepted silently and does not notice compatibility issues.
I want to detect mismatch between wrappers/Clientss/clients.

## Decision

- version**Granting all three messages as a flat external key**
(Draft A) Add `version` to payload. Envel  already
align `version` / `ts` / `seq` to an existing design with a flat external key.
- but `attach_chunk` is not a JSON object binary transport frame
No flat keys.**carve-out**as version
Not applicable. To add version to binary header, use destructive wire
The protocol of the protocol version is required.
- The receiver is your version**Full match only normal**Unmatched
  **Warning Logs**Contact Us
-**Best Effort to continue processing**(not stopping unmatched).
- Unknown elements are  ncated (unknown envel  key is an existing forward-compatible policy)
silently ignored).
- The same common meta such as `ts` is used for all messages in the same "common frame key" framework
(only version).

## Consequences

### Positive

- Compatibility mismatches are visualized with warnings.
- Consistently handle common meta such as version/ts with all communication (same as existing envel ).

### Negative

- There is a need to add/check version to each message generation and receiving location.

### Neutral

- version is current `"0"` single. Single value comparison.
- Transport layer version (Channels `vsn`, [ADR-0009](0009-client-transport.md))
Independence
- **build identity**([ADR-0053](0053-build-identity.md), issue #218)
  **Independence**Home This version is compatible with wire messages,
gitfact(git / server image)
If confusing, "docs-only commit causes compatibility errors"


## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Bill B (all messages)`{version, kind, payload}`Unified Envel )|Existing Envel `type`Two layers and redundancy. Unmatched churn to make a confirmed v0 design|
|Unmatched and Unmatched Acceptance|Not aware of compatibility issues|
|ImHomeate error rejection|Operation is stopped. Priority to Best Effort|

## Related

-Japanese term: [protocol](../specs/protocol.md) versioning policy.
-CO ADR: [0010](0010-protocol-precisification.md)
  [0014](0014-session-resume-and-restore.md).
- Origin: my-idea-efef

## Addendum (issue #208 Home review MF-1, 2026 21):`attach_chunk`permanent carve-out

**Contact Us**`attach_chunk` is a binary transport consisting of a fixed length header and a raw byte column.
frame, not having JSON's flat outer frame key,
Not permanent. This is a carve-out, which is Homeified to existing Decision
ADR status remains accepted.

If you want to add version to binary header, you can change the destructive of the existing frame.
Home of version. For implementationAbout Uss that cannot contain the same key as JSON frame
Don’t admit because there is no cost-effectiveness. wire shape
[protocol](../specs/protocol.md)'s "version inventory" is a genuine book.

**HOME**Home review of issue #208 must-fix 1. only lower
Revised to Decision of this ADR.
