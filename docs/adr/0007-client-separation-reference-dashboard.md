---
title: Clients include separate project separation and reference dashboard
status: accepted
date: 2026-06-10
opened: 2026-06-10
supersedes: []
superseded_by: null
related_specs: [architecture, non-goals, protocol]
related_adrs: [4, 5, 8, 9, 12, 20]
---

# ADR 7 — client includes separate project separation and reference dashboard

## Status

Accepted

## Context

The client’s offering was a problem. Electron-based Rich GUI Terminal
CUI/neovim Plug-in
On the other hand, if you don’t prepare a client separately, you can’t try it. More
If you make a reference implementation in LiveView, you can directly consumein's PubSub andternal
Not passing through public APIs used by clients, so as to verify reference implementation and conformity
lose value.

## Decision

- Client implementation**separation as another project (repos y)**Server ↔
Client API**Home and versioning as a public protocol**
- Main body**Includes a simple dashboard (br er) for reference**Home
Svelte 5 + Vite
Not available Protocol layer (connection, subscription, instructions, approval response) is Svelte non-dependent
separation to the plain TS module.
- The simple dashboard is not LiveView, but is the same as the **ex  client.
Consuming APIs** (dogfooding = protocol reference implementation and calibration validation).
- Simple dashboard in server settings**Static delivery only off**Contact Us
(Channel/API is always valid) Default is ON.
- The scope is fixed to the minimum (state list, expression, approval, instructions)
  ([non-goals](../specs/non-goals.md))。

## Consequences

### Positive

- It can be used only by browser and the installation is low.
- The public API is alwaysJapanese termd with the included client (reference implementation and conformity test).
- The client becomes clear as the third extension following the adapter/filter.

### Negative

- The backward compatibility of the public API is responsible.
- The server repository has a TS build (Vite).

### Neutral

- Connectionapproach is determined by Japanese term Channels
  ([ADR-0009](0009-client-transport.md))。
- The source location of the included dashboard is `dashboard/` (issue #44) of the repo route.
`server/assets/`, independent pnpm route + independent lockfile). "Included"
Keep the Resultfacts  during release build and don’t commit the  facts
(`server/Dockerfile` node stage). Repos y is still unavailable.
- Stage introduction ([ADR 4](0004-client-rendering-staged.md))
Become a client’s interest.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Dashboard implementation with LiveView|Apply to reference implementation without passing through public API|
|Clients are included in the main unit (MonoRepo)|Unfamiliar with the growth of diverse clients, the core is hypertrophy|
|Not Included Clients|High proto ing|
|SvelteKit|Excess SSR/routing mechanism. Home Vite SPA|
