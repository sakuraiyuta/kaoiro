---
title: Inter-agent messaging protocol
description: Envelope schema, nine kinds, hard limits, routing, and observation paths for direct interaction between multiple AI agents through the kaoiro server.
status: provisional
last_updated: 2026-09-18
related: [protocol, subagent-tasks, plugin-model, security-threat-model]
---
<!-- markdownlint-disable MD033 -->

# Inter-agent messaging protocol

## Purpose

Moved to [Inter-agent messaging](../architecture/inter-agent-messaging.md#purpose).

## Dispatch-confirmation ledger (issue #237)

Moved to [Inter-agent delivery](../reference/inter-agent/delivery.md#dispatch-confirmation-ledger-issue-237).

### Negotiated gap recovery

Moved to [Inter-agent delivery](../reference/inter-agent/delivery.md#negotiated-gap-recovery).

## Review-quagmire detection (issue #273)

Moved to [Design rationale](../architecture/coordination-monitoring.md#review-quagmire-detection-issue-273).

### Rally

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#rally).

### Stall

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#stall) and [Design rationale](../architecture/coordination-monitoring.md#stall-interpretation).

### Wire

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#wire).

### Configuration

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#configuration) and [Design rationale](../architecture/coordination-monitoring.md#provisional-defaults).

### Deliberate omissions

Moved to [Design rationale](../architecture/coordination-monitoring.md#deliberate-omissions).

## Definition

### Overview

Moved to [Inter-agent messaging](../architecture/inter-agent-messaging.md#overview).

### envelope.type: "inter_agent_message"

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#envelopetype-inter_agent_message).

### Inner envelope(`payload` schema)

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#inner-envelopepayload-schema).

### kind enum (nine values)

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#kind-enum-nine-values).

### Conversation owner and tie-breaker

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#conversation-owner-and-tie-breaker).

### Hard limits (config + mechanical enforcement)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#hard-limits-config--mechanical-enforcement).

### Memory-reclamation TTL (config, not a hard limit)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#memory-reclamation-ttl-config-not-a-hard-limit).

### Conversation lifecycle and post-close handling (issue #167)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#conversation-lifecycle-and-post-close-handling-issue-167).

#### CID reuse is not a contract (issue #167 review S2)

Moved to [Inter-agent conversation contract](../reference/inter-agent/conversations.md#cid-reuse-is-not-a-contract-issue-167-review-s2).

### Explicitly supplied unknown conversation_id (issue #252)

Moved to [Inter-agent conversation admission](../reference/inter-agent/conversation-admission.md#explicitly-supplied-unknown-conversation_id-issue-252).

### Observation path (dashboard display)

Moved to [Exact contract](../reference/inter-agent/coordination-monitoring.md#observation-path-dashboard-display).

### IA sidecar and display restoration ([ADR-0051](../adr/0051-history-restart-resilience.md))

Moved to [IA sidecar and display restoration](../reference/storage/inter-agent-sidecar.md#ia-sidecar-and-display-restoration-adr-0051).

### Channel event additions

Moved to [Channel event additions](../reference/inter-agent/directory.md#channel-event-additions).

#### Peer-directory information boundary (#99 / #150)

Moved to [Peer-directory information boundary (#99 / #150)](../reference/inter-agent/directory.md#peer-directory-information-boundary-99--150).

##### Exposed fields

Moved to [Exposed fields](../reference/inter-agent/directory.md#exposed-fields).

##### Directory-only entry (issue #259)

Moved to [Directory-only entry (issue #259)](../reference/inter-agent/directory.md#directory-only-entry-issue-259).

##### `context` capability gate

Moved to [`context` capability gate](../reference/inter-agent/directory.md#context-capability-gate).

##### Projection from `ext`

Moved to [Projection from `ext`](../reference/inter-agent/directory.md#projection-from-ext).

##### Always include `conversation`

Moved to [Always include `conversation`](../reference/inter-agent/directory.md#always-include-conversation).

##### Omit session fields for uncorrelated connections

Moved to [Omit session fields for uncorrelated connections](../reference/inter-agent/directory.md#omit-session-fields-for-uncorrelated-connections).

##### Persistent exclusions

Moved to [Persistent exclusions](../reference/inter-agent/directory.md#persistent-exclusions).

##### Exposed user fields (issue #187 phase 2, ADR-0021 F6-8)

Moved to [Exposed user fields (issue #187 phase 2, ADR-0021 F6-8)](../reference/inter-agent/directory.md#exposed-user-fields-issue-187-phase-2-adr-0021-f6-8).

##### Meaning of a live role join

Moved to [Meaning of a live role join](../reference/inter-agent/directory.md#meaning-of-a-live-role-join).

##### User backward compatibility (issue #187 phase 2)

Moved to [User backward compatibility (issue #187 phase 2)](../reference/inter-agent/directory.md#user-backward-compatibility-issue-187-phase-2), [Event contracts](../reference/inter-agent/directory.md#event-contracts), [Send acceptance and rejection](../reference/inter-agent/send-and-wait.md#send-acceptance-and-rejection).

### Approval flow (permission_broker integration)

Moved to [Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration).

#### Automatic approval (conversation-scoped whitelist, ADR-0044 F2 addendum, option B)

Moved to [Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md#automatic-approval-conversation-scoped-whitelist-adr-0044-f2-addendum-option-b).

### Receiver-side behavior (wrapper-B)

Moved to [Send and wait](../reference/inter-agent/send-and-wait.md#receiver-side-behavior-wrapper-b).

#### Coalescing pending messages (issue #211 phase 3)

Moved to [Send and wait](../reference/inter-agent/send-and-wait.md#coalescing-pending-messages-issue-211-phase-3). The batching structure and purpose are in
[Dispatch and coalescing](../architecture/inter-agent-messaging.md#dispatch-and-coalescing);
the send-and-wait reference holds the trigger, ordering, limits, and failure contract.

#### Synchronous reply wait (`send_to_agent.wait_for_response`)

Moved to [Send and wait](../reference/inter-agent/send-and-wait.md#synchronous-reply-wait-send_to_agentwait_for_response).

### Unresponsive notices (`payload.error`)

Moved to [Unresponsive notices](../reference/inter-agent/errors.md#unresponsive-notices-payloaderror).

#### Error codes (initial set)

Moved to [Error codes](../reference/inter-agent/errors.md#error-codes-initial-set).

#### Sources (four paths)

Moved to [Sources](../reference/inter-agent/errors.md#sources-four-paths).

#### `stale_turn` notice structure (issue #212 defect 3)

Moved to [`stale_turn` notice structure](../reference/inter-agent/errors.md#stale_turn-notice-structure-issue-212-defect-3).

#### Server-synthesized (`reconnecting` / `reconnected` / `disconnected`) rules

Moved to [Server-synthesized rules](../reference/inter-agent/errors.md#server-synthesized-reconnecting--reconnected--disconnected-rules).

#### Receiver handling

Moved to [Receiver handling](../reference/inter-agent/errors.md#receiver-handling).
### Companion tools (wrapper SDK MCP)

Moved to [Companion tools (wrapper SDK MCP)](../reference/inter-agent/directory.md#companion-tools-wrapper-sdk-mcp).

#### Session operation tool — `request_compact` (phase-28 B2)

Moved to [Session operation tool — `request_compact`](../reference/inter-agent/session-tools.md#session-operation-tool--request_compact-phase-28-b2).

#### Threshold notice (phase-28 B1)

Moved to [Threshold notice](../reference/inter-agent/session-tools.md#threshold-notice-phase-28-b1).

#### `request_session_reset` (phase-28 C2)

Moved to [`request_session_reset`](../reference/inter-agent/session-tools.md#request_session_reset-phase-28-c2).

#### Destination-resolution guidance

Moved to [Destination-resolution guidance](../contributing/peer-routing.md#destination-resolution-guidance).

### Reserved `envelope.type` and version

Moved to [Inter-agent message contract](../reference/inter-agent/messages.md#reserved-envelopetype-and-version).

## Constraints

- MUST: The server must not interpret payload semantics (`kind` / `body` /
  `meta`); it may read only `to` for routing. Carve-out (issue #127): validate
  `payload.error` structurally (`code` non-empty string, `message` string) but
  do not interpret values. The server may synthesize `reconnecting` or
  `disconnected` envelopes on wrapper disconnect and an error-free `reconnected`
  inform after exact-token planned recovery; these are minimal structural hooks
  for observability, not semantic interpretation.
- MUST: An envelope with `payload.error` still uses one of the nine kinds;
  unresponsive notices use `inform`.
- MUST: Do not count server-synthesized error notices in turns or tokens.
- MUST: Deliver `inter_agent_message` envelopes **to operators only**
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md)); remove them
  entirely for viewers.
- MUST: In Phase 1 every `send_to_agent` call goes through per-call
  `permission_broker` approval (effect depends on permission mode; auto modes
  include approval). Do not add kaoiro autonomous approval skipping before
  Phase 3.
- MUST: Enforce config hard limits (`max_turns`, `max_tokens`,
  `max_concurrent_agents`) mechanically. Issue #211 removed old
  `max_wallclock` as a hard limit.
- MUST: A conversation completes only when both owner-side agents send
  `meta.done=true`; one side alone is not done.
- MUST (issue #167): Retain a conversation closed by both done flags, a hard
  limit, or `open_conversation_ttl_ms` (issue #211, GC only) as a tombstone
  until `tombstone_ttl_ms` expires. While closed, do not relay, store, or
  broadcast sends for that conversation; reject them with
  `{:error, :conversation_closed}`. Discard counters (turns/tokens/started_at/
  done_by) at closure and never reset them on retry.
- MUST (issue #167): Closed conversations are inactive in `peer_index` and in
  disconnect unresponsive notices.
- MUST: Reject self-routing where `payload.to == agent_id`.
- MUST: A `kind: "reject"` envelope carries a non-empty string
  `meta.reject_reason`.
- MUST: Accept only agent IDs in `send_to_agent.to` (charset constrained).
  Resolve persona names through the wrapper `list_agents` tool and ask the
  operator when ambiguous.
- MUST: The peer directory is an **allow-list**. Expose only fields explicitly
  listed by `directory_entry`; never pass `ext` through. Apply the allow-list at
  nested levels and construct a new map of canonical keys
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6-2 and
  [“Projection from `ext`”](../reference/inter-agent/directory.md#projection-from-ext)).
- MUST (issue #187 phase 2): Apply the same allow-list discipline to `users`
  ([ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6-8). Build literal maps with per-value validation; do not use a
  `Map.take/2`-style key-only filter that bypasses shape checks. Omit an entire
  user entry when its role cannot be resolved.
- MUST (issue #187 phase 2): Expose users by default—unset
  `KAOIRO_EXPOSE_USERS_TO_AGENTS` means open, explicit `false` opts out. A
  closed read-site fallback is only for the abnormal case where the config key
  itself is missing, not normal boot.
- MUST: Project `context` only when
  `ext.session_capabilities.supports_context_usage == true`; with absent or
  explicit false capability omit each field and emit neither `null` nor an
  inferred value ([ADR-0040](../adr/0040-context-usage-capability.md)).
- MUST: For `rate_limits` windows, accept absence only when the key is missing;
  if present with an invalid value (including `null`), drop that window. Drop
  windows left empty after projection.
- MUST: Server and wrapper apply **identical projection rules and limits**; a
  looser side must not reopen data closed by the other.
- MUST: Return `{"active": false, "peers": []}` even without a conversation;
  never disclose `conversation_id`.
- MUST: `session_started_at` and `last_activity_at` are **server-observed
  timestamps**, not wrapper measurements or envelope `ts`.
- MUST: A `list_agents` consumer compares `rate_limits.resets_at` (Unix seconds)
  with current time and, after expiry, does not trust that window's
  `utilization` or `status`. Snapshots come from the peer's last turn and do
  not update while idle. This is a best-effort model convention, not a
  deterministic server/wrapper enforcement; dashboard parity is tracked in
  [#154](https://github.com/sakuraiyuta/kaoiro/issues/154).
- MUST: An omitted field means **unknown**, never zero, healthy, or unlimited.
- SHOULD: Allocate `conversation_id` values from UUIDv4 for collision
  resistance and easy grouping.
- SHOULD: Truncate `body` at 16 KB on the wrapper like other protocol fields and
  set `meta.truncated=true`.

## Open Questions

- Conversation persistence (whether conversation_id survives a server restart
  and how it connects to Phase 4 / ADR-0014) — settle in Phase 2.
- Insertion point for the message filter (kaoiro issue #18) — begin review in
  Phase 2.
- Automatic escalation when starting an `owner.kind: "agent"` conversation —
  pending Phase 3 / kaoiro issue #87.

## See Also

- Related specs: [protocol](protocol.md) (common envelope foundation),
  [tasks](../reference/protocol/tasks.md) (similar reserved-type patterns),
  [extensions](../architecture/extensions.md) (future filter insertion point), and
  [threat-model](../architecture/security-threat-model.md) (basis for operator-only delivery).
- Related plans: [phase-8-inter-agent-messaging](../plans/phase-8-inter-agent-messaging.md)
  and [phase-27-list-agents-metadata](../plans/phase-27-list-agents-metadata.md)
  (six peer-directory liveness fields).
- ADRs: [0010 protocol-precisification](../adr/0010-protocol-precisification.md),
  [0015 protocol-version-stamping](../adr/0015-protocol-version-stamping.md),
  [0021 role-information-disclosure-policy](../adr/0021-role-information-disclosure-policy.md)
  (F6 = allow-list for agent disclosure, F6-8 = user disclosure allow-set),
  [0022 pending-permission-authoritative-source](../adr/0022-pending-permission-authoritative-source.md),
  [0040 context-usage-capability](../adr/0040-context-usage-capability.md)
  (the `context` capability gate),
  [0050 principal-model-and-graded-access-control](../adr/0050-principal-model-and-graded-access-control.md)
  (D5 = identity disclosure policy)
- kaoiro issues #17 (implementation origin), #18 (message filter), #87
  (umbrella investigation), #127 (unresponsive notices), #150
  (peer-directory liveness), #154 (rate-limit display defect), #167
  (conversation lifecycle, tombstone, stale-turn rejection), and #187 (user
  disclosure, phase 2).
