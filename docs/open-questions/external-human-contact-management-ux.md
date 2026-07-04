---
title: contact 一覧の管理 UX(config ファイル vs GUI)
description: outbound の contact whitelist を operator が管理する手段。v1 は config ファイル、将来 dashboard 等の GUI 化を検討。
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

outbound の宛先 whitelist(contact 一覧)は discord-wrapper の config ファイル
で運用する([ADR-0028](../adr/0028-external-human-messaging.md) D4)。GUI での
管理は operator コンソール志向([ADR-0020](../adr/0020-dashboard-battery-included-client.md))
に合うが、v1 では client を視覚表現に集中させる方針と、raw Discord ID が
server を in-flight 通過する点を避けるため見送った。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | config ファイル運用(v1) | 実装最小・raw ID を wrapper 内に閉じる | operator が手でファイル編集 |
| B | dashboard 等 GUI で CRUD | 操作が容易・コンソール志向に合致 | 新公開面 + raw ID が client→server→wrapper を通過 |

## 影響

- outbound の運用性のみ。プロトコル中核・セキュリティ性質には影響しない
  (enforce は discord-wrapper のまま)。

## 判断材料

- contact 数と更新頻度(少なければ config で十分)。
- GUI 化する場合の raw ID 経路の扱い(wrapper authoritative + server 中継のみ)。

## 暫定方針

**A(config ファイル)**。GUI 化は将来。client は視覚表現に集中させる。

## 解決時のアクション

- [ ] Decision recorded(GUI 化する判断)
- [ ] contact CRUD の wire を `../specs/protocol-external-human.md` へ追加(B 採用時)
