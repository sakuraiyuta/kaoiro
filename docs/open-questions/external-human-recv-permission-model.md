---
title: 外部人間からの指示受付の権限モデル(将来)
description: 「このサービスのこのユーザだけ指示を受け付ける」等、外部人間ごと/サービスごとの受付権限を付与できるようにするか。
status: open
urgency: low
blocks: []
opened: 2026-07-04
decided: null
---

## 背景

v1 は外部人間の発言を一切実行しない(一方向 authority)。将来「特定の
信頼できる外部ユーザからの指示は受け付ける」といった権限付与をしたい、
という要望がある([ADR-0028](../adr/0028-external-human-messaging.md)
Neutral)。受付を許すと
[external-human-agent-consumes-input](external-human-agent-consumes-input.md)
とも接続する。

## 選択肢

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | 当面すべて受付拒否(一方向 authority) | 最安全・実装なし | 外部から agent を動かせない |
| B | contact 単位 / サービス単位で受付権限を付与 | 信頼済みの人からの delegation | 権限管理・なりすまし対策・injection 面の設計が要る |

## 影響

- 受付権限を認める場合、外部入力が authority を持つため firewall モデルの
  再設計と [ADR-0028](../adr/0028-external-human-messaging.md) の追補/supersede
  を伴う。

## 判断材料

- 誰を信頼するかの identity 検証(Discord user id の確度・なりすまし耐性)。
- 権限の粒度(調査のみ / 非破壊 / 破壊)と operator 監査の必要度。

## 暫定方針

**A(すべて受付拒否)**。当面は一方向 authority を維持する。

## 解決時のアクション

- [ ] Decision recorded in ADR(受付権限モデルの導入)
- [ ] `../specs/protocol-external-human.md` に受付権限の仕様を追加
