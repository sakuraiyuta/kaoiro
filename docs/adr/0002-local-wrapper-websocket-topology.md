---
title: The wrapper is local, WebSocket is centralized
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [1, 11, 23, 29]
---

# ADR 2 — wrappers are local, WebSocket is centralized

## Status

Accepted

## Context

It was a problem where the wrapper was moved and how to connect with it. Agent SDK
non-TSxir(TS,[ADR-0001](0001-agent-sdk-integration.md))
Yes, and there is a need to accompany the agent for the convenience of spawn and observation.
Multiple hosts and programs are required.

## Decision

The wrapper is the same as each agent**Local operation**Home Multiple host/process
**Phoenix Channels**(WebSocket) connects to the center ofixxir. server
1connection=1 Keep and deliver the latest state in GenServer.

> **INK0**: wrapper [0023-host-runner-architecture](0023-host-runner-architecture.md)
> Directly connected to the server) sets one wrapper resident on each host and wrappers
> spawn / Supervisor / Host registration etc.
> wrapper does not end the data path, and the wrapper continues to be connected directly. Book ADR
> is supersede.

## Consequences

### Positive

- The wrapper can directly observate the agent locally, and the distributed model is natural.
- Matching with non-TSxir(TS) wrapper. Easy to pass and verify s.
- The server side utilizes OTP monitoring and PubSub.

### Negative

-PetsーJapanese term authentication + TLS + heartbeat per wrapper is required for public premise.
- `disconnected` state management is required for connection disconnection.

### Neutral

- Client ↔ Server user authentication is separate layer
  ([ADR-0005](0005-access-control-oauth-stub.md)).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Distributed Erlang (All Hosts BEAM + Cookie Sharing)|Unmatched with non- xir wrappers|
|The wrapper is in the left|When the agent is another host, it is not established|
