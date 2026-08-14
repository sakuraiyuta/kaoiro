---
title: subagent/workflow タスクのクライアント通知
description: ラップ対象が起動する subagent/workflow の存在・同時実行数・種別/名前・状態を専用 envelope でクライアントへ通知する仕様。
status: accepted
related: [protocol, agent-sdk-events]
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

`wrapper/claude-code/src/adapter.ts` の `sdkMessageToTask` がこれらを
`task` envelope へ導出する(2026-08-09、issue #180 で実装)。実測で
判明した未文書化フィールド(`task_started.prompt` /
`task_notification.output_file`)と 4 番目の subtype `task_updated` の
扱いは [agent-sdk-events](agent-sdk-events.md) と
[ADR-0047](../adr/0047-task-envelope-schema.md) /
[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md) の
addendum を参照(いずれも意図的に非配線・対象外)。`task_notification`
の `status` が既知 3 値以外を運んできた場合の terminal fallback +
`raw_status` の扱いも [ADR-0047](../adr/0047-task-envelope-schema.md)
addendum を参照。

### エンティティモデル

subagent / workflow は「視覚表現は独立した別の存在」「identity / transport は親
エージェントに紐づく**子エンティティ**」(ADR-0019 F1)。各タスクは親 `agent_id` 参照
でリンクし、ライフサイクルは親セッションに束縛。視覚表現の決定はクライアント責務。

### 専用 envelope type `task`

タスクのライフサイクルは**専用 envelope type** `task`で流す(ADR-0019 F2)。
親の `state_change` は親自身の `KaoiroState` のまま不変。スキーマは
[ADR-0047](../adr/0047-task-envelope-schema.md) で確定:

- 単一 type `task` + `payload.kind`(`started` / `updated` / `completed`)。
- 必須: 親 `agent_id` / `task_id` / `task_type` / `status`。
- optional 進捗メタ: `subagent_type` / `workflow_name` / `description` /
  `usage` / `last_tool_name` / `summary` / `skip_transcript`。
- `task_type` は拡張可能 enum。SDK 実測値は `local_agent` / `local_workflow`
  / `local_bash`(ADR-0047 F4 の例示値 `subagent`/`workflow` とは異なるが、
  リネーム層を挟まず SDK 生値をそのまま通す — 同 ADR addendum)。将来
  tasklist 等を追補可。受信側は未知値を汎用表示へフォールバック。

[protocol](protocol.md) には確定追補(同一 `version`)として載せた。
`kind=updated` は wrapper 発行側で一定間隔 + 差分閾値により間引く
(`started` / `completed` は即時、
[ADR-0048](../adr/0048-task-aggregation-delivery.md) F2)。実装値:
3 秒 + トークン差分 500 以上/tool 名変化のいずれか
(`wrapper/claude-code/src/host.ts`
`MIN_TASK_UPDATE_INTERVAL_MS` / `TASK_UPDATE_TOKEN_DELTA_THRESHOLD`)。
ある `task_id` に対する**最初の** `updated`(直前の間引き実績が無い)は
間隔・閾値のどちらにも関わらず常に即時発行する
(`#shouldEmitTaskUpdate` の cold-start 分岐) —
起動直後の進捗を operator が最初の 3 秒間待たされないため。

### 配信先: operator 限定

`task` envelope のライブ配信・snapshot の `tasks` キー(段階2)は
**operator 限定**で、viewer には配信しない
([ADR-0048](../adr/0048-task-aggregation-delivery.md) addendum、
[ADR-0021](../adr/0021-role-information-disclosure-policy.md))。

### 同時実行数とライフサイクル

- 同時実行数 = `task_started`(+1)/ `task_notification`(-1)。トップレベルのみの
  フラット集計(ネストは追わない)。
- 通知する状態は**粗いライフサイクル**: running / completed / failed / stopped +
  進捗メタ(ADR-0019 F3)。細粒度の subagent 状態(8 状態)は対象外。
- `skip_transcript`(ambient/housekeeping)は通知するがフラグで区別できるようにする。

### 実装段階(フィーチャ内ローカル)

グローバルな `plans/` のロードマップ phase 番号とは別軸(採番は
[phase-32](../plans/phase-32-subagent-workflow-visibility.md))。

| 段階 | 範囲 | 状態 | in / out |
|---|---|---|---|
| 段階1: wrapper + protocol | 検知・配信の最小スライス | 実装済み | in: adapter が task_* を解釈 / 専用 envelope の発行 / 同時実行数の算出 / 親 state_change が不変 / adapter 変換の単体テスト(vitest) / protocol・agent-sdk-events 追補。out: server 集約・クライアント表示 |
| 段階2: server 集約・中継 | 子タスクの保持と配信 | 実装済み | in: フラットな task テーブル + 親 `agent_id` 参照で集約([ADR-0048](../adr/0048-task-aggregation-delivery.md) F1)/ active set 維持(親離脱時に破棄)/ クライアントへ中継 / 後続接続へは既存 snapshot 枠で接続時一括送信(同 F3)/ operator 限定配信(同 addendum)。out: クライアント視覚表現 |
| 段階3: client 受信 + 頭上リング UI(AgentCard) | AgentCard に稼働中サブエージェントを可視化 | 実装済み | in: `task` envelope の受信・`AgentGridShell`→`AgentCard` への活性タスク数の受け渡し(`App.svelte` の専用 accumulator、`agents` map へは folding しない)/ `AgentCard.svelte` の `.sprite` を包む頭上リング(CSS-only の光点周回アニメーション、画像アセット無し、`prefers-reduced-motion` は既存グローバル規則が自動でカバー)/ on-off のみで数値表示はしない。out: 数値表示(活性タスク数の表示)、`AgentDetail` への追加表示(当時は issue #180 のスコープ外としたが、段階4 で取り込んだ — マスター未承認の判断だったため) |
| 段階4: 頭上リング UI(AgentDetail 追加) | AgentDetail にも稼働中サブエージェントを可視化(issue #180 follow-up、2026-08-10 — マスターが 2026-08-04 に issue #180 で検討要望していたが段階3実装時に取り込まれず、マスター指摘で判明・追加) | 実装済み | in: `AgentCard`/`AgentDetail` 共有の `TaskRing.svelte`(頭上リングの markup + CSS + `@keyframes` を1箇所に集約、`@keyframes` の複製を避ける)/ `AgentDetail.svelte` の `.portrait` に頭上リングを配置(`{#key}` の外、AgentCard と同じく on-off のみ)/ `.portrait` は幅が可変(デスクトップは `.status` の flex 比率、tablet 以下は `max-width: 8rem`)なので `container-type: inline-size` を付与し軌道半径を `cqw` で指定 — sprite は表示要素に対する軌道比率(AgentCard の 2rem/8rem 等と同一比率)、face は face 自身の寸法比(AgentCard は独立した 5.4rem 要素、AgentDetail は .portrait 幅の 70%)を保って cqw 化した値(ふじ round1 N1)。ただしデスクトップは `.status` の幅可変で `.portrait` が 8rem を大きく超えうるため、`cqw` だけだと軌道が肥大しはみ出す不具合をマスター実機確認(2026-08-10)で検出 — `min(cqw値, AgentCard絶対値)` で上限キャップし、8rem 超のデスクトップでは AgentCard と同じ絶対サイズに頭打ちさせる。キャップ後も `.portrait` の padding(0.8rem)が AgentCard の `.card`(1.4rem)より狭く実測ではみ出しが残ったため、`TaskRing.svelte` に `topOffset` prop(既定 `-2%`)を追加し AgentDetail からは `topOffset="6%"` で頭上退避のアンカーを顔寄りへシフト、Playwright T11(1600px 幅広デスクトップ + 844px BottomSheet 表示、sprite/face 両分岐、アニメーションを最遠点に静止させ `.bar` との非重なりを固定、修正前の値で実際に失敗することも確認済み。狭幅側は「広い方で安全だから比例して安全」と実測せず結論せずクロエ round2 指摘で追加検証、実測上は `.bar` と `.portrait`(BottomSheet)が空間的に離れており同時発生しない)で検証/ `App.svelte` から `protocol.ts` の純関数 `activeTaskCountForDetail()` 経由で配線し、disconnected/directory-only なタイルでは強制的に 0 にする(素通し配線だと切断済みエージェントの stale `tasks` エントリが漏れる経路があるため)。out: 数値表示(活性タスク数の表示、段階3から変更なし) |

### 要検証(未解決、#180 スコープ外)

- workflow が内部で spawn する子エージェントが、同一セッションの**別 `task_started`**
  として出るか実 stream で検証する。出ない場合は workflow を単一タスクとして扱う。
  issue #180 の実測は「終端通知の保証」(subagent kill/background/
  interrupt の 4 経路、[agent-sdk-events](agent-sdk-events.md))に
  絞っており、この項目は未検証のまま残る。

## Constraints

- MUST: 親エージェントの `state_change`(`KaoiroState`)に影響を与えない。
- MUST: 専用 envelope type は予約追補とし、protocol の `version` を据え置く
  ([ADR-0010](../adr/0010-protocol-precisification.md) /
  [ADR-0015](../adr/0015-protocol-version-stamping.md))。
- SHOULD: `skip_transcript` タスクはフラグで区別できるようにする。

## See Also

- 関連 specs: [protocol](protocol.md), [agent-sdk-events](agent-sdk-events.md)
- ADR: [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
  (エンティティモデル・transport)、
  [0047](../adr/0047-task-envelope-schema.md)(envelope スキーマ)、
  [0048](../adr/0048-task-aggregation-delivery.md)(server 集約・配信)
