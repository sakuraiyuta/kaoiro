---
title: Inter-agent messaging
status: provisional
last_updated: 2026-09-18
description: Inter-agent messaging and its boundaries.
---

# Inter-agent messaging

## Purpose

Define the protocol surface that lets multiple AI agents exchange messages
directly through the kaoiro server. This is the mechanical specification for
issue #17; see [phase-8-inter-agent-messaging](../plans/phase-8-inter-agent-messaging.md)
for the staged implementation plan and kaoiro issues #87 and #17
issuecomment-5384349594 for design rationale.

Add envelope `type: "inter_agent_message"` as a reserved supplement to
[protocol](../specs/protocol.md) (same `version`), per
[ADR-0010](../adr/0010-protocol-precisification.md).

### Overview

When agent A's wrapper calls `send_to_agent`, it sends an envelope with
`type: "inter_agent_message"` to the server as a normal `envelope` event. The
server splits it into two paths:

```mermaid
flowchart LR
  WA[wrapper A] -->|envelope| S[server]
  S -->|"wrapper:to (routing path)"| WB[wrapper B]
  S -->|"agents:lobby (observation path)"| D[dashboard]
  WB -->|SDK input injection| AgentB[Agent B]
```

- **routing path**: The server reads `payload.to` and pushes the envelope to the
  `wrapper:<to>` channel. The receiving wrapper injects it as input for the next
  SDK turn.
- **observation path**: The server also includes the envelope in the normal
  `agents:lobby` broadcast (operator-only delivery; see [observation path](../specs/protocol-inter-agent.md#observation-path-dashboard-display)). The dashboard can
  display the inter-agent message in both A and B log panes.

The server does not interpret the natural-language meaning of the body. It
validates the structured payload (including kind, meta, and owner shape), reads
`to` for routing, and uses `conversation_id`, `turn_number`, `meta.done`,
`new_conversation`, and body byte length for admission, lifecycle, and quotas.
These mechanical checks do not decide whether an agent agrees with the body.

## Related inter-agent topics

- [Inter-agent message contract](../reference/inter-agent/messages.md).
- [Inter-agent conversation contract](../reference/inter-agent/conversations.md).
- [Inter-agent conversation admission](../reference/inter-agent/conversation-admission.md).
- [Remaining protocol topics](../specs/protocol-inter-agent.md), including delivery, approval, observation, and companion tools.
