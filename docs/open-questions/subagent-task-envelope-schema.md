---
title: subagent/workflow タスク用 envelope type の名称とスキーマ
description: タスク通知用の専用 envelope type の正式名称と payload スキーマの確定。transport=(i) 専用 type は決定済み。
status: open
urgency: high
blocks: [subagent-tasks]
opened: 2026-06-16
decided: null
---

## 背景

[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md) で「専用
envelope type で subagent/workflow を通知する」(transport=(i))は決定済み。残る
論点は type の正式名称と payload スキーマの具体形。protocol の予約追補
([ADR-0010](../adr/0010-protocol-precisification.md))として載せ、`version` は据え置く
([ADR-0015](../adr/0015-protocol-version-stamping.md))。

## 選択肢

| 論点 | 案 |
|------|-----|
| type 構成 | (a) 単一 type(例 `"task"`)+ subtype(`started`/`updated`/`completed`) / (b) 起動/更新/完了を別 type に分ける |
| type 名 | `task` / `subagent` / `agent_task` 等 |
| payload | 親 `agent_id` / `task_id` / タスク種別(subagent/workflow/...)/ `subagent_type` / `workflow_name` / `description` / `status` / `usage` / `last_tool_name` / `summary` / `skip_transcript` の取捨 |

## 影響

protocol の「type と payload」表、wrapper の envelope 発行、server の集約・配信、
クライアントの受信受け口すべてに波及。段階1(wrapper+protocol)の前提。

## 判断材料

- 既存 type(state_change/log/permission_request/result)は単一 type 設計。subtype
  分岐の前例は薄いので (a) でも `payload.kind` で分ける手もある。
- protocol のバージョニング方針は「予約 type の追補は同一 version」。

## 暫定方針

(a) 単一 type + subtype。名称・payload 詳細は段階1 着手時に ADR-0019 を追補して確定。

## 解決時のアクション

- [ ] [protocol](../specs/protocol.md) の「type と payload」に正式行を追補
- [ ] [subagent-tasks](../specs/subagent-tasks.md) を accepted へ更新
- [ ] このファイルを削除(必要なら ADR-0019 を追補)
