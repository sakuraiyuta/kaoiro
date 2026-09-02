---
title: Impact assessment of the Claude `effort_levels` UX mismatch before and after init
description: Observe after implementation whether the current decision to provisionally expose FULL_EFFORT in the BOOTSTRAP default entry causes UX impact through a mismatch with the measured default model's post-init effort_levels (5 levels before init → possibly fewer after init).
status: open
urgency: medium
blocks: []
opened: 2026-07-14
decided: null
---

## 背景

[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) F5 adopts the
current behavior of provisionally exposing FULL_EFFORT in the reduced `default`
entry's `effort_levels`
(`["low", "medium", "high", "xhigh", "max"]`).
This preserves the current source for the fresh idle agent's effort switcher
(`AgentDetail.svelte:369` comment) while coexisting with the contract that
`ext.models` is replaced by the correct effort_levels after init.

One side effect of this decision is a possible case where a user selects xhigh
before init, then sees “the xhigh they selected disappear from the switcher
choices” after init completes (when the measured default is in the Sonnet family
and returns SONNET_EFFORT
`["low", "medium", "high", "max"]`, xhigh is excluded).

It is not possible to predict in advance how much UX friction this mismatch will
cause after implementation, so track it as an open question for observation.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Continue with the mismatch as acceptable (retain current behavior) | Minimal implementation; does not break the existing switcher source | The difference in choices before and after init may cause friction (observe after implementation) |
| B | If UX observation after implementation shows a serious problem, revisit D1 (empty effort_levels or fixed 3 levels) | Respond after the problem appears and base the decision on real data | Decision is delayed; requires a way to collect user feedback |

## 影響

- **blocks**: none (non-blocking; an observation task after implementation)
- The choice sets in the effort selector of the pre-init launch dialog and the
  post-init AgentDetail effort switcher may differ. Frequency depends on the
  measured default model's `effort_levels` returned by the SDK

## 判断材料

- After Phase 18 implementation, frequency with which users who selected xhigh /
  max before init experience “it disappeared from the choices” (issue / user
  feedback / dashboard log)
- The result of Phase 18-2 (Q1 measurement): which `effort_levels` the SDK's
  measured default model actually returns (currently it is assumed that the Opus
  family returns FULL_EFFORT, but this is unconfirmed)
- Alternative value if moving to option B: empty effort_levels (disable the
  pre-init switcher) or fixed low/medium/high 3-level set

## 暫定方針

Proceed with ADR-0037 F5 under option A (accept). After Phase 18 implementation,
consider moving to option B if issue reports or user feedback identify the
friction as a problem.

## Actions upon resolution

- [ ] After Phase 18 implementation, establish a UX observation period (roughly
      2–4 weeks)
- [ ] If friction is observed: revise F5 of
      [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md), and decide in
      a new or supplementary ADR whether to empty `effort_levels` or switch to a
      fixed 3-level set
- [ ] If friction is not observed: close (delete) this open question
