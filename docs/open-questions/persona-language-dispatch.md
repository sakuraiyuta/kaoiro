---
title: Consumption Logic for persona.language
description: How to consume the Persona language field at runtime (personality selection, footer switching, and language instructions on the SDK side).
status: open
urgency: low
blocks: [persona-personality-injection]
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md)
added the `language?: string` field to `Persona` (default `"ja"` when omitted).
Because only the foundation was laid for future-proofing, phase-0 only loads it
and has no dispatch logic.

During phase-1, when multilingual support is implemented, decide what consumes
`language` and how ([ADR-0026](../adr/0026-persona-personality-injection.md)'s
follow-up discussion linked to the D4 decision). The document-language policy
is covered by [ADR-0006](../adr/0006-doc-language-i18n.md).

## 選択肢

| Option | Description | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Switch `personality_prompt_file` using the `<id>.<lang>.md` naming scheme | The personality description itself is language-specific; allows locale-specific writing rather than translation | File management grows as number of personas × number of languages; when language differs, care is needed to maintain consistency of the standing illustration |
| B | Switch only the common footer by language and keep one personality file | Minimal implementation cost; write personality so it works in both English and Japanese | The agent's response language may be pulled toward the language of the individual description |
| C | Append language instructions on the SDK side according to language (such as "always respond in Japanese") | Can enforce the response language | Complexity from managing personality speech style and response language as separate axes |

The above are not mutually exclusive; combinations such as A+C and B+C are
also possible. Leave room to choose a combination when deciding.

## 影響

- The phase-1 implementation is decided here. Because phase-0 runs with "only
  language loading, no dispatch," this open question's undecided status does
  not block phase-0.
- Adoption may change depending on how many personas will support multiple
  languages in the future.

## 判断材料

- Whether actual demand emerges to make personas multilingual (expected to arise
  at the external-release stage).
- Whether there are cases for writing each persona in a different language, or
  whether everything will be translated into English.
- How much of the personality side to include in [ADR-0006](../adr/0006-doc-language-i18n.md)'s
  "translate everything before beta" milestone.

## 暫定方針

Undecided. Revisit the discussion when entering phase-1. Until then, implement
only loading the language field in phase-0.

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-language-dispatch.md`
- [ ] Update the "Data model" and "Constraints" sections of Spec `../specs/persona-personality-injection.md`
- [ ] Detail the phase-1 tasks in `../plans/persona-personality-injection.md`
- [ ] This file moved to ADR or deleted
