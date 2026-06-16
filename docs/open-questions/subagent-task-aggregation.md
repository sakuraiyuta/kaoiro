---
title: subagent/workflow タスクの server 集約・配信
description: 子タスクの server 側保持モデル・進捗更新の間引き・後続接続クライアントへのスナップショット機構。
status: open
urgency: medium
blocks: [subagent-tasks]
opened: 2026-06-16
decided: null
---

## 背景

[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md) で subagent/
workflow を親付き子エンティティとして専用 envelope で通知する方針が決定。server が
active set を維持・配信する責務を負うが、その具体(保持モデル・更新頻度・スナップ
ショット)は未決。段階2(server 集約・中継)の前提。

## 選択肢

| 論点 | 案 |
|------|-----|
| 保持モデル | (a) 親 agent エンティティ配下の子コレクション / (b) フラットな task テーブル + 親 `agent_id` 参照 |
| 進捗の頻度 | `task_progress` を (a) 毎回流す / (b) 一定間隔・差分閾値で間引く(usage 頻繁更新による envelope 増を抑える) |
| スナップショット | 後続接続クライアントへの現在集合提供を (a) 接続時に server が active set を一括送信 / (b) 定期スナップショット envelope |

## 影響

server の状態保持・配信実装、クライアント protocol の追加分に波及。実害は段階2 まで
は出ないが、間引き方針は wrapper 側の発行とも整合が要る。

## 判断材料

- 既存の再接続再同期は `snapshot`(join 直後 push、agent_id ごと last-write-wins、
  [protocol](../specs/protocol.md))。子タスクも同じ枠に乗せられるか。
- server はメモリ保持(永続なし)。再起動で消える前提は既存と同じ。

## 暫定方針

スナップショットは (a) 接続時一括送信(既存 snapshot の枠に倣う)。保持モデル・
間引きは段階2 着手時に確定。

## 解決時のアクション

- [ ] server の保持モデルとクライアント protocol 追加分を確定
- [ ] [subagent-tasks](../specs/subagent-tasks.md) 段階2 を実装
- [ ] このファイルを削除
