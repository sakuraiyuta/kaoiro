---
title: Reconsidering the Personality Prompt When Introducing a Dialogue-Bubble UI
description: How to redesign the personality prompt when introducing a seri-fu (dialogue-bubble / dialogue display) UI in the future.
status: open
urgency: low
blocks: []
opened: 2026-07-02
decided: null
---

## 背景

[personas](../specs/personas.md) states on line 15 that "conversation settings
such as speech style and first person ... will be decided separately when
dialogue display or similar is introduced in the future." The current
[persona-personality-injection](../specs/persona-personality-injection.md)
covers speech style, but only up to injection into the Claude Agent SDK; it
does not consider constraints of a dialogue bubble / speech UI such as
"brevity, sentence-finality, and the amount readable at once."

Reserve how to handle the existing `personality_prompt_file` when a dialogue
bubble UI is introduced in the kaoiro dashboard in the future.

## 選択肢

| Option | Description | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Add "brevity that fits in a dialogue bubble" and similar instructions to the style instructions of the existing `personality_prompt_file` | No field addition needed | Constraint of supporting normal and dialogue-bubble output in the same prompt |
| B | Add a dedicated field for dialogue bubbles (such as `dialogue_style_prompt?`) | Normal and dialogue-bubble output can be designed separately | Data-model expansion; becomes duplicated management unless synchronized |
| C | Reconsider it together when specifying the dialogue-bubble UI itself | Do not decide now = do not decide with insufficient information | The decision timing moves further away |

## 影響

- It is outside the current scope, so there is no implementation impact.
- When a dialogue-bubble UI introduction spec is created, always refer to this
  open question as a trigger.

## 判断材料

- The concrete specification of the dialogue-bubble UI (what to show, how much,
  and when to show it).
- Whether to have both "main response text" and "dialogue-bubble dialogue," or
  only one of them.
- How personas.md's line 15, "dialogue display or similar in the future," will
  be made concrete.

## 暫定方針

**C** (decide together when creating the dialogue-bubble UI spec). Implement
nothing at this time.

## Actions upon resolution

- [ ] Decision recorded in `adr/NNNN-persona-personality-vs-dialogue.md`
      or integrated into the dialogue-bubble UI spec
- [ ] Add the integration policy with the dialogue-bubble UI to the "Scope"
      section of Spec `../specs/persona-personality-injection.md`
- [ ] This file moved to ADR or deleted
