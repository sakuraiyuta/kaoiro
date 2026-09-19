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

In addition to the general `task` rules, an agent's own todo is always the single entity
`{ agent_id, task_id: "tasklist", task_type: "tasklist" }`. The reserved word is bidirectional:
when `task_type` is `tasklist`, `task_id` must be `tasklist`, and vice versa.
The server rejects either mismatch. This prevents child task IDs from being used for this
entity and prevents child tasks from using the reserved ID.

The payload is `{ kind: "updated", status: "running", items, omitted? }`.
`items` is a whole-list snapshot of `{ text: string, status: "pending" | "in_progress" | "completed" }`,
with the latest snapshot replacing the whole list (LWW). Do not send `kind: "completed"`
when all items are complete. `items: []` is a valid replacement meaning that the current
todo is empty; retain the entity until its parent wrapper leaves. The dashboard must not
show a float for an empty list (avoiding a meaningless `0/0`), but must not delete the
entity from state.

The wrapper sends at most 50 items in source order, normalizing each `text` to at most
256 UTF-8 bytes and the `items` JSON to at most 16,384 bytes. If later source items exist,
it must include `omitted: { count, completed }`, so the operator can see that the detail is
partial and how many items are complete overall. The server defensively validates the same
limits and rejects violations; normal over-limit input is made displayable by wrapper normalization.

`tasklist` is outside the three-second/token/tool-name throttle used for child-task
`kind=updated`. Todo changes have no later token/tool signal to flush, so that throttle
could permanently lose updates. The wrapper de-duplicates only consecutive snapshots with
identical content and sends changed snapshots immediately. Claude Code's default source
since SDK 0.3.228 is the `TaskCreate`/`TaskUpdate`/`TaskList` tool triggers ([ADR-0049](../adr/0049-tasklist-on-task-envelope.md)
addendum); `TodoWrite`, which maps `content` and the three-valued status directly, remains
only the `CLAUDE_CODE_ENABLE_TASKS=0` compatibility fallback. `activeForm` is Claude-local UI text; the wire item
settled by ADR-0049 contains only text and status, so it is not sent. Showing it later
requires a protocol extension rather than an implicit field addition. Codex
`todo_list.completed: boolean` maps `false -> pending` and `true -> completed`.
Both cover only the parent thread's list. On socket reconnect, wrapper transport resends
active `task` entities with a fresh seq, so they can be restored even after the old channel
terminates and purges the server task table, without tasklist content de-duplication blocking it.
The resend cache is capped at `5,000` entities / JSON `6,000,000` bytes. This prevents
crashed/killed child tasks that never send `completed` from remaining forever; on overflow,
the least recently updated child entities leave the cache and the wrapper warns on stderr.
The parent `tasklist` snapshot is retained while any other eviction target exists. This is
a local-memory bound for reconnects, not a substitute for server-side TaskStates ingress/byte
bounds across multiple wrappers.

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

HTTP API resolving `persona.sprite_set` to images. [ADR-0008](../adr/0008-persona-asset-distribution.md)
initially covered sprites only; [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
expanded it on 2026-07-05 to persona-pack zip distribution, a server aggregate SoT, and
auto-watch. It is independent of Channels and not gated by `:serve_dashboard` (public API).
Asset layout and format are defined by [personas](personas.md); the pack schema is
[persona-pack-format](../reference/personas/pack-format.md).

- `GET /api/personas` — manifest JSON:

```json
{
  "version": "<16hex>",
  "personas": {
    "<sprite_set>": {
      "name": "<display name>",
      "pack_version": "<semver>",
      "description": "<optional 1-line>",
      "states": {
        "<state>": {
          "url": "/personas/<sprite_set>/<state>.png?v=<12hex>",
          "hash": "sha256:<64hex>"
        }
      }
    }
  }
}
```

- `version` is the aggregate version derived from asset contents; clients refetch sprite URLs
  only when it changes (incremental sync).
- `name` / `pack_version` / `description` come from the persona pack `manifest.json`
  ([persona-pack-format](../reference/personas/pack-format.md)). `personality.md` is not exposed by this API;
  it is pushed only during the WS wrapper handshake (see "Personality prompt delivery").
- Hashed `url` forms are immutable with `cache-control: public, max-age=31536000, immutable`;
  URLs without `?v=` are `no-cache`.
- Only files listed in the manifest are served; unknown paths return 404.
- A missing sprite falls back to the `idle` image. `disconnected` has no image (MUST NOT in
  personas.md) and is shown as grayscale idle. Missing manifests or unlisted sprite sets fall
  back to sprite-less rendering (CSS face in the reference implementation).
- **Auto-watch**: the server watches the intake directory with Elixir `FileSystem`, detects zip
  additions/updates/deletions, and rebuilds the manifest ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F6); no manual restart is needed.

### Personality prompt delivery (ADR-0029)

Under [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md), the personality
prompt is pushed from the server aggregate SoT (`personality.md` in the persona pack) to the
wrapper during the WS handshake.

- **Reject unknown persona.id at wrapper join**: when accepting `wrapper:<agent_id>`, the server
  checks the persona ID from the agent-token mapping against the manifest. IDs absent from the
  manifest are refused (enforcing no stray personas,
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F3).
- **after_join push**: server pushes the following message to the wrapper:

  | Direction | Type | Payload | Notes |
  |---|---|---|---|
  | server → wrapper | `persona_prompt` | `{ prompt }` | Sent once after wrapper join. `prompt` is persona-pack `personality.md` plus the server-joined common footer ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F5). The wrapper injects it unchanged with SDK `systemPrompt.append` ([persona-personality-injection](persona-personality-injection.md)); no hot-swap push occurs during the session (F9). |

- **Fail-closed when server is unreachable**: the wrapper cannot complete spawn until it
  receives `persona_prompt`, including dev/local operation where a minimal server runs in
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F10).

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
