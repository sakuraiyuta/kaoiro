---
title: Personality configuration (common footer)
description: The operator-changeable scope of the personality prompt -- the common-footer files, their composition order, and when a change takes effect.
status: accepted
last_updated: 2026-09-19
related: [protocol]
---

# Personality configuration (common footer)

### Common footer

Append a common footer at the end for every persona (including `default`).
**Composition is performed server-side**
([ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md) F5).

The implementation of [ADR-0045](../../adr/0045-footer-file-externalization.md)
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
  [ADR-0044](../../adr/0044-coordination-injection-hitl.md) F1 addendum,
  issue #165). When an operator replaces the built-in default with
  `system-footer.md` in `KAOIRO_FOOTER_DIR`, it also replaces this guidance
  because it is guidance shared by all personas, not persona-specific.

### Changeable scope

- The personality description is **settled as a snapshot when the wrapper
  starts (at handshake)**. It is not replaced mid-session
  ([ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md) F9).
  In addition to the SDK's `systemPrompt` only being effective at query start,
  this avoids introducing uncertainty that a persona changes during a
  conversation.
- Updating a ZIP in the import directory does not affect connected wrappers. It
  takes effect in the snapshot of their next connection.
- There is no path to override / extend personality description from the server
  or dashboard (the same treatment as allowed_tools in
  [threat-model](../../architecture/security-threat-model.md)).
- No Envelope (state_change / log / result) carries a personality string. As
  before, only `persona.id` / `persona.name` (canonical and immutable in the
  session) flow to the dashboard. The display name is the separate top-level
  `display_name` field (issue #209 D19); rename changes it, not `persona.name`.

## Constraints

- MUST: Compose and deliver `personality + common footer` server-side. The
  wrapper has no composition logic
  ([ADR-0029](../../adr/0029-persona-server-sot-and-pack-distribution.md) F5).
- MUST: Missing footer files do not fail closed. If `system-footer.md` is
  absent, use the built-in default; if `user-footer.md` is absent, add nothing.
- MUST NOT: Provide footer files per persona (do not read
  `user-footer.<persona_id>.md`).
- MUST NOT: Place operator-supplied `system-footer.md` / `user-footer.md` in
  the repository (environment-specific files like env; ADR-0045 F3).

## See Also

- [Persona delivery](../protocol/persona-delivery.md).
- [Personality-prompt injection (design)](../../architecture/personality-injection.md).
- ADR: [0029](../../adr/0029-persona-server-sot-and-pack-distribution.md),
  [0044](../../adr/0044-coordination-injection-hitl.md),
  [0045](../../adr/0045-footer-file-externalization.md).
