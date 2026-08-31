---
title: The wrapper runs locally, with WebSocket connecting to the central server
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [1, 11, 23, 29]
---

# ADR-0002 — The Wrapper Runs Locally, with WebSocket Connecting to the Central Server

## Status

Accepted

## Context

Where to run the wrapper and how to connect it to the server was a problem. The
wrapper hosts the Agent SDK and is therefore non-Elixir (TS;
[ADR-0001](0001-agent-sdk-integration.md)), and it also needs to reside with the
agent in order to spawn and observe it. An architecture spanning multiple
hosts/processes is also required.

## Decision

The wrapper runs **locally** alongside each agent. Multiple hosts/processes
connect to the central server (Elixir) via **Phoenix Channels** (WebSocket). The
server keeps and distributes the latest state with one GenServer per connection.

> **Addendum ([ADR-0023](0023-host-runner-architecture.md))**: This topology
> (the wrapper's direct connection to the server) is maintained, while one
> resident runner is placed on each host as a supervision layer responsible for
> lifecycle management such as wrapper spawn / supervision / host registration.
> The runner does not terminate the data path; the wrapper remains directly
> connected (the direct connection is unchanged). This ADR has not been
> superseded and remains accepted.

## Consequences

### Positive

- The wrapper can observe the agent directly on the local machine, making the
  distributed model natural.
- It is consistent with a non-Elixir (TS) wrapper. Crossing firewalls and
  authentication are easier.
- The server side can use OTP monitoring and PubSub.

### Negative

- Because public deployment is assumed, token authentication + TLS + a
  heartbeat are required for each wrapper.
- The `disconnected` state representing a broken connection must be managed.

### Neutral

- Client ↔ server user authentication is a separate layer
  ([ADR-0005](0005-access-control-oauth-stub.md)).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Distributed Erlang (BEAM on every host + shared cookie) | Coupling is too strong and it is inconsistent with non-Elixir wrappers |
| Running the wrapper alongside the server | It does not work when the agent is on another host |
