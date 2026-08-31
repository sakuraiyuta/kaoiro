---
title: Injecting Task Stance (Caution, Reporting Frequency, and Tool-Use Habits)
description: Whether to expand the scope of personality-prompt injection from speech style to also include task stance (caution, progress-reporting frequency, tool-use habits, etc.).
status: open
urgency: low
blocks: []
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md)'s initial
scope was limited to "speech style, first person, sentence endings, and reply
style," while task stance (caution, progress-reporting frequency, tool-use
habits, etc.) was explicitly separated as a future task ([ADR-0026](../adr/0026-persona-personality-injection.md)).

Background: the initial implementation was intended to remain lightweight during
the dogfooding phase, and task stance requires more careful validation than
"only the speech style differs" because it directly affects the results of
actual work.

Reserve how to handle this scope expansion in the future.

## 選択肢

| Option | Description | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Do not include it in the current scope; create a new spec when needed | Zero impact on the current implementation; careful validation only when the stage requires it | Must restart the discussion when expansion is desired |
| B | Expand the existing `personality_prompt` so task stance can also be written in natural language | No field addition needed; flexible | Speech style and task stance become mixed, making review and replacement difficult; distinguishability and validation become harder |
| C | Split `personality_prompt` and `behavior_prompt` into two fields | Clear separation of responsibilities; stance differences per persona can be reviewed independently | Data-model expansion; potentially over-designed for the current phase |

## 影響

- The current specification remains unchanged. Decide this open question when
  dogfooding creates demand to "also vary task stance per persona."
- Depending on when it is decided, a migration policy that preserves
  compatibility with the existing personality_prompt_file must also be designed.

## 判断材料

- Whether dogfooding produces situations where it feels unnatural that "the
  speech style differs but the stance is the same."
- Whether there is a way to measure side effects of incorporating task stance
  into the personality (impact on the assistant's actual work quality).

## 暫定方針

**A** (hold as a future task). tag is "awaiting dogfooding observation."

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-behavioral-prompt.md`
- [ ] If expanding, update the "Scope" section of `../specs/persona-personality-injection.md`
- [ ] This file moved to ADR or deleted
