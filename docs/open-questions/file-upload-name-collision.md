---
title: File Upload — UX for Same-Named Files within One Instruction
description: Unresolved issue concerning display and disambiguation when multiple files with the same filename are attached in one instruction. There is no collision at the protocol level (independent per upload_id).
status: open
urgency: low
blocks: []
opened: 2026-06-27
decided: null
---

## 背景

[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md) F2 established
that uploads are independent per `upload_id` (assigned by the client). filename
is a display-only field, so same-name collisions do not occur at the protocol
level (the wrapper / server identifies uploads by upload_id). However, a
collision may be visible when the filename is displayed in the client UI or
when passing it to the wrapper's SDK content blocks, which could confuse users.

## 選択肢

| Option | Description | Advantages | Disadvantages |
|--|--|--|--|
| A | Independent per upload_id, with filename display-only — no collision (at the protocol level). Leave duplicate display handling to the client's disambiguation UX. | Protocol unchanged; wrapper also unchanged | UX is inconsistent across client implementations |
| B | Explicitly add a suffix in the wrapper / client (for example: `image.png` / `image (2).png`) | Consistent display | Additional specification work; implementation required in both wrapper / client |

## 影響

With A, the protocol / implementation remains unchanged. If B is adopted, the
client-side disambiguation logic must be specified (whether the wrapper passes
filename to the SDK unchanged or renames it in the wrapper must be decided
separately).

## 判断材料

- Whether a UX problem involving multiple same-named attachments is actually reported
- How much the SDK / model refers to filename (whether displaying filename in
  a content block affects the response)

## 暫定方針

A — no action because there is no collision at the protocol level. Display
disambiguation is the client's responsibility; adding a suffix at send time in
the reference dashboard is sufficient.

## 解決時のアクション

- [ ] Specify disambiguation rules (where and how to add a suffix)
- [ ] Change the client / wrapper implementation
- [ ] Promote to an ADR and delete this file
