---
title: Trigger for Strict Persona Distinguishability
description: Reserve whether to leave the degree to which a persona can be identified from speech style (distinguishability) at SHOULD, or when and under what conditions to make it strict.
status: open
urgency: low
blocks: []
opened: 2026-07-02
decided: null
---

## 背景

[persona-personality-injection](../specs/persona-personality-injection.md) leaves
distinguishability at SHOULD. The goal is to "be able to identify at a glance
which persona it is from the reply speech style when they are placed side by
side," but there is no mechanical validation. The reasons were to avoid the
burden of validation during the dogfooding phase and to decide after observing
the interaction between SDK preset instructions and personality descriptions in
operation ([ADR-0026](../adr/0026-persona-personality-injection.md)).

When it becomes a problem, use this open question as the trigger to decide a
policy for making it strict.

## 選択肢

| Option | Description | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Keep it at SHOULD and do nothing until it becomes a problem | Zero additional cost; "do not touch it while it works" | The determination of whether it is a problem is subjective, so the decision tends to be postponed |
| B | Specify a workflow for regular output sampling and visual evaluation | Institutionalizes the practice of checking regularly, even if subjective | Operational burden; may be excessive during dogfooding |
| C | Add an automated distinguishability test (have another LLM guess "which persona is this?") | Provides an objective metric | Cost of calling another LLM, implementation cost, and test variability |

## 影響

- No implementation impact until it becomes a problem.
- If strictness is adopted, places that conflict with the strength of SDK preset
  instructions may need to be rewritten (for example, by writing a strong
  override on the personality side).

## 判断材料

- Whether situations occur in actual operation where it is impossible to tell
  which persona responded.
- How often difficulty distinguishing them leads to actual harm (failure to
  form attachment, difficulty understanding state).
- How dominant instructions such as "conciseness and fact checking" in the
  Claude Code preset are.

## 暫定方針

**A** (keep it at SHOULD). If observation detects a problem, file a new issue
and use it to bring this open question to a decision.

## 解決時のアクション

- [ ] Decision recorded in `adr/NNNN-persona-voice-distinctiveness.md`
- [ ] If making it strict, promote Constraints from SHOULD → MUST in
      `../specs/persona-personality-injection.md` and add the validation method
- [ ] This file moved to ADR or deleted
