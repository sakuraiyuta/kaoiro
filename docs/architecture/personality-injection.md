---
title: Personality-prompt injection
description: Why each persona's manner of speech is injected into the engine SDK from a server-side pack, and what stays out of scope.
status: accepted
last_updated: 2026-09-21
related: [protocol, personas]
---

# Personality-prompt injection

## Purpose

[personas](../specs/personas.md) initially retained the personality design (ao / momo /
kuroe / fuji) for persona standing illustrations “only as design material for
generating illustrations.” Once kaoiro reached a stage where it could dogfood
itself, it became valuable to give runtime conversations a consistent persona.

This specification defines a mechanism to inject each persona's personality
description (manner of speech, first-person pronoun, sentence endings, and
response style) into the engine SDK (Claude uses `systemPrompt.append`; Codex
uses `developer_instructions`; Antigravity, which has no SDK, an always-on
rules file in a per-agent customization directory —
[ADR-0057](../adr/0057-antigravity-adapter.md) F3; see
[Personality-prompt injection by engine](../reference/engines/personality-injection.md)). It extends
[ADR-0003](../adr/0003-persona-identity-persistence.md) (persistence of persona
identity) to ensure “the same persona speaks in the same **manner** across
restarts.”

**Application model**: Under [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md),
the primary source for personality prompts is the server-centralized SoT
(`personality.md` in the persona-pack ZIP). The wrapper receives it from the
server in the WS handshake and injects it into the SDK. The former model
(loading an md bundled with the wrapper) was established by
[ADR-0026](../adr/0026-persona-personality-injection.md), then superseded by
ADR-0029.

### Scope

The subject is only the **appearance of conversational output** (manner of
speech, first-person pronoun, sentence endings, and response style). The
following are outside this specification:

- Task posture (degree of caution, progress-report frequency, and tool-use habits) — future work
  ([persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md))
- Integration with the emotion filter ([plans/phase-6-emotion-filter](../plans/phase-6-emotion-filter.md))
- Speech balloons / utterance UI ([persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md))
- A dashboard UI for editing personality

## Constraints

- SHOULD: Aim for 200–1000 characters for personality-description md. There is
  no hard limit.
- SHOULD: Distinguishability among personas (being able to identify a persona
  from its manner of speech) is an effort goal. When rigor is needed, create a
  separate issue through
  [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  when it becomes a problem.

## See Also

- [Persona delivery](../reference/protocol/persona-delivery.md).
- [Personality-prompt injection by engine](../reference/engines/personality-injection.md).
- [Personality configuration](../reference/configuration/personality.md).
- ADR: [0003](../adr/0003-persona-identity-persistence.md) (persona identity),
  [0029](../adr/0029-persona-server-sot-and-pack-distribution.md) (application
  model; supersedes former ADR-0026).
