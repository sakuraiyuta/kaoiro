---
title: 外部人間のメッセージを agent が作業に取り扱う経路(将来)
description: 一方向 authority を緩め、外部人間の返信を(operator 承認付きで)agent の作業判断に使えるようにするか。
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

v1 は一方向 authority([ADR-0028](../adr/0028-external-human-messaging.md)
D1)で、外部人間の返信は agent の行動を駆動しない(operator への通知のみ)。
このため v1 は「通知/依頼」止まりで「相談して回答を使う」ではない。将来、
外部人間の回答を agent が自走に使いたくなる可能性がある。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 導入しない(一方向 authority 堅持) | injection / 破壊操作面が最小 | agent は外部回答を自分で使えない(operator が中継) |
| B | operator 承認付きで agent に注入する経路を設計 | 外部人間との真の delegation が可能 | untrusted 入力を agent 文脈へ入れる設計・承認 UX が要る |

## 影響

- 中核セキュリティ性質(一方向 authority)に触れるため、変更時は
  [ADR-0028](../adr/0028-external-human-messaging.md) の supersede/追補を伴う。

## 判断材料

- 実運用で「operator 中継」がどれだけ煩雑か。
- [external-human-recv-permission-model](external-human-recv-permission-model.md)
  の受付権限モデルと併せた設計。

## 暫定方針

**A(導入しない)**。v1〜当面は一方向 authority を堅持。operator が dashboard
で回答を改めて指示する形で loop を閉じる。

## 解決時のアクション

- [ ] Decision recorded in ADR(一方向 authority を緩める判断)
- [ ] `../specs/protocol-external-human.md` の中核原則を改訂
