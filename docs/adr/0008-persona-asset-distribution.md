---
title: Server-managed persona assets; manifest + content-addressed delivery
status: superseded
date: 2026-06-10
opened: 2026-06-10
supersedes: []
superseded_by: 29
related_specs: [protocol, architecture]
related_adrs: [3, 5, 7, 29]
---

# ADR-0008 — Server-Managed Persona Assets; Manifest + Content-Addressed Delivery

## Status

Superseded by [ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
(2026-07-05). The policy of having the server hold the assets is retained,
while the distribution unit is expanded from a "standing-pictures-only
manifest" to a "zip pack (personality prompt + standing pictures)", integrating
automatic application through auto-watch and enforcement of "no unregistered
personas".

The following remains as historical background.

## Context

`persona.sprite_set` is a string, and the means for the external clients made
separate projects ([ADR-0007](0007-client-separation-reference-dashboard.md)) to
resolve it to actual images was undefined. The server is the only component to
which all clients are already connected. Compressing and delivering an archive
for each request would incur the CPU and latency cost every time.

## Decision

- The server **manages the source of truth** for persona assets (standing
  pictures and expression variants). The wrapper holds only identity
  (`persona.id`, [ADR-0003](0003-persona-identity-persistence.md)); the server
  holds the appearance (assets). The server remains agent-independent.
- The primary delivery format is **manifest JSON** (persona.id → image URL by
  state + content hash + version) + **content-addressed static files**. URLs
  with hashes are immutable and cached indefinitely; the client performs
  incremental synchronization based on hash differences.
- Generate and save the bulk archive **once when the upload is accepted** (do
  not compress on demand).
- **Phased introduction**: In the first phase, an administrator places files
  directly in the server's data directory (delivery only is implemented). The
  upload API (validation: zip-slip / size limit / MIME restriction / SVG
  exclusion; authorization: RBAC upload role,
  [ADR-0005](0005-access-control-oauth-stub.md)) comes later.
- Metadata is stored in SQLite, and actual files are stored on the filesystem.

## Consequences

### Positive

- Appearance is consistent across all clients, and assets do not need to be
  obtained separately when trying the system.
- Server load is almost entirely static file delivery and storage (with no
  constant compression or conversion load).
- Manifest hashes make the incremental synchronization and caching strategy
  straightforward.

### Negative

- The server takes on responsibility for asset storage, manifest generation,
  and (later) upload validation.
- The upload API is deferred in coordination with the RBAC role design
  (ADR-0005).

### Neutral

- The manifest specification leaves room for client-local overrides (offline
  use and custom skins).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| On-demand compressed archive delivery (original proposal) | Pays the CPU and latency cost for each request |
| Delegation to an external static host (such as Nextcloud) | Increases availability coupling and CORS work, with no benefit at lab scale |
| Client-side asset pack | Harms the barrier to trying the system and consistency of its appearance |
