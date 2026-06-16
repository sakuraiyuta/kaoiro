---
title: subagent/workflow タスクのクライアント通知
description: ラップ対象が起動する subagent/workflow の存在・同時実行数・種別/名前・状態を専用 envelope でクライアントへ通知する仕様。
status: provisional
related: [protocol, agent-sdk-events, subagent-task-envelope-schema, subagent-task-aggregation]
---
<!-- markdownlint-disable MD033 -->

# subagent/workflow タスクのクライアント通知

## Purpose

ラップ対象の Claude Code が Task ツールで起動する subagent / ローカル workflow の
活動(起動した事実・同時実行数・走っている種別/名前・状態)を、wrapper が SDK
メッセージから検知してクライアントへ通知する。決定の正本は
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)。

## Definition

### 源データ(SDK メッセージ)

親セッションの `query()` メッセージ列に流れる。詳細は
[agent-sdk-events](agent-sdk-events.md)。

| メッセージ | type/subtype | 主なフィールド |
|---|---|---|
| 起動 | system / task_started | `task_id`, `description`, `subagent_type`, `task_type`, `workflow_name`, `tool_use_id`, `skip_transcript` |
| 進捗 | system / task_progress | `subagent_type`, `usage{total_tokens,tool_uses,duration_ms}`, `last_tool_name`, `summary` |
| 終了 | system / task_notification | `status`(completed/failed/stopped), `summary`, `usage` |

現状 `wrapper/src/adapter.ts` はこれらを破棄しており、ここにパース経路を新設する。

### エンティティモデル

subagent / workflow は「視覚表現は独立した別の存在」「identity / transport は親
エージェントに紐づく**子エンティティ**」(ADR-0019 F1)。各タスクは親 `agent_id` 参照
でリンクし、ライフサイクルは親セッションに束縛。視覚表現の決定はクライアント責務。

### 専用 envelope type(予約)

タスクのライフサイクルは**専用 envelope type**で流す(ADR-0019 F2)。親の
`state_change` は親自身の `KaoiroState` のまま不変。正式名称・スキーマは未確定
([subagent-task-envelope-schema](../open-questions/subagent-task-envelope-schema.md))。
暫定方針は単一 type + subtype(started/updated/completed)。運ぶフィールド(暫定):
親 `agent_id` / `task_id` / タスク種別 / `subagent_type` / `workflow_name` /
`description` / `status` / `usage` / `last_tool_name` / `summary` / `skip_transcript`。
[protocol](protocol.md) には予約追補(同一 `version`)として載せる。

### 同時実行数とライフサイクル

- 同時実行数 = `task_started`(+1)/ `task_notification`(-1)。トップレベルのみの
  フラット集計(ネストは追わない)。
- 通知する状態は**粗いライフサイクル**: running / completed / failed / stopped +
  進捗メタ(ADR-0019 F3)。細粒度の subagent 状態(8 状態)は対象外。
- `skip_transcript`(ambient/housekeeping)は通知するがフラグで区別できるようにする。

### 実装段階(フィーチャ内ローカル)

グローバルな `plans/` のロードマップ phase 番号とは別軸。

| 段階 | 範囲 | in / out |
|---|---|---|
| 段階1: wrapper + protocol | 検知・配信の最小スライス | in: adapter が task_* を解釈 / 専用 envelope の発行 / 同時実行数の算出 / 親 state_change が不変 / adapter 変換の単体テスト(vitest) / protocol・agent-sdk-events 追補。out: server 集約・クライアント表示 |
| 段階2: server 集約・中継 | 子タスクの保持と配信 | in: 親に紐づく子エンティティとして集約 / active set 維持 / クライアントへ中継 / 後続接続へのスナップショット。out: クライアント視覚表現 |
| 段階3: client 受信 | 受け口のみ | in: 専用 envelope を受信し描画できる最小受け口。out: 具体的なキャラ/従者表現の意匠(クライアント責務) |

### 要検証(段階1 着手項目)

- workflow が内部で spawn する子エージェントが、同一セッションの**別 `task_started`**
  として出るか実 stream で検証する。出ない場合は workflow を単一タスクとして扱う。

## Constraints

- MUST: 親エージェントの `state_change`(`KaoiroState`)に影響を与えない。
- MUST: 専用 envelope type は予約追補とし、protocol の `version` を据え置く
  ([ADR-0010](../adr/0010-protocol-precisification.md) /
  [ADR-0015](../adr/0015-protocol-version-stamping.md))。
- SHOULD: `skip_transcript` タスクはフラグで区別できるようにする。

## Open Questions

- [subagent-task-envelope-schema](../open-questions/subagent-task-envelope-schema.md)
  — 新 envelope type の名称/スキーマ(high)。
- [subagent-task-aggregation](../open-questions/subagent-task-aggregation.md)
  — server 集約・進捗間引き・スナップショット機構(medium)。

## See Also

- 関連 specs: [protocol](protocol.md), [agent-sdk-events](agent-sdk-events.md)
- ADR: [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
