---
title: task envelope の正式名称と payload スキーマ
status: accepted
date: 2026-08-04
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, subagent-tasks, agent-sdk-events]
related_adrs: [10, 15, 19, 48, 49]
---

# ADR-0047 — task envelope の正式名称と payload スキーマ

## Status

Accepted (2026-08-04、マスターとの相談で決定。kaoiro issue #180)。
[ADR-0019](0019-subagent-workflow-entity-and-task-envelope.md) F2 の
「専用 envelope type」の名称とスキーマを確定する追補。

## Context

ADR-0019 で subagent / workflow を親付き子エンティティとして専用 envelope
type で通知する方針(transport=(i))は決定済み。残っていた論点は type の
正式名称と payload スキーマの具体形だった。protocol への掲載は予約追補
([ADR-0010](0010-protocol-precisification.md))であり、`version` は据え置く
([ADR-0015](0015-protocol-version-stamping.md))。

判断材料: 既存 type(state_change / log / permission_request / result)は
いずれも単一 type 設計で、subtype 分岐の前例は薄い。protocol のバージョニング
方針は「予約 type の追補は同一 version」。将来、Claude Code の Tasklist
(todo)可視化(kaoiro issue #188)を同じ枠に載せたい。

## Decision

### F1: 単一 type `task` + `payload.kind`

起動 / 更新 / 完了は type を分けず、単一 type `task` の
`payload.kind`(`started` / `updated` / `completed`)で区別する。
protocol で予約済みの名称 `task` をそのまま正式名称とする。

### F2: payload の必須フィールド

全 kind 共通の必須フィールドは次の 4 つとする。

- `agent_id` — 親エージェント参照(ADR-0019 F1 の子エンティティリンク)。
  envelope 外枠の `agent_id` と一致するが、payload 単体で取り回される場面
  (server 集約・snapshot)で自己完結するよう payload にも持つ。
- `task_id` — 親セッション内で一意なタスク ID。
- `task_type` — タスク種別(F4)。
- `status` — 粗いライフサイクル状態
  (`running` / `completed` / `failed` / `stopped`、ADR-0019 F3)。

### F3: 進捗メタは optional

`subagent_type` / `workflow_name` / `description` / `usage` /
`last_tool_name` / `summary` / `skip_transcript` は optional の進捗メタと
する。kind ごとに SDK 側で得られるフィールドが異なる
([agent-sdk-events](../specs/agent-sdk-events.md))ため、必須にしない。

### F4: `task_type` は拡張可能 enum

初期値は `subagent` | `workflow`。閉じた enum にはせず、追補で値を追加
できる(`tasklist` は [ADR-0049](0049-tasklist-on-task-envelope.md) で
追加決定)。
受信側は未知の `task_type` を破棄せず、汎用のタスク表示へフォールバック
する(前方互換)。

## Consequences

### Positive

- protocol の「type と payload」表へ正式行を追補でき、段階1
  (wrapper + protocol)の実装に着手できる。
- 単一 type のため受信側の分岐が薄く、既存 type 群の設計と揃う。
- `task_type` の拡張余地により #188(Tasklist)を同じ envelope に載せられる。

### Negative

- kind により optional フィールドの有無が変わるため、受信側は
  フィールド存在チェックが要る。

### Neutral

- 予約追補のため protocol `version` は据え置き。未知 type を無視する
  既存クライアントには影響しない。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 起動/更新/完了を別 type に分ける | type enum が膨張し、既存の単一 type 設計と揃わない。受信側の分岐も増える |
| type 名 `subagent` | workflow や将来の tasklist を包含できない名称 |
| type 名 `agent_task` | 予約済み `task` からの改名利得がなく冗長 |
| 進捗メタも必須にする | kind ごとに SDK から得られないフィールドがあり、wire を不必要に厚くする |

## Related

- spec: [protocol](../specs/protocol.md)(type と payload 表)、
  [subagent-tasks](../specs/subagent-tasks.md)(フィーチャ仕様)、
  [agent-sdk-events](../specs/agent-sdk-events.md)(源メッセージ)。
- 関連 ADR: [0019](0019-subagent-workflow-entity-and-task-envelope.md)
  (エンティティモデルと transport の決定元)、
  [0048](0048-task-aggregation-delivery.md)(server 集約・配信)、
  [0010](0010-protocol-precisification.md) /
  [0015](0015-protocol-version-stamping.md)(予約追補・version 方針)。
- 由来: open-question subagent-task-envelope-schema(2026-06-16 起票)を
  本 ADR へ昇格。
