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

Moved: server payload-non-interpretation (with the issue #127 `payload.error`
carve-out) and the 16 KB `body`-truncation SHOULD to
[Inter-agent message contract](../reference/inter-agent/messages.md#constraints);
server-synthesized error notices excluded from turn/token counts to
[Inter-agent conversation contract](../reference/inter-agent/conversations.md#hard-limits-config--mechanical-enforcement);
closed conversations inactive in `peer_index` to
[Peer directory](../reference/inter-agent/directory.md#peer-directory-information-boundary-99--150);
self-routing rejection to
[Send and wait](../reference/inter-agent/send-and-wait.md#send-acceptance-and-rejection).

The remaining bullets were already covered verbatim and are not duplicated
here: `payload.error` still uses one of the nine kinds / unresponsive notices
use `inform` ([Inter-agent error notices](../reference/inter-agent/errors.md#server-synthesized-reconnecting--reconnected--disconnected-rules));
`inter_agent_message` operator-only delivery
([Authentication and authorization](../reference/security/authentication-authorization.md#role-based-output-gate-adr-0021));
hard limits (`max_turns`/`max_tokens`/`max_concurrent_agents`, `max_wallclock`
removal) and both-owner-`done`/tombstone closure
([Inter-agent conversation contract](../reference/inter-agent/conversations.md#hard-limits-config--mechanical-enforcement)
and its [Conversation lifecycle](../reference/inter-agent/conversations.md#conversation-lifecycle-and-post-close-handling-issue-167));
`kind: "reject"` requires `meta.reject_reason`
([Inter-agent message contract](../reference/inter-agent/messages.md#kind-enum-nine-values));
`send_to_agent.to` accepts only agent IDs, resolved via `list_agents`
([Peer routing](../contributing/peer-routing.md#destination-resolution-guidance));
the peer-directory allow-list, the `users` allow-list discipline, and the
`KAOIRO_EXPOSE_USERS_TO_AGENTS` default, the `context` projection gate, the
`rate_limits` window absence/invalid-value rule, and `session_started_at`/
`last_activity_at` being server-observed timestamps (all in
[Peer directory](../reference/inter-agent/directory.md#peer-directory-information-boundary-99--150));
`rate_limits.resets_at` comparison by `list_agents` consumers and the general
"absent = unknown" convention
([Peer directory](../reference/inter-agent/directory.md#companion-tools-wrapper-sdk-mcp));
and `conversation_id` allocation from UUIDv4
([Inter-agent message contract](../reference/inter-agent/messages.md#inner-envelopepayload-schema)).

**Sync note (not moved, flagged for director review):** the Phase-1
per-call-approval bullet's "Do not add kaoiro autonomous approval skipping
before Phase 3" clause is stale — a conversation-scoped auto-approval
whitelist is already implemented under specific conditions
([Inter-agent tool authorization](../reference/security/inter-agent-tool-authorization.md#automatic-approval-conversation-scoped-whitelist-adr-0044-f2-addendum-option-b),
ADR-0044 F2 addendum). The per-call-approval fact itself is covered there
too ([Approval flow](../reference/security/inter-agent-tool-authorization.md#approval-flow-permission_broker-integration)).

## Open Questions

Moved to [Inter-agent messaging](../architecture/inter-agent-messaging.md#open-questions).

## See Also

Moved to [Inter-agent messaging](../architecture/inter-agent-messaging.md#related-inter-agent-topics)
and its [ADRs](../architecture/inter-agent-messaging.md#adrs) list.
