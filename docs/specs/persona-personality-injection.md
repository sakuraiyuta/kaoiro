---
title: Personality-prompt injection
description: A mechanism for injecting each persona's manner of speech, first-person pronoun, sentence endings, and response style into the engine SDK (Claude uses systemPrompt.append; Codex uses developer_instructions). The prompt body SoT is a server-side persona pack and is delivered by the WS handshake.
status: provisional
related: [personas, persona-pack-schema, protocol, threat-model]
---

# Personality-prompt injection

## Purpose

[personas](personas.md) initially retained the personality design (ao / momo /
kuroe / fuji) for persona standing illustrations “only as design material for
generating illustrations.” Once kaoiro reached a stage where it could dogfood
itself, it became valuable to give runtime conversations a consistent persona.

This specification defines a mechanism to inject each persona's personality
description (manner of speech, first-person pronoun, sentence endings, and
response style) into the engine SDK (Claude uses `systemPrompt.append`; Codex
uses `developer_instructions`; see “Injection into the SDK” below). It extends
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

## Definition

### Scope

The subject is only the **appearance of conversational output** (manner of
speech, first-person pronoun, sentence endings, and response style). The
following are outside this specification:

- Task posture (degree of caution, progress-report frequency, and tool-use habits) — future work
  ([persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md))
- Integration with the emotion filter ([plans/phase-6-emotion-filter](../plans/phase-6-emotion-filter.md))
- Speech balloons / utterance UI ([persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md))
- A dashboard UI for editing personality

### Data model

Wrapper configuration has no personality-related field. Only `persona.id` /
`persona.name` / `persona.sprite_set` (canonical values from the pack,
unchangeable during a session) remain in startup configuration
([setup-wizards](setup-wizards.md)). Separately, the independent top-level
`display_name` field holds a **display name that may change during operation**
(issue #209 D19/D20 — `Principal.display_name`,
[ADR-0050](../adr/0050-principal-model-and-graded-access-control.md) D1). On
spawn, the server initializes it with an operator-specified custom name or, if
unspecified, a copy of `persona.name`.

The personality-prompt body resides in `personality.md` in the server-side
persona pack ([persona-pack-schema](persona-pack-schema.md)). Authors edit it
inside the persona-pack ZIP.

### Prompt delivery (WS handshake)

In the **handshake message** immediately after the wrapper connects to the
server, the server pushes to the wrapper a prompt string combining “personality
description + common footer.” See [protocol](protocol.md) for the detailed
message format.

- The server rejects a wrapper connection claiming an unknown `persona.id`
  (enforcement of “no unregistered personas,”
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)).
- If the server is unreachable, the wrapper spawn itself fails (fail closed).
  There is no local fallback.

### Injection into the SDK

Injection points differ by engine, but both share that **the wrapper only passes
the received string through** and has no composition logic.

**Claude Code**: The Claude Agent SDK's `systemPrompt` accepts
`{ type: 'preset', preset: 'claude_code', append?: string }`. Put the prompt
string received in the handshake directly into `append`.

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: promptFromHandshake,   // personality + footer already combined server-side
}
```

`preset: 'claude_code'` preserves the tool-use practices and safety
instructions equivalent to Claude Code. The personality description is an
appendage at its end and does not replace the preset.

**Codex**: Put the same string into a developer-role message as
`developer_instructions` in per-run configuration
([ADR-0032](../adr/0032-codex-adapter.md) F3, confirmed by live observation on
2026-07-10). Codex has no concept equivalent to a preset.

### Common footer

Append a common footer at the end for every persona (including `default`).
**Composition is performed server-side**
([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F5).

The implementation of [ADR-0045](../adr/0045-footer-file-externalization.md)
uses two md files in the footer directory (`KAOIRO_FOOTER_DIR`, separate from
the persona-import directory). When it is unset, only the built-in default is
used. Even for the reserved persona `default`, which has no pack, the following
footer composition becomes the prompt.

| File | Role | When missing |
|---|---|---|
| `system-footer.md` | kaoiro default (environment awareness + peer-routing rules + collaborative-behavior guidance). When present, replaces the built-in default completely | Use the default text built into the server binary |
| `user-footer.md` | Free-form operator overlay; an environment-specific file analogous to env | Add nothing |

- Composition order: `preset(claude_code) + personality + system-footer +
  user-footer` (separated by `\n\n`).
- There is **only one of each shared by all personas**. There is no
  persona-specific file (`user-footer.<persona_id>.md`). Express persona-specific
  instructions in the pack's `personality.md`.
- An operator override needs no implementation change; editing the file alone
  is sufficient.
- The built-in default is `server/priv/footers/system-footer.md` (build source;
  tracked for recompilation with `@external_resource` and included with
  compile-time `File.read!`). Operators can inspect this file in the repository
  or the `priv/` bundled with a release to check the default text (ADR-0045 F1).
- A dedicated watcher applies changes (only when `KAOIRO_FOOTER_DIR` is set,
  watching exact matches for the two filenames). Editing triggers a rebuild,
  effective from the snapshot of the next connecting wrapper (live sessions
  remain unchanged per F9). Every rebuild logs each layer's origin, character
  count, and short hash at info level (ADR-0045 F5). Reading semantics (UTF-8 /
  regular files only / last known good during a temporary read_error) are in
  ADR-0045 F6.
- Collaborative-behavior guidance (the principle of observing peer status with
  `list_agents`, deciding, and delegating with `send_to_agent`) appears for all
  personas as part of the `system-footer.md` built-in default. Its text was
  settled as option A (short principles only, without detailed procedure;
  [ADR-0044](../adr/0044-coordination-injection-hitl.md) F1 addendum,
  issue #165). When an operator replaces the built-in default with
  `system-footer.md` in `KAOIRO_FOOTER_DIR`, it also replaces this guidance
  because it is guidance shared by all personas, not persona-specific.

### Changeable scope

- The personality description is **settled as a snapshot when the wrapper
  starts (at handshake)**. It is not replaced mid-session
  ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F9).
  In addition to the SDK's `systemPrompt` only being effective at query start,
  this avoids introducing uncertainty that a persona changes during a
  conversation.
- Updating a ZIP in the import directory does not affect connected wrappers. It
  takes effect in the snapshot of their next connection.
- There is no path to override / extend personality description from the server
  or dashboard (the same treatment as allowed_tools in
  [threat-model](threat-model.md)).
- No Envelope (state_change / log / result) carries a personality string. As
  before, only `persona.id` / `persona.name` (canonical and immutable in the
  session) flow to the dashboard. The display name is the separate top-level
  `display_name` field (issue #209 D19); rename changes it, not `persona.name`.

## Constraints

- MUST: Injection into Claude uses `append` in
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. Do
  not discard `preset` and replace it with a hand-built string. Codex uses
  `developer_instructions`.
- MUST: Do not put a personality string in wrapper→server Envelopes
  ([threat-model](threat-model.md)).
- MUST: Compose and deliver `personality + common footer` server-side. The
  wrapper has no composition logic
  ([ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) F5).
- MUST: Missing footer files do not fail closed. If `system-footer.md` is
  absent, use the built-in default; if `user-footer.md` is absent, add nothing.
- MUST NOT: Provide footer files per persona (do not read
  `user-footer.<persona_id>.md`).
- MUST NOT: Place operator-supplied `system-footer.md` / `user-footer.md` in
  the repository (environment-specific files like env; ADR-0045 F3).
- MUST: The server rejects a wrapper connection claiming an unknown `persona.id`.
- MUST: Wrapper spawn fails when the server is unreachable (fail closed).
- MUST NOT: Implement a fallback that loads local md on the wrapper side.
- MUST NOT: Cache a prompt on the wrapper side (prevents SoT violation).
- SHOULD: Aim for 200–1000 characters for personality-description md. There is
  no hard limit.
- SHOULD: Distinguishability among personas (being able to identify a persona
  from its manner of speech) is an effort goal. When rigor is needed, create a
  separate issue through
  [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  when it becomes a problem.

## Open Questions

- [persona-behavioral-prompt](../open-questions/persona-behavioral-prompt.md) —
  injection of task posture (future work)
- [persona-voice-distinctiveness](../open-questions/persona-voice-distinctiveness.md)
  — trigger for rigorous distinguishability
- [persona-language-dispatch](../open-questions/persona-language-dispatch.md) —
  multilingual dispatch. Since the former model's `persona.language` field was
  removed, reconsider including whether to add a `language` equivalent to the
  pack's manifest.json
- [persona-personality-vs-dialogue](../open-questions/persona-personality-vs-dialogue.md)
  — reconsideration when speech-balloon UI is introduced

## See Also

- Related specs: [personas](personas.md),
  [persona-pack-schema](persona-pack-schema.md),
  [protocol](protocol.md), [threat-model](threat-model.md)
- ADRs: [ADR-0003](../adr/0003-persona-identity-persistence.md) (persona
  identity), [ADR-0006](../adr/0006-doc-language-i18n.md) (language policy),
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  (application model for this specification; supersedes former ADR-0026),
  [ADR-0045](../adr/0045-footer-file-externalization.md) (common-footer
  externalization; implemented; partially revises ADR-0029 F5/D5),
  [ADR-0044](../adr/0044-coordination-injection-hitl.md) (adding
  collaborative-behavior guidance to footer, F1)
- Plan: [phase-10-persona-server-sot](../plans/phase-10-persona-server-sot.md)
