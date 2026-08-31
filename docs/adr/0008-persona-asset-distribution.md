---
title: Persona Assets Managed, Manifest + content-addressed Delivery
status: superseded
date: 2026-06-10
opened: 2026-06-10
supersedes: []
superseded_by: 29
related_specs: [protocol, architecture]
related_adrs: [3, 5, 7, 29]
---

# ADR 8 — Persona Asset Management, Manifest + content-addressed Delivery

## Status

Superseded by [ADR-0029](0029-persona-server-sot-and-pack-distribution.md)
(2026.-05). server inherits the policy of the asset, and distributes the unit.
"zip pack" from "Stand picture only manifest"
auto-watch and enforce of “Nora persona”
integration.

The following remains as historical circumstances:

## Context

`persona.sprite_set` is a string and a separate projectedternal client
([ADR-0007](0007-client-separation-reference-dashboard.md))
The way to solve the image was unsecided right. The only client already connected
The component is useful. Compress and distribute archives for each request
CPU and latency

## Decision

- Persona Assets**Management**
`persona.id`
[ADR-0003](0003-persona-identity-persistence.md))
Have a look (asset). server agent undependent is maintained.
- Primary format of delivery**Manifest JSON**(persona.id → State image URL +
Content  + Version)+**content-addressed static file**.
ed URLs are unchanged and cache indefinite, and the client is different
Synchronize increment.
- Bulk archive**the relevant entry-Homerate once when uploading**Save
(No on-demand compression).
- **Step Introduction**: The first step is directly placed by the administrator to the left data directory
(Deliverybution only) Upload API (verification: zip-slip / size limit / MIME
RBAC upload roll,
[ADR-0005](0005-access-control-oauth-stub.md))
- Metadata SQLite, real files are added to the file system.

## Consequences

### Positive

- All clients have a consistent look and do not need to get an asset separately when trying.
- Server burden is almost static file delivery and storage only (normal load of compression and conversion)
None
- An incremental.hronization and cash strategy will become self-evident by the manifest's nickname.

### Negative

- Responsibilities for asset storage, manifest generation and upload verification on server
Close
- Upload API is a roll design of RBAC (with ADR  API)
permission

### Neutral

- Client local overwrite (offline use/custom skin)
Leave the room for the manifest specification.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|On-demand compression archive distribution (original)|Pay CPU latency for each request|
|external static host delegation (such as Nextcloud)|Convergence of availability and increased CORS sampling, gained in lab scale|
|Client-side Asset Pack|Impairs the consistency of trial laying and display|
