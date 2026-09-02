---
title: Glossary
description: kaoiro domain terminology (wrapper, server, client, adapter, filter, persona, and state names).
status: accepted
related: [overview, architecture, protocol]
---

# Glossary

## Purpose

Standardizes kaoiro domain terminology.

## Definition

| Term | Meaning |
|---|---|
| Wrapper | A TypeScript process that launches and observes one agent, then translates it into common events. It hosts the engine SDK (Claude Agent SDK or Codex SDK). |
| Engine | The kind of AI-agent CLI hosted by a wrapper. The values are `claude-code` and `codex` ([ADR-0032](../adr/0032-codex-adapter.md)). Determine feature availability from `ext.session_capabilities`, not the engine name ([ADR-0034](../adr/0034-session-capabilities-advertisement.md)). |
| Runner | A supervisory layer, one per host, that spawns, stops, and restarts wrapper processes; registers the host; and lists sessions ([ADR-0023](../adr/0023-host-runner-architecture.md)). It does not terminate the data path. |
| Server | The Elixir/Phoenix component that aggregates multiple wrappers and retains and distributes state. |
| Client | A frontend that visualizes state through characters and expressions. Its implementation is a separate project; this repository includes only a reference dashboard ([ADR-0007](../adr/0007-client-separation-reference-dashboard.md)). |
| Adapter | An agent-specific plugin for launching, translation, and state derivation ([plugin-model](plugin-model.md)). |
| Filter | An additive-processing plugin that adds properties to common events. |
| Common event envelope | Common JSON that wraps one event. It is a metaphor for an envelope in which common metadata (the addressee) wraps the `payload` (the contents). Definitions and hierarchy: [protocol](protocol.md), “Terminology and hierarchy.” |
| Outer frame (frame keys) | The fixed set of keys immediately below an envelope (fixed in v0). [protocol](protocol.md) |
| payload | The event body for each `type` within an envelope. It is distinct from the payload slot of a Channels frame ([protocol](protocol.md)). |
| ext | An extension area added by filters ([protocol](protocol.md)). |
| Channels frame | The transport-layer `[join_ref, ref, topic, event, payload]`. Its payload slot contains the complete envelope ([protocol](protocol.md), [ADR-0009](../adr/0009-client-transport.md)). |
| Persona | A persistent, fixed personality and standing illustration assigned to an agent, identified by a stable ID ([ADR-0003](../adr/0003-persona-identity-persistence.md)). |
| State | idle/sending/thinking/tool_running/waiting_permission/waiting_question/waiting_input/done/error/disconnected. Only `disconnected` is derived on the server side and is never sent by wrappers ([protocol](protocol.md)). |

## See Also

- Related specs: [overview](overview.md), [architecture](architecture.md),
  [protocol](protocol.md)
