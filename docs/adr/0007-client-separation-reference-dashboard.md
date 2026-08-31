---
title: Client separated as a separate project; reference dashboard included
status: accepted
date: 2026-06-10
opened: 2026-06-10
supersedes: []
superseded_by: null
related_specs: [architecture, non-goals, protocol]
related_adrs: [4, 5, 8, 9, 12, 20]
---

# ADR-0007 — Client Separated as a Separate Project; Reference Dashboard Included

## Status

Accepted

## Context

The form in which the client would be provided was a problem. Users should be
able to choose from diverse clients such as an Electron-based rich GUI,
terminal CUI, or neovim plugin. On the other hand, requiring users to prepare a
client separately before they can try the system creates a high barrier to
adoption. Also, if the reference implementation is built with LiveView, it
directly consumes the server's internal PubSub and does not pass through the
public API used by external clients, losing its value as a reference
implementation and conformance verification.

## Decision

- Separate the client implementation as a **separate project (repository)**.
  Document and version the server ↔ client API as a **public protocol**.
- **Include a simple reference dashboard (browser)** in the main repository and
  serve it with Phoenix. The implementation is **Svelte 5 + Vite (plain SPA,
  no SvelteKit)**. Separate the protocol layer (connection, subscription,
  instruction, and approval response) into a plain TS module independent of
  Svelte.
- The simple dashboard is not LiveView; it **consumes the same public API as
  external clients** (dogfooding = protocol reference implementation and
  conformance verification).
- Server settings can **disable only static delivery** of the simple dashboard
  (the channel/API is always enabled). The default is on.
- Fix the scope at the minimum (state list, expressions, approvals, and
  instruction input) ([non-goals](../specs/non-goals.md)).

## Consequences

### Positive

- The system can be tried with only a browser, keeping the barrier to adoption
  low.
- The public API is continuously verified by the included client (reference
  implementation and conformance test).
- The client is clearly established as the third extension surface after the
  adapter and filter.

### Negative

- Maintaining backward compatibility for the public API becomes a
  responsibility.
- A TS build (Vite) coexists in the server repository.

### Neutral

- The connection method is fixed to Phoenix Channels
  ([ADR-0009](0009-client-transport.md)).
- The included dashboard's source is at `dashboard/` in the repository root
  (moved from `server/assets/` in issue #44, with an independent pnpm root and
  lockfile). "Included" is maintained by baking the artifact into the release
  build; artifacts are not committed (the node stage in `server/Dockerfile`).
  Separation into a separate repository has still not started.
- The staged introduction of drawing types
  ([ADR-0004](0004-client-rendering-staged.md)) is a concern for each client.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Implement the dashboard with LiveView | It would not pass through the public API and would not be a reference implementation |
| Include the client in the main repository as well (monorepo) | Unsuitable for the growth of diverse clients; the core would become bloated |
| No included client | High barrier to trying the system |
| Adopt SvelteKit | SSR/routing mechanisms are excessive; a plain Vite SPA is sufficient |
