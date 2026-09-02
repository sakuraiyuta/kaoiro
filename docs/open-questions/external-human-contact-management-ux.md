---
title: UX for managing the contact list (config file vs. GUI)
description: Decide how the operator manages the outbound contact whitelist. v1 uses a config file; consider a GUI such as the dashboard in the future.
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

Operate the outbound destination whitelist (contact list) in the discord-wrapper
config file ([ADR-0028](../adr/0028-external-human-messaging.md) D4). GUI
management fits the operator-console direction of
[ADR-0020](../adr/0020-dashboard-battery-included-client.md), but v1 deferred it
to keep the client focused on visual presentation and to avoid raw Discord IDs
passing through the server in flight.

## 選択肢

| Option | Content | Advantages | Disadvantages |
|----|------|----------|-----------|
| A | Config-file operation (v1) | Minimal implementation; keep raw IDs inside the wrapper | Operator must edit the file manually |
| B | CRUD through a GUI such as the dashboard | Easy operation; fits the console direction | New public surface + raw IDs pass client → server → wrapper |

## 影響

- Operations only. No impact on core protocol or security properties (enforcement
  remains in discord-wrapper).

## 判断材料

- Number of contacts and update frequency (a config is sufficient if there are
  few and they change rarely).
- If adding a GUI, how to handle the raw-ID path (wrapper authoritative + server
  relay only).

## 暫定方針

**A (config file).** Defer a GUI. Keep the client focused on visual presentation.

## Actions upon resolution

- [ ] Record the decision (decision to add a GUI)
- [ ] If adopting B, add the contact CRUD wire to
      `../specs/protocol-external-human.md`
