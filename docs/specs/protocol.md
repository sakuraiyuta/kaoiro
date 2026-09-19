---
title: Common event protocol
description: Common event envelopes v0, state machines, and persona identity shared by wrapper, server, and client.
status: accepted
related: [architecture, plugin-model, claude-events, personas, security-threat-model, subagent-tasks, protocol-inter-agent]
---
<!-- markdownlint-disable MD033 -->

# Common event protocol (v0)

## Purpose

Moved to [Message topology](../architecture/message-topology.md#purpose).

## Definition

### Terms and hierarchy

Moved to [Envelope contract](../reference/protocol/envelope.md#terms-and-hierarchy).

### Design intent

Moved to [Message topology](../architecture/message-topology.md#design-intent).

### Envelope v0

Moved to [Envelope contract](../reference/protocol/envelope.md#envelope-v0).

#### Two-axis `ext.permission` (2026-07-10, [ADR-0033](../adr/0033-permission-model-dual-axis.md))

Moved to [Permission control](../architecture/security-boundaries.md#permission-control-two-axis-model) (design intent) and
[Permission state](../reference/protocol/permission-state.md#two-axis-extpermission-2026-07-10-adr-0033) (field contract).

#### `ext.engine` (2026-07-10, [ADR-0032](../adr/0032-codex-adapter.md) F4a)

Moved to [Envelope contract](../reference/protocol/envelope.md#extengine-2026-07-10-adr-0032-f4a).

#### `ext.model_source` / `ext.effort_source` (2026-07-11, [ADR-0032](../adr/0032-codex-adapter.md) F4bc addendum, phase 15)

Moved to [Model and effort state](../reference/protocol/model-effort.md#extmodel_source--exteffort_source-2026-07-11-adr-0032-f4bc-addendum-phase-15).

#### `ext.session_capabilities` (2026-07-11, [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F1/F2)

Moved to [Session capabilities](../reference/protocol/capabilities.md#extsession_capabilities-2026-07-11-adr-0034-f1f2).

#### `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift` (2026-07-11, [ADR-0032](../adr/0032-codex-adapter.md) F4bc + [ADR-0033](../adr/0033-permission-model-dual-axis.md) F4 addendum, phase 15)

Moved to [Model and effort state](../reference/protocol/model-effort.md#extresume_snapshot--exteffective--extresume_drift-2026-07-11-adr-0032-f4bc--adr-0033-f4-addendum-phase-15).

#### `ext.pending_model` / `ext.pending_effort` / `ext.switch_error` / `ext.effort_reset` (2026-07-13, [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) F1–F3, phase 16)

Moved to [Model and effort state](../reference/protocol/model-effort.md#extpending_model--extpending_effort--extswitch_error--exteffort_reset-2026-07-13-adr-0035-f1f3-phase-16).

### Permission changes at an execution boundary

Moved to [Permission requests](../reference/protocol/permission-requests.md#permission-changes-at-an-execution-boundary).

#### Request, relay, and acknowledgement

Moved to [Permission requests](../reference/protocol/permission-requests.md#request-relay-and-acknowledgement).

#### Requested, submitted, and effective state

Moved to [Permission state](../reference/protocol/permission-state.md#requested-submitted-and-effective-state).

#### Persistence, join synchronization, and resume

Moved to [Permission synchronization and audit](../reference/protocol/permission-sync-audit.md#persistence-join-synchronization-and-resume).

#### Permission lifecycle audit

Moved to [Permission synchronization and audit](../reference/protocol/permission-sync-audit.md#permission-lifecycle-audit).

### Types and payload (v0 settled)

Moved to [Event types and payloads](../reference/protocol/events.md#types-and-payload-v0-settled).

#### Wrapper-owned stderr error diagnostics

Moved to [Event types and payloads](../reference/protocol/events.md#wrapper-owned-stderr-error-diagnostics).

### `task_type: "tasklist"` addendum (issue #178, ADR-0049 F4)

Moved to [Task and tasklist envelopes](../reference/protocol/tasks.md#task_type-tasklist-addendum-issue-178-adr-0049-f4).

### Directional message types (v0 settled)

Moved to [Channels and directional messages](../reference/protocol/channels.md#directional-message-types-v0-settled).

### Planned wrapper cycle (issue #256)

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#planned-wrapper-cycle-issue-256).

#### Projection hydration and restart resilience ([ADR-0051](../adr/0051-history-restart-resilience.md))

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#projection-hydration-and-restart-resilience-adr-0051).

### Session visibility semantics (#106 / ADR-0036 F3 restoration, 2026-07-24)

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#session-visibility-semantics-106--adr-0036-f3-restoration-2026-07-24).

### File-upload wire

Moved to [Attachment wire contract](../reference/protocol/attachments.md#file-upload-wire).

### Session resume and restoration

Moved to [Session ownership and continuity](../architecture/system-overview.md#session-ownership-and-continuity) (design intent) and
[Session lifecycle](../reference/protocol/session-lifecycle.md#session-resume-and-restoration) (field contract).

### Runner control messages (v0 settled, [#66](https://github.com/sakuraiyuta/kaoiro/issues/66))

Moved to [Runner control and launch](../reference/protocol/runner-control.md#runner-control-messages-v0-settled-66).

### WrapperConfig fields relayed by the runner (issues #181 and #292)

Moved to [Wrapper configuration](../reference/configuration/wrapper.md#wrapperconfig-fields-relayed-by-the-runner-issues-181-and-292).

### Client → server launch control (#22, [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))

Moved to [Runner control and launch](../reference/protocol/runner-control.md#client--server-launch-control-22-adr-0024).

### Versioning policy

Moved to [Versioning policy](../reference/protocol/versioning.md#versioning-policy).

### Version inventory (issue #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#version-inventory-issue-208).

#### Client → server (stage 1, completed in #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#client--server-stage-1-completed-in-208).

#### Server → wrapper (stage 1, completed in #208)

Moved to [Versioning policy](../reference/protocol/versioning.md#server--wrapper-stage-1-completed-in-208).

#### Server → runner (stage 1, completed in issues #171/#172)

Moved to [Versioning policy](../reference/protocol/versioning.md#server--runner-stage-1-completed-in-issues-171172).

#### Runner → server (complete; outside #208 scope)

Moved to [Versioning policy](../reference/protocol/versioning.md#runner--server-complete-outside-208-scope).

#### Wrapper → server (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

Moved to [Versioning policy](../reference/protocol/versioning.md#wrapper--server-stage-2-completed-in-issue-260-wrapper-identity-in-issue-288-stage-3).

#### Server → client (stage 2, completed in issue #260; wrapper identity in issue #288 Stage 3)

Moved to [Versioning policy](../reference/protocol/versioning.md#server--client-stage-2-completed-in-issue-260-wrapper-identity-in-issue-288-stage-3).

#### Permanent carve-out — `attach_chunk`

Moved to [Versioning policy](../reference/protocol/versioning.md#permanent-carve-out--attach_chunk).

#### Receiver validation

Moved to [Versioning policy](../reference/protocol/versioning.md#receiver-validation).

#### Non-map payload handling

Moved to [Versioning policy](../reference/protocol/versioning.md#non-map-payload-handling).

### Identity and persona (must)

Moved to [Session lifecycle](../reference/protocol/session-lifecycle.md#identity-and-persona-must).

### State-machine state set v0 (draft)

Moved to [State machine](../reference/protocol/state-machine.md#state-machine-state-set-v0-draft).

### Persona asset distribution

Moved to [Persona delivery](../reference/protocol/persona-delivery.md#persona-asset-distribution).

### Personality prompt delivery (ADR-0029)

Moved to [Persona delivery](../reference/protocol/persona-delivery.md#personality-prompt-delivery-adr-0029).

### Client transport

Moved to [Channels and directional messages](../reference/protocol/channels.md#client-transport).

### Connection authentication (v0 settled, [ADR-0011](../adr/0011-phase3-reliability-and-auth.md))

Moved to [Authentication and authorization](../reference/security/authentication-authorization.md#connection-authentication-v0-settled-adr-0011).

## Constraints

- MUST: `agent_id` is stable. MUST: state derivation is wrapper-side.
- MUST: `agent_id` uses `[A-Za-z0-9._-]`, 1–256 characters.
- MUST: client connections use only Phoenix Channels (`vsn=2.0.0`).
- MUST: receivers ignore unknown envelope keys (forward compatibility).
- MUST: `instruction` / `permission_decision` / `interrupt` are operator-only.
- MUST: permission waits are **unlimited** by default, matching the SDK (Promise remains
  pending). Finite timeout is wrapper opt-in and then fails closed with deny ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md), issue #60).
- MUST: while `waiting_permission`, pending state persists in `state_change.ext.pending_permission`,
  the authoritative source; `permission_request` is only the initial notification
  ([ADR-0022](../adr/0022-pending-permission-authoritative-source.md)).
- MUST: `log` / `result` envelopes are delivered only to operator role ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)).
- MUST: `agents:lobby` uses an **allow-list**. Viewers receive only `state_change` (with `ext`
  removed) and `agent_deleted`; all other events/types are removed ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)).
  `permission_request` is replaced for viewers by synthetic `state_change(waiting_permission)` to keep the grid consistent.
- MUST: file-upload operations (`attach_open` / `attach_chunk` / `attach_close` /
  `attach_rejected` / `instruction_rejected` / `instruction.attachment_ids`) are **operator-only**
  for both delivery and acceptance ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) /
  [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)).
- MUST: the server neither interprets nor persists upload bytes; it transparently relays them
  without disk access ([ADR-0020](../adr/0020-dashboard-battery-included-client.md) F3).
- MUST: attachment rendering (image/document/text block choice and Office conversion) is
  **wrapper-internal**. Protocol, client, and server do not use Anthropic API terms
  ([attachment rendering by engine](../reference/engines/attachment-rendering.md), [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F1).

## Open Questions

None; protocol reliability was settled by [ADR-0011](../adr/0011-phase3-reliability-and-auth.md).

## See Also

- Related specs: [architecture](../architecture/system-overview.md),
  [extensions](../architecture/extensions.md), [personas](personas.md),
  [subagent-tasks](subagent-tasks.md),
  [attachments](../architecture/attachments.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
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
