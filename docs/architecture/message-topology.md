---
title: Message topology
status: accepted
last_updated: 2026-09-19
description: Why the common envelope has the shape it does, and the design intent behind its outer/payload split.
---

# Message topology

## Purpose

Define the **outer envelope** for common events exchanged among wrapper, server,
and client. This is a **living specification** whose details are refined by
phase rather than frozen all at once. The insertion boundary is described in
[plugin-model](../specs/plugin-model.md).

For the envelope's terms, outer frame keys, and wire shape, see
[Envelope contract](../reference/protocol/envelope.md#terms-and-hierarchy).

### Design intent

- The envelope is the boundary where adapters and filters plug in; fixing the
  outer shape early makes extension easier.
- Filters touch only `payload` / `ext` and should not depend heavily on outer
  keys.
- The wrapper (adapter) **derives** state and sends a confirmed `state`; the
  server only retains and delivers that value (agent-independent).

## Related protocol topics

- [Envelope contract](../reference/protocol/envelope.md).
- [Event types and payloads](../reference/protocol/events.md).
- [Channels and directional messages](../reference/protocol/channels.md).
- [Versioning policy](../reference/protocol/versioning.md).
