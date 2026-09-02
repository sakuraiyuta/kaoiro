---
title: External human messaging — make humans participants in an external channel, one-way authority, discord-wrapper topology
status: accepted
date: 2026-07-04
opened: 2026-07-04
supersedes: []
superseded_by: null
related_specs: [protocol-external-human, protocol, protocol-inter-agent]
related_adrs: [10, 17, 21]
---

# ADR-0028 — External Human Messaging

## Status

Accepted

## Context

In the same spirit as inter-agent messaging (inter-agent, implemented in [phase-8](../plans/phase-8-inter-agent-messaging.md)), we want an AI agent to send messages to **external humans** through Discord and receive replies (kaoiro’s target: office-like operation for oneself / a laboratory).

Both ends of inter-agent messaging are managed by kaoiro, whereas the endpoint of an external human is outside kaoiro. This creates the branches (1) whether to make it bidirectional, (2) whether to implement it in kaoiro or an external MCP, and (3) how to handle untrusted external input. The specification source of truth is [protocol-external-human](../specs/protocol-external-human.md).

## Decision

### D1: Bidirectional transport / one-way authority

Transport is bidirectional (agent ↔ external human), but authority is one-way. An external human’s messages **do not drive the agent’s actions at all**, whether destructive, non-destructive, or investigative. External input is limited to notification to the operator; execution decisions belong only to the operator and the agent’s own generated content. This is the core security property of the feature.

### D2: discord-wrapper topology (server remains a broker)

The dedicated discord-wrapper (an external-channel adapter entity) holds the Discord connection and keeps the bot token there. The server only routes with `to` and remains a broker. Preserve the principle “the endpoints are the wrapper (agent) and client (operator), and the server is the bridge,” and reuse the routing / observation / quota of existing inter-agent messaging.

### D3: Separate the path with a dedicated type and tool

To **separate the code** of the untrusted-external path from the trusted-agent path, introduce `external_message` type and `send_to_human` tool (do not generalise inter-agent messaging). If the trust models share one path, an omitted condition branch immediately becomes a vulnerability.

### D4: Outbound = whitelist + approval of the complete text every time

Destinations are limited to the whitelist configured by the operator. Enforcement is in discord-wrapper. Expose to the agent only the logical contact id + display name, keeping raw Discord IDs / PII inside the wrapper (listing them does not weaken defence—the enforcement provides the guarantee, as in the office analogy). Use `permission_broker` to show the destination + complete body to the operator and obtain approval every time. Make clear to external humans that the message came from AI/kaoiro.

### D5: Inbound = Tier A (default, safe) / Tier B (spike gate)

- **Tier A** (phase-0): use no LLM; reply with a fixed template and relay the original verbatim to the operator. Zero injection surface. This is the fail-soft fallback.
- **Tier B** (phase-1): separate “pass through an LLM” from “pass through an agent with tools,” and use a **zero-tool intake LLM** (Haiku, text→text only) to attach a summary to `ext.interpretation` (the first application of the discord-wrapper filter chain—the plugin-model filter mechanism). Generate a limited reply with a responder. Do not inject it into the working agent. MUST preserve the original verbatim and fix the same counterpart; settle final adoption in a red-team spike before implementation ([external-human-inbound-llm-tier](../open-questions/external-human-inbound-llm-tier.md)).

### D6: Safety valve and retention

Enforce a three-turn limit per conversation mechanically in the server’s `ConversationStates`. Conversation content is ephemeral (not persisted by the server), and only the contact list in config is persistent. Deliver `external_message` only to operators in both directions ([ADR-0021](0021-role-information-disclosure-policy.md)).

## Consequences

### Positive

- Reuse inter-agent envelope routing / observation / quota / permission_broker, keeping the implementation thin.
- Do not break the server broker principle, operator-only delivery, or agent independence.
- One-way authority + path separation structurally suppresses external prompt injection / destructive operations / exfiltration.
- This is the first application of plugin-model’s long-unimplemented filter mechanism (Tier B), also serving as the first concrete form of issue #18 (message filters).

### Negative

- Adds a new entity type (discord-wrapper) and new type / tool / config surface. Bot-token management and always-on connection operations are added.
- Tier B has an injection surface and requires the pre-implementation spike as a gate.
- Inbound messages while discord-wrapper is disconnected are lost (accepted, [external-human-inbound-loss](../open-questions/external-human-inbound-loss.md)).

### Neutral

- v1 is Discord only. Email / Slack remain future issue + docs items.
- Accepting instructions from external humans (granting authority) is a future concern ([external-human-recv-permission-model](../open-questions/external-human-recv-permission-model.md)).
- GUI management of contacts is future work ([external-human-contact-management-ux](../open-questions/external-human-contact-management-ux.md)).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Notifications in one direction only | Does not provide the experience of “ask the other party and receive a reply” |
| Have the agent process external input as instructions (Tier C) | Full tools + task context + secrets create risks of destruction/exfiltration/lateral movement |
| Discord adapter on the server side | Violates the principle “the endpoints are wrapper and client, and the server is a broker” |
| Generalise inter_agent_message with recipient type = agent\|human | Sharing trust models in one path makes an omitted condition branch an immediate vulnerability |
| Hide the contact list from the agent | Enforcement is guaranteed in the wrapper; disclosure does not weaken defence and only loses convenience |
| Manage contacts in the dashboard UI (v1) | Want the client focused on visual representation and to avoid a raw Discord-ID server path. Leave it as future work |
| Persist external conversations | A new persistence surface is out of scope (future #24) and raises third-party privacy concerns |

## Related

- specs: [protocol-external-human](../specs/protocol-external-human.md) (source of truth), [protocol](../specs/protocol.md) (addendum for `external_message` type), and [protocol-inter-agent](../specs/protocol-inter-agent.md) (source of the superset).
- ADRs: [0010](0010-protocol-precisification.md) (reserved-type addendum), [0017](0017-wrapper-multientity-packages.md) (multi-entity), and [0021](0021-role-information-disclosure-policy.md) (operator-only delivery).
- kaoiro issue #18 (message filters).
