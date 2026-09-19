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

Moved: `agent_id` stability / state-derivation-is-wrapper-side to
[System overview](../architecture/system-overview.md#constraints); `agent_id`
charset to [Envelope contract](../reference/protocol/envelope.md#constraints);
unlimited permission-wait default to
[Tool authorization](../reference/security/tool-authorization.md#constraints-must);
`log`/`result` operator-only to
[Authentication and authorization](../reference/security/authentication-authorization.md#constraints-must);
file-upload operator-only (delivery and acceptance) to
[Attachment wire contract](../reference/protocol/attachments.md#constraints);
attachment-rendering wrapper-internal (ADR-0025 F1) to
[Attachment rendering by engine](../reference/engines/attachment-rendering.md#constraints).

The remaining bullets (Phoenix Channels transport constraint, unknown-key
forward compatibility, `instruction`/`permission_decision`/`interrupt`
operator-only, `state_change.ext.pending_permission` as the authoritative
pending-permission source, `agents:lobby` allow-list, and server
non-persistence of upload bytes) were already covered verbatim and are not
duplicated here — see
[Channels and directional messages](../reference/protocol/channels.md#client-transport),
[Versioning policy](../reference/protocol/versioning.md),
[Authentication and authorization](../reference/security/authentication-authorization.md#operator-only-inbound-handle_in)
and its
[Role-based output gate](../reference/security/authentication-authorization.md#role-based-output-gate-adr-0021),
[Event types and payloads](../reference/protocol/events.md#types-and-payload-v0-settled)
and [Envelope contract](../reference/protocol/envelope.md#terms-and-hierarchy),
and [Attachment wire contract](../reference/protocol/attachments.md#constraints)
respectively.

## Open Questions

Moved to [Message topology](../architecture/message-topology.md#open-questions).

## See Also

Moved to [Message topology](../architecture/message-topology.md#related-protocol-topics)
and its [ADRs](../architecture/message-topology.md#adrs) list.
