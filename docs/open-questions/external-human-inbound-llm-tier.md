---
title: Whether to pass inbound messages from an external human through an LLM (final Tier B decision)
description: Decide whether an external human's reply should be summarized and answered in a zero-tool intake LLM (Tier B), or remain in deterministic Tier A. Settle it with an injection-resistance red-team spike.
status: open
urgency: medium
blocks: [protocol-external-human, phase-9-external-human-messaging]
opened: 2026-07-04
decided: null
---

## 背景

Inbound in external-human messaging
([protocol-external-human](../specs/protocol-external-human.md)) is untrusted
input. The operator wants an experience of “summarize this as ‘this is what you
mean, right?’ and send a reply,” but putting external text into an LLM context
creates prompt-injection risk. We separated “pass it through an LLM” from “pass
it through an agent with tools,” and concluded that a zero-tool intake LLM can
minimize the blast radius (verify this in a spike).

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Tier B: add `ext.interpretation` + a limited reply using a zero-tool intake LLM (Haiku, text→text) | Meets the desired UX (summary and character flavor); small blast radius | Has an injection surface; requires a spike gate |
| B | Tier A only (fixed deterministic template) | Zero injection surface; safest | No summary; poor UX |

## 影響

- Gates whether phase-9 Stage 1 can begin. Stage 0 (Tier A) can ship
  independently of this question.
- If Tier B is adopted, this is the first application of the plugin-model filter
  mechanism and the first concrete implementation of issue #18.

## 判断材料

- Red-team spike result: whether injection can break invariants (original text
  verbatim / same recipient fixed / zero-tool).
- If it can, the need and cost of additional mitigation (such as operator
  approval for the reply too).

## 暫定方針

Ship phase-0 with **Tier A**. Enable **Tier B** (A) after it passes the pre-
implementation red-team spike. Original text verbatim / same recipient fixed /
zero-tool / no injection into the working agent are MUSTs for Tier B.

## 解決時のアクション

- [ ] Record the decision in `adr/NNNN-<slug>.md` (or as an ADR-0028 supplement)
- [ ] Finalize the Tier B section of `../specs/protocol-external-human.md`
- [ ] Remove the gate from Stage 1 of
      `../plans/phase-9-external-human-messaging.md`
