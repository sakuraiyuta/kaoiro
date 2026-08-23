---
title: kaoiro overview
description: The purpose, goals, and intended users of a system that visualizes CLI AI agents as characters.
status: accepted
related: [architecture, non-goals, glossary]
---

# kaoiro overview

## Purpose

CLI-based AI agents such as Claude Code and Codex make their state and progress
hard to understand. When several are in use, it is hard to follow who is doing
what, and they can be difficult to relate to. kaoiro is a wrapper and
visualization system that shows agents through their demeanor (character
+ expression), aiming both for situational awareness and attachment.

## Definition

### Two goals, with separate signal sources

| Goal | How it is addressed | Primary signal |
|---|---|---|
| (A) Understanding progress and state (practical) | State machine | Structured events (running / waiting for input / error / complete / waiting for permission) |
| (B) Attachment (emotional) | Character + expression | State + (optionally) sentiment NLP |

- (A) addresses the difficulty of checking progress. Response text is
  matter-of-fact and carries little emotional signal, so inferring state from
  sentiment is unreliable.
- The primary source for expressions is semantically reliable state (for
  example, waiting for permission means looking at the user and waiting).
- Sentiment NLP is flavoring. If it fails, the practical value of the
  visualization remains.

### Intended users

Primarily the author (and their laboratory). It assumes development and
research workflows that routinely run several AI agents in parallel.

### Scope (initial work)

- Obtain one agent's state from the message sequence of an engine SDK and
  represent it as a state machine ([architecture](architecture.md)). Claude
  Code was the first target; Codex was added in phase-14 behind the same
  `EngineAdapter` boundary
  ([ADR-0032](../adr/0032-codex-adapter.md)).
- Aggregate the states of multiple agents on the server and visualize them in
  the client.
- Send instructions to a specific agent (bidirectional).
- Route permission approvals (waiting for permission to run a tool) to the
  client UI.
- Persist a persona for each agent
  ([ADR-0003](../adr/0003-persona-identity-persistence.md)).

See [non-goals](non-goals.md) for work outside the scope.

## Constraints

- SHOULD: The wrapper uses TypeScript + an engine SDK, the server uses
  Elixir/Phoenix, and the client uses Web (TS). See
  [architecture](architecture.md) for details.

## Open Questions

None (this spec is accepted).

## See Also

- Related specs: [architecture](architecture.md), [non-goals](non-goals.md),
  [glossary](glossary.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md)
