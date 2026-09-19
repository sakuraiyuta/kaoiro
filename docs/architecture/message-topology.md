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
[extensions](extensions.md).

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
- [Permission requests](../reference/protocol/permission-requests.md).
- [Permission state](../reference/protocol/permission-state.md).
- [Permission synchronization and audit](../reference/protocol/permission-sync-audit.md).
- [Permission control (two-axis model)](security-boundaries.md#permission-control-two-axis-model).
- [Model and effort state](../reference/protocol/model-effort.md).
- [Session capabilities](../reference/protocol/capabilities.md).
- [Session capability advertisement](extensions.md#session-capability-advertisement).
- [Session lifecycle](../reference/protocol/session-lifecycle.md).
- [State machine](../reference/protocol/state-machine.md).
- [Session ownership and continuity](system-overview.md#session-ownership-and-continuity).
- [Attachments](attachments.md).
- [Attachment wire contract](../reference/protocol/attachments.md).
- [Attachment rendering by engine](../reference/engines/attachment-rendering.md).
