---
title: Client connection is single to Channel Channels
status: accepted
date: 2026-06-11
opened: 2026-06-10
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [7, 10, 25]
---

# ADR 9 — Client connection singles to   Channels

## Status

Accepted

## Context

Clients have determined separation and public protocol documentation
([ADR。7] (0007-client-separation-reference-dashboard.md)). connectionapproach
Channel Channels or WebSocket with read-only SSE
Channels is natural in the included reference dashboard (TS),
Channels to non-JS clients (neovim plugin = Lua, terminal CUI, etc.)
It was a concern that the wire protocol implementation burden could occur (issue #11).

2026-06 Survey revealed:

- Channels wire protocol V2 (`[join_ref, ref, topic, event, payload]`)
5   array, `?vsn=2.0.0` when connecting
  [Writing a Channels Client](https://hexdocs.pm/phoenix/writing_a_channels_client.html)
Since the introduction ofen 1.3/1.4
Unchanged to 1.8 system. Added dependencies for internal implementation.
- Supabase Realtime documents the same protocol as the public API,
There is an example of establishing a multilingual client.
- Non-JS language client library (as of 2026-06):
C# is [PhoenixSha ](https://github.com/Mazyod/PhoenixSha )(active・V2),
Go is [nshafer/phx](https://github.com/nshafer/phx)(V2/maintenance),
Rust
  [liveview-native/phoenix-channels-client](https://github.com/liveview-native/phoenix-channels-client)
(Current V2, crates.io git dependencies). Python maintained V2
`websockets` Lua(neovim)
The WebSocket layer itself is not standard.
- Determination: Lua's burden body is WebSocket layer (RFC 6455 client net Lua
Home**WebSocket**Home WS
Design the specification of reconnection, heartbeat, request, response correlation (ref), and topic subscription
and reinvent the channels lifecycle.

## Decision

- Client Connection**Channel Channels**WebSocket
There is no endpoint.
- Wire format**V2 serializer fixed**`vsn=2.0.0`
kaoiro public protocol document ([protocol](../specs/protocol.md))
Refer to the guide + describe the unique topic/event definition.
- Read-only SSE****(No library maintained onixxir side)
for handwriting). re-issued as open-question when required occurs.
- Non-JS client is a WebSocket library + Channels V2 frame for each language
Connection by implementation (see the above library).

## Consequences

### Positive

- Minimum server implementation (Channels reconnection, heartbeat, PubSub integration, and Presence)
It can be used as it is.
- One specification, public protocol document only with official guide reference + event definition

- The reference dashboard (ADR-00Clients and ex  clients pass the same route,
It acts as it is conformity verification.

### Negative

- Lua(neovim) client is a webSocket layer + channels self-made
Determine (but the WS layer is equivalent).
- The Python client is required to create and maintain a small channel V2 client.

### Neutral

- Wire protocol version negotiates the serial side serializer version
(`vsn`) kaoiro Envel  itself
[ADR-0010](0010-protocol-precisification.md)

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Channels (included) + WS WS (2 routes)|Specifications 2 system maintenance burden. Lifecycle specification reinvention is required on the WS side. There is almost no impact on non-JS clients|
|WebSocket only|Reconnection・Presence・PubSub integration join ref/ref/topic/heartbeat|
|Read-only SSE|There is no library on theJapanese termxir side. If the demand is unconfirmed, re-issued when required|
