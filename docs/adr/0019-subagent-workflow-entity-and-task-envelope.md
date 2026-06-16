---
title: subagent/workflow を親付き子エンティティとし専用 envelope type で通知
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, agent-sdk-events, subagent-tasks]
related_adrs: [10, 15]
---

# ADR-0019 — subagent/workflow の子エンティティ化と専用 envelope type

## Status

Accepted

## Context

ラップ対象の Claude Code は Task ツールで subagent / ローカル workflow を起動し、
内部で「AI チーム」を動かすことがある。現状 kaoiro はこの内部活動を一切可視化
していない。`wrapper/src/adapter.ts` の `sdkMessageToEvents` は `type:"system"` を
`subtype==="init"` 以外すべて破棄しており、タスク系メッセージを捨てている。

一方、親セッションの SDK メッセージ列には起動/進捗/終了が専用メッセージとして
流れる(検証済み、[agent-sdk-events](../specs/agent-sdk-events.md)):

- `system/task_started` — 起動。`task_id` / `description` / `subagent_type` /
  `task_type` / `workflow_name` / `tool_use_id` / `skip_transcript`
- `system/task_progress` — 進捗。`subagent_type` / `usage` / `last_tool_name` /
  `summary`
- `system/task_notification` — 終了。`status`(completed/failed/stopped) /
  `summary` / `usage`

これを拾ってクライアントへ届け、ゴール (A)「進捗・状態把握」の解像度を上げたい
(あるエージェントが今「何体・何を」走らせているかを見せる)。論点は (1) subagent を
どんなエンティティとして扱うか、(2) protocol へどう載せるか。

## Decision

- **エンティティモデル(F1)**: subagent / workflow は「視覚表現としては独立した
  別の存在」だが「identity / transport 上は親エージェントに紐づく**子エンティティ**」
  として扱う。各タスクは親への参照(parent `agent_id`)でリンクし、ライフサイクルは
  親セッションに束縛される。
- **transport(F2)**: タスクのライフサイクルを表す**専用 envelope type を新設**し、
  起動 / 更新 / 完了を個別イベントで流す。親エージェントの `state_change` は親自身の
  `KaoiroState` のまま据え置き、子タスク情報を相乗りさせない。
- **状態の粒度(F3)**: 通知する状態は**粗いライフサイクル**(running / completed /
  failed / stopped + 進捗メタ)に限る。細粒度の subagent 状態(thinking など 8 状態)は
  親 stream に出ず、非スコープ(将来 `getSubagentMessages` 経路で拡張余地)。
- **通知粒度(F4)**: クライアントへは走っているタスク一覧(`task_id` + 種別/名前 +
  `status` + 進捗メタ)を渡す。同時実行数は `task_started`(+1)/ `task_notification`
  (-1)から算出し、トップレベルのみのフラット集計とする。
- **データ範囲(F5)**: 進捗(`usage` / `last_tool_name` / `summary`)まで運ぶ。
- **責務分離**: 「存在と状態をクライアントへ通知する」のが wrapper / server の責務。
  subagent / workflow をどう視覚表現するかはクライアントが決める(既存の
  persona→sprite→表情の所有と同じ流儀、[overview](../specs/overview.md) の A/B 分離)。
- 新 envelope type の正式名称 / スキーマ詳細は
  [subagent-task-envelope-schema](../open-questions/subagent-task-envelope-schema.md)
  で確定する。**予約 type の追補**([ADR-0010](0010-protocol-precisification.md))
  にあたるため protocol の `version` は据え置く
  ([ADR-0015](0015-protocol-version-stamping.md))。

## Consequences

### Positive

- エージェントが内部で動かす AI チーム活動が可視化され、ゴール (A) の解像度が上がる。
- 専用 type により親状態と疎結合に保て、`state_change` の意味がぶれない。

### Negative

- server が子タスクの active set を維持・配信する責務を負う(集約方法は未決、
  [subagent-task-aggregation](../open-questions/subagent-task-aggregation.md))。
- envelope の type 種別が増える。

### Neutral

- 観測できるのは粗いライフサイクルのみ。細粒度状態は将来拡張の余地として残す。
- protocol は予約追補のため同一 `version`。受信側は未知 type を無視(前方互換)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| ペルソナ同格の独立トップレベルエンティティ | ライフサイクルが親に束縛・`task_id` が親内ローカル・観測状態が粗く、過剰約束になる |
| 親 `state_change` の `ext` に subagents 配列を同梱 | 親状態と結合し、subagent 単独更新時の発火を別途用意する必要が生じる |
| 同時実行数のみ通知 | 「どれが走っているか」を出せず、要求(種別/名前の識別)を満たさない |
| 細粒度 8 状態を `getSubagentMessages` 経由で通知 | 各 transcript の読込が要り v0 では重い。粗いライフサイクルで足りる |

## Related

- spec: [subagent-tasks](../specs/subagent-tasks.md)(フィーチャ仕様)、
  [protocol](../specs/protocol.md)(type と payload)、
  [agent-sdk-events](../specs/agent-sdk-events.md)(源メッセージ)。
- 関連 ADR: [0010](0010-protocol-precisification.md)(予約 type 方針)、
  [0015](0015-protocol-version-stamping.md)(version 据え置き)。
- 由来: my-idea-brief(走り書き「subagent/workflow の起動・体数・種別をクライアントへ
  通知」)。
