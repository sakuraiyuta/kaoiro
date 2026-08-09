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
- `task_id` — 親セッション内で一意なタスク ID。ingress 時の長さ上限
  (256 byte)は wire 契約の一部だが、正本は
  [protocol.md](../specs/protocol.md)「方向別メッセージ種別」の `task`
  行(server `WrapperChannel.@max_task_id_field_bytes`)— ここでは
  重複させない。
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

## Addendum (issue #180, 2026-08-09): F4 の実測値 + prompt/output_file の非配線

**F4 実測値。** 段階1 実装時、実 SDK
(`@anthropic-ai/claude-agent-sdk@0.3.220`)を実測したところ、
`task_started.task_type` の実際の値は F4 の例示値
(`subagent` | `workflow`)とは異なり `local_agent` / `local_workflow` /
`local_bash` だった。F4 は「拡張可能 enum・未知値は汎用表示へ
フォールバック」と明記しているため、SDK 生値へリネーム層を挟まず
そのまま通す方針とした(`wrapper/claude-code/src/adapter.ts` の
`sdkMessageToTask`)。リネームは「F4 が既に許容している未知値」に
無用な状態を足すだけで、実益がないと判断した。

**`prompt` / `output_file` の非配線。** 同じ実測で、`task_started` に
未文書化の `prompt`(起動した subagent への指示全文、内容そのもの)、
`task_notification` に未文書化の `output_file`(ローカルファイルパス)
が存在すると判明した。いずれも F2/F3 の必須・optional フィールドに
含めず、`task` envelope の payload には一切配線しない
(`sdkMessageToTask` が両フィールドを明示的に読まない)。理由: `prompt`
は内容そのもので F3 の「粗い進捗メタ」の粒度を超え、`output_file` は
ローカルファイルシステムパスで wrapper ホスト固有の情報を露出する。
将来これらを配線する場合は本 ADR の改訂が要る。

**由来**: kaoiro issue #180 実装セッション(あお、2026-08-09)。

## Addendum (issue #180, 2026-08-09): `task_notification` の未知 status は terminal fallback

**背景。** F2 の `status` は `running` / `completed` / `failed` /
`stopped` の粗い 4 値だが、`task_notification` が実際に運ぶ SDK 生の
`status` 文字列がこの 4 値に収まる保証はない(SDK バージョン差異・
将来の値追加)。外部レビュー(ふじ round1 M2)で、当初実装が未知の
`status` を単に `null`(=無視)へ倒していた点が指摘された ——
`task_notification` は F1 の 3 kind のうち唯一の**終端通知**であり、
これを無視すると対応する `started`/`updated` の task がクライアント側
`tasks` テーブルに残り続け、同時実行数カウントも下がらない(ゾンビ
task)。これは同 ADR 冒頭 F2 の「`task_notification` は終端」という
前提そのものと矛盾する。

**決定。** `task_notification` の `status` は常に終端(`kind: "completed"`)
として扱う。値が既知 3 値(`completed`/`failed`/`stopped`)のいずれかで
あればそのまま使い、それ以外(未知の文字列・非文字列)は
`status: "failed"` にフォールバックする — fail-visible(ゾンビ task の
方が「未知 status を無視」より実害が大きいため、より安全な側へ倒す)。
元の生値は `payload.raw_status` に保持するが、これはログ・デバッグ
用途限定で wire の必須スキーマ(F2)には含めない
(`wrapper/claude-code/src/adapter.ts` の `sdkMessageToTask`、
`host.ts` の `#applyTaskEvent` が `raw_status` 存在時に warn ログを
出す)。

[phase-32 plan](../plans/phase-32-subagent-workflow-visibility.md)
32-1 の当初記述「未知 subtype/status はカウントに一切関与させない」は
この決定より前の実装を指しており、`task_updated`(未知 subtype、対象外
のまま)には引き続き当てはまるが、`task_notification` の未知 status
には当てはまらない(plan 側も本 addendum に合わせて訂正済み)。

**由来**: kaoiro issue #180 外部レビュー対応(あお、2026-08-09、
ふじ round1 M2)。
