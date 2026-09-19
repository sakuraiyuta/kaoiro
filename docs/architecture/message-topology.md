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
- [Runner control and launch](../reference/protocol/runner-control.md).
- [Wrapper configuration](../reference/configuration/wrapper.md).
- [Task and tasklist envelopes](../reference/protocol/tasks.md).
- [Subagent visibility](subagent-visibility.md).
- [Persona delivery](../reference/protocol/persona-delivery.md).
- [Personality-prompt injection](personality-injection.md).
- [personas](../specs/personas.md).

### ADRs

[0001](../adr/0001-agent-sdk-integration.md),
[0003](../adr/0003-persona-identity-persistence.md),
[0008](../adr/0008-persona-asset-distribution.md),
[0009](../adr/0009-client-transport.md),
[0010](../adr/0010-protocol-precisification.md),
[0011](../adr/0011-phase3-reliability-and-auth.md),
[0012](../adr/0012-response-display-and-dashboard-scope.md),
[0014](../adr/0014-session-resume-and-restore.md),
[0015](../adr/0015-protocol-version-stamping.md),
[0016](../adr/0016-error-body-relay.md),
[0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md),
[0021](../adr/0021-role-information-disclosure-policy.md),
[0022](../adr/0022-pending-permission-authoritative-source.md),
[0023](../adr/0023-host-runner-architecture.md),
[0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)

## Open Questions

None; protocol reliability was settled by [ADR-0011](../adr/0011-phase3-reliability-and-auth.md).
