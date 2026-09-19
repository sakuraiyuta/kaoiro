---
title: Attachments
description: Dashboard-to-agent attachment intake -- layer responsibilities, the deferred-upload UI model, and why rendering stays wrapper-internal.
status: accepted
last_updated: 2026-09-19
related: [protocol, architecture]
---

# Attachments

## Purpose

Defines how an operator can pass attachments from the dashboard to an agent
(initially Claude Code / Claude Agent SDK). Wire details are in
[protocol](../specs/protocol.md); the decision rationale is
[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md).

### Responsibilities

| Layer | Responsibility |
|--|--|
| Client (dashboard) | File picker + chunker + ArrayBuffer push. Holds no normative policy (UX hints are optional). |
| Server (Phoenix) | Transparent relay + transport DoS defenses (frame limit and in-flight cap) + operator authorization. Does not interpret envelopes or attach_* (agent-independent). |
| Wrapper (per engine) | pending_uploads management / final normative decisions / fit-to-SDK / conversion to SDK content blocks / reject notification. Rendering is wrapper-internal. |

### UI model (deferred upload)

Client rules that do not alter the protocol:

1. **Attachment button or D&D drop zone** → retain files selected by the file
   picker / drop in the client-local "to-send tray" **by reference only** (no
   byte transfer). Limit a drop zone to one agent (for example, the chat-box
   area in AgentDetail) to avoid ambiguity among multiple agents.
2. Remove an item from the tray with ✕ (this is client-local; the protocol is
   uninvolved).
3. Press the send button → transfer in this order: `attach_open` × N →
   `attach_chunk*` → `attach_close` × N →
   `instruction(attachment_ids=[...])`.

Immediate upload when a picker / D&D obtains a file is not adopted (avoids
wasting bandwidth and relying on TTL when cancelling before sending).

## Constraints

- SHOULD: The client has no normative policy; all rejections follow wrapper
  decisions (UX hints are optional).

## See Also

- [Attachment wire contract](../reference/protocol/attachments.md).
- [Attachment rendering by engine](../reference/engines/attachment-rendering.md).
- ADR: [0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) (decision rationale).
