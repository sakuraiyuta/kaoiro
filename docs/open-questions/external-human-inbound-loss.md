---
title: Dropped inbound messages while discord-wrapper is disconnected
description: Decide whether to accept loss of external-human replies received while discord-wrapper is disconnected from the gateway, or backfill them through Discord REST.
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

The Discord gateway receives only events while connected. Replies that arrive
while discord-wrapper is stopped (restart or failure) are lost as-is
([protocol-external-human](../specs/protocol-external-human.md)).

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Best-effort (no backfill; accept loss) | Minimal implementation | Replies during downtime do not arrive |
| B | Backfill unread messages through Discord REST on reconnect | No missed messages | Requires implementation cost, deduplication, and ordering consistency |

## 影響

- Inbound reliability only. No impact on the outbound / Tier A/B structure.

## 判断材料

- How often discord-wrapper goes down in real operation (expected to be
  infrequent under runner supervision).
- Practical harm of a missed reply (the operator can follow up on the original
  in Discord itself).

## 暫定方針

**A (best-effort).** Low priority. Because the operator can check missed replies
in Discord itself, practical harm is small.

## Actions upon resolution

- [ ] Record the decision (ADR / spec supplement if it becomes necessary)
- [ ] If adopting B, reflect the backfill policy in
      `../specs/protocol-external-human.md`
