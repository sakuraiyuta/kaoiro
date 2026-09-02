---
title: Client connections unified on Phoenix Channels
status: accepted
date: 2026-06-11
opened: 2026-06-10
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [7, 10, 25]
---

# ADR-0009 — Client Connections Unified on Phoenix Channels

## Status

Accepted

## Context

Separating the client into a separate project and documenting a public protocol
were already decided ([ADR-0007](0007-client-separation-reference-dashboard.md)).
It was undecided whether the connection method should be Phoenix Channels or
plain WebSocket (with read-only SSE alongside it). Channels are natural for the
included reference dashboard (TS), but there was concern that non-JS clients
(neovim plugin = Lua, terminal CUI, etc.) would bear the burden of implementing
the Channels wire protocol (issue #11).

The following was found in the 2026-06 investigation:

- The Channels wire protocol V2 (a five-element array,
  `[join_ref, ref, topic, event, payload]`, and `?vsn=2.0.0` on connection) is a
  public protocol documented in the official guide
  [Writing a Channels Client](https://hexdocs.pm/phoenix/writing_a_channels_client.html),
  and its format has remained unchanged from its introduction in the Phoenix
  1.3/1.4 era through the 1.8 series. This does not depend on internal
  implementation details.
- There is precedent for Supabase Realtime documenting the same protocol as its
  public API and establishing multilingual clients.
- Non-JS language client libraries (as of 2026-06): C# has
  [PhoenixSharp](https://github.com/Mazyod/PhoenixSharp) (active, V2); Go has
  [nshafer/phx](https://github.com/nshafer/phx) (V2, maintained); Rust has
  [liveview-native/phoenix-channels-client](https://github.com/liveview-native/phoenix-channels-client)
  (active V2, using a git dependency because crates.io is stagnant). Python
  has no maintained V2 client, but writing one on top of `websockets` is easy.
  Lua (neovim) has no Channels client at all, and the WebSocket layer itself is
  not standard.
- The decisive point is that Lua's main burden is the WebSocket layer (writing
  an RFC 6455 client in pure Lua), and **the plain WebSocket option would incur
  the same burden**. In addition, the plain WS option would require designing
  reconnection, heartbeat, request/response correlation (ref), and topic
  subscription specifications from scratch, which would only reinvent the
  lifecycle part of Channels.

## Decision

- **Unify client connections on Phoenix Channels**. Do not provide a plain
  WebSocket endpoint alongside it.
- Fix the wire format to the **V2 serializer** (require `vsn=2.0.0` on
  connection), and include a reference to the official guide plus kaoiro-specific
  topic/event definitions in kaoiro's public protocol document
  ([protocol](../specs/protocol.md)).
- **Defer read-only SSE** (there is no maintained library on the Elixir side and
  handwritten implementation would be required). Refile it as an open question
  when a need arises.
- Non-JS clients connect using each language's WebSocket library plus a Channels
  V2 frame implementation (see the library status above).

## Consequences

### Positive

- The server implementation is minimal (Channels reconnection, heartbeat, PubSub
  integration, and Presence can be used as-is).
- There is one specification, and the public protocol document only needs a
  reference to the official guide and event definitions.
- The reference dashboard (ADR-0007) and external clients use the same path, so
  conformance verification works directly.

### Negative

- For a Lua (neovim) client, writing the WebSocket layer and Channels framing is
  unavoidable (the WS-layer burden would be equivalent with the plain WS
  option).
- A Python client requires writing and maintaining a small Channels V2 client.

### Neutral

- The wire-protocol version is carried by Phoenix-side serializer version
  negotiation (`vsn`). Versioning of the kaoiro envelope itself is settled in
  [ADR-0010](0010-protocol-precisification.md).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Channels (for the included client) + plain WS alongside it (two paths) | Maintenance burden of two specifications. The plain WS side would require reinventing the lifecycle specification. The investigation found almost no reduction in burden for non-JS clients |
| Plain WebSocket only | Reimplements Phoenix reconnection, Presence, and PubSub integration. It would reinvent equivalents of join_ref/ref/topic/heartbeat, offering no advantage over Channels |
| Read-only SSE alongside it | No maintained library on the Elixir side (handwritten implementation required). Deferred because demand is unconfirmed; refile when needed |
