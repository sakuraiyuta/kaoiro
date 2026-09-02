---
title: Future path for an agent to use messages from an external human in its work
description: Decide whether to relax one-way authority so that an external human's reply can be used in an agent's work decisions (with operator approval).
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

v1 uses one-way authority ([ADR-0028](../adr/0028-external-human-messaging.md)
D1), so an external human's reply does not drive agent action (it only notifies
the operator). Thus v1 stops at “notification/request” and does not yet support
“consult and use the answer.” In the future, an agent may want to use an
external human's answer while working autonomously.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Do not introduce it (retain one-way authority) | Minimize the injection / destructive-operation surface | The agent cannot use an external answer itself (the operator relays it) |
| B | Design a path that injects it into the agent with operator approval | Enables genuine delegation with an external human | Requires a design for putting untrusted input into the agent context and an approval UX |

## 影響

- Because this touches the core security property (one-way authority), any
  change requires superseding or supplementing
  [ADR-0028](../adr/0028-external-human-messaging.md).

## 判断材料

- How cumbersome operator relaying is in real operation.
- Design together with the intake permission model in
  [external-human-recv-permission-model](external-human-recv-permission-model.md).

## 暫定方針

**A (do not introduce).** Retain one-way authority from v1 for the foreseeable
future. Close the loop by having the operator give the answer as a new
instruction in the dashboard.

## Actions upon resolution

- [ ] Record the decision in an ADR (decision to relax one-way authority)
- [ ] Revise the core principles in `../specs/protocol-external-human.md`
