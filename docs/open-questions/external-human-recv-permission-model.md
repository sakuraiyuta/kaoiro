---
title: Future permission model for accepting instructions from an external human
description: Decide whether to grant per-human / per-service intake permissions such as “accept instructions only from this user of this service.”
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

v1 never executes an external human's statement (one-way authority). There is a
future request to grant permission such as “accept instructions from a specific
trusted external user” ([ADR-0028](../adr/0028-external-human-messaging.md)
Neutral). Allowing intake would also connect to
[external-human-agent-consumes-input](external-human-agent-consumes-input.md).

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Reject all intake for now (one-way authority) | Safest; no implementation | Cannot drive an agent from outside |
| B | Grant intake permission per contact / service | Delegation from trusted people | Requires permission management, impersonation defenses, and an injection-surface design |

## 影響

- If intake permission is allowed, external input has authority, requiring a
  redesign of the firewall model and a supplement / supersession of
  [ADR-0028](../adr/0028-external-human-messaging.md).

## 判断材料

- How to verify the identity of trusted people (confidence in Discord user IDs
  and resistance to impersonation).
- Permission granularity (read-only investigation / non-destructive /
  destructive) and the level of operator auditing required.

## 暫定方針

**A (reject all intake).** Retain one-way authority for the foreseeable future.

## Actions upon resolution

- [ ] Record the decision in an ADR (introduce an intake-permission model)
- [ ] Add the intake-permission specification to
      `../specs/protocol-external-human.md`
