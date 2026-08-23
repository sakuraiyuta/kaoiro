---
title: Phase 32 — 内部 subagent/workflow 稼働の可視化
description: Task ツールで起動する subagent/workflow の存在・状態を wrapper が検知し、server 集約を経て dashboard の頭上リングとして可視化する。
status: in_progress
phase: 32
depends_on: []
last_updated: 2026-08-10
---

# Phase 32 — 内部 subagent/workflow 稼働の可視化

## Goal

[issue #170](https://github.com/sakuraiyuta/kaoiro/issues/170)
を実装する。エージェントが Task ツールで起動する subagent / ローカル
workflow の活動を、wrapper が SDK メッセージから検知し、専用 envelope
`task` で server 集約・operator 限定配信を経て、dashboard の
`AgentCard`/`AgentDetail`(32-5)に「頭上リング」(CSS-only の光点周回アニメーション)として
可視化する。決定の正本は [ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
(エンティティモデル・transport)、[ADR-0047](../adr/0047-task-envelope-schema.md)
(envelope スキーマ)、[ADR-0048](../adr/0048-task-aggregation-delivery.md)
(server 集約・配信、operator 限定)。フィーチャ仕様は
[subagent-tasks](../specs/subagent-tasks.md)。

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 32-1 | wrapper: `task_started`/`task_progress`/`task_notification` の解釈 + `task` envelope 発行 | あお | ✅ | `wrapper/claude-code/src/adapter.ts` の `sdkMessageToTask`(純粋関数)、`wrapper/agent-common` の `makeTask`。`kind=updated` は host.ts で 3 秒 + トークン差分 500/tool 名変化のいずれかで間引き。未知 subtype(`task_updated`)は fail-visible に warn ログのみで同時実行数カウントには一切関与させない(ADR-0019 addendum、変更なし)。`task_notification` の未知 status は M2 fix-round(2026-08-09、ふじ round1)で terminal fallback へ変更 — 既知 3 値(completed/failed/stopped)以外は status="failed" として扱い、生の値は raw_status にログ用途のみで保持する(wire には出さない)。この経路は completed 相当としてカウントに反映される(-1)ため、当初の「カウントに一切関与させない」は task_notification の未知 status には当てはまらない |
| 32-2 | server: `TaskStates` GenServer(フラット task テーブル) + wrapper_channel/agents_channel 配線 | あお | ✅ | `server/lib/kaoiro_server/task_states.ex` 新規。`WrapperChannel.terminate/2` が `AgentStates.disconnect/3` の owner-check 成立時のみ `TaskStates.discard_for_agent/1` を呼ぶ(ADR-0048 F1)。`AgentsChannel` の snapshot push へ `tasks` キーを追加、operator のみ非空(viewer は既存 fail-closed キャッチオールで `type: "task"` そのものも drop、ADR-0021) |
| 32-3 | dashboard: `task` envelope 受信 + `AgentCard` 頭上リング | あお | ✅ | `protocol.ts` に `TaskPayload`/`taskOf`/`parseTasks`/`applyTaskEnvelope`。`App.svelte` は `tasks` を `agents` とは別の accumulator として保持(ADR-0019 F2: 親の state_change slot を上書きしない)。`AgentCard.svelte` は `.sprite`/`.face` を包む `.sprite-slot`(position: relative)+ `.task-ring`(`translate` ベース 12 段 keyframes で楕円軌道を周回、画像アセット無し。32-5 で共有コンポーネント `TaskRing.svelte` へ抽出)。`prefers-reduced-motion` は `app.css` の既存グローバル規則(`animation-duration: 0.01ms !important` 等)でカバーされ、per-component override 不要。activeTaskCount は on/off のみに使い、数値表示はしない(こはくスコープ判断) |
| 32-4 | docs: spec/ADR addendum・protocol.md 確定化・本 plan | あお | ✅ | [subagent-tasks](../specs/subagent-tasks.md) の段階1〜3 を実装済みへ更新、[agent-sdk-events](../specs/agent-sdk-events.md) に実測フィールド(`prompt`/`output_file`/`task_updated`)と終端通知保証の実測記録を追補、ADR-0019/0047/0048 に addendum(それぞれ task_updated 対象外・task_type 実測値と prompt/output_file 非配線・operator 限定配信) |
| 32-5 | follow-up: `AgentDetail` への頭上リング追加(マスター指摘、取りこぼし修正) | あお | 🔄 | 詳細は下記「Follow-up」節。指揮 クロエ、レビュー ふじ、実装 あお。レビュー中 |

**未完了(status を `done` に上げない理由)**: 32-1〜32-4 の実装・単体テストは
完了しているが、issue #170 全体としてはこはくへの完了報告・外部レビュー
(ふじ = wrapper/server、クロエ = UI の要否はこはく判断)・commit 承認・
push が未了。

## 実測で確定した設計判断(ADR 本文と併記、要参照)

段階1 実装時、実 SDK(`@anthropic-ai/claude-agent-sdk@0.3.220`)を実測し
確認した 3 点。詳細と根拠は各 ADR addendum を正本とする(ここでは要約の
み、内容の重複記載はしない):

1. `task_started.prompt` / `task_notification.output_file` は未文書化
   フィールドとして実在するが、`task` envelope へは配線しない
   ([ADR-0047](../adr/0047-task-envelope-schema.md) addendum)。
2. `task_type` の実測値は `local_agent`/`local_workflow`/`local_bash`
   (ADR-0047 F4 の例示値とは異なる)。リネームせず SDK 生値をそのまま
   通す(同 addendum)。
3. 未文書化の 4 番目の subtype `task_updated` は v1 の対象外
   ([ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)
   addendum)。`task_notification` は自然完了 / `stopTask()` / interrupt
   / `backgroundTasks()` の 4 経路すべてで終端に必ず発行されることを
   実測済み(SDK 0.3.220、2026-08-09 capture、
   [agent-sdk-events](../specs/agent-sdk-events.md))。

## Non-Goals(#170 スコープ外、こはく判断)

- Codex エンジンでの同等対応: 実測(`@openai/codex-sdk@0.144.1` の型
  定義に subagent/task lifecycle 相当のイベントが存在しないことを確認)
  のみ行い、実装はしない。
- 活性タスク数の数値表示: 将来の別提案とし今回は対象外。
- `AgentDetail` への追加表示: 当初 32-3 実装時にスコープ外としたが、
  マスター未承認の判断だったことが判明し 32-5(下記 Follow-up)で追加
  した。
- workflow が spawn する子エージェントが別 `task_started` として出るか
  の検証([subagent-tasks](../specs/subagent-tasks.md)「要検証」節)は
  未着手のまま残る。

## Follow-up: `AgentDetail` 頭上リング追加 (2026-08-10)

`AgentCard`(グリッド表示)には 32-3 で頭上リングを実装したが、
`AgentDetail`(ペルソナ画像の詳細パネル)には実装されず、上記 Non-Goals
に「将来の別提案」として記載されていた。しかしこの除外はマスターの承認
を得たものではなかった: issue #170 の
[2026-08-04 コメント](https://github.com/sakuraiyuta/kaoiro/issues/170#issuecomment-5384483995)
でマスター自身が「AgentDetail にも出すか」を優先検討事項として明記して
いたが、同日 ADR へ昇格した open question 2 件(ADR-0047/0048)には
含まれず、2026-08-09 の実装(32-1〜32-4)にも取り込まれないまま
Non-Goals へ回った。2026-08-10、マスターが実機確認でこの欠落に気付き
「そんな仕様にした覚えがない」と指摘 — issue コメント履歴を追跡した結果、
取りこぼしと判断し追加した(仕様変更ではなく、当初スコープの回収)。

体制: 指揮 クロエ(direction/軽微な意思決定)、レビュー ふじ、実装 あお。

実装: `TaskRing.svelte` を新設し `AgentCard`/`AgentDetail` で共有(CSS
`@keyframes` の複製を避ける、クロエ 2026-08-10)。軌道半径は
`AgentDetail` 側は `.portrait` の可変幅に追随させるため `cqw`
(container query width)で指定し、`.portrait` に
`container-type: inline-size` を付与。`activeTaskCount` は
`App.svelte` から `protocol.ts` の新規純関数 `activeTaskCountForDetail()`
経由で配線し、disconnected/directory-only なタイルでは強制的に 0 にする
(クロエ 2026-08-10: 素通し配線だと切断済みエージェントの stale `tasks`
エントリが漏れる経路がある)。

**追加修正 (マスター実機確認、2026-08-10)**: デスクトップは `.status`
の幅可変(`flex: 0 0 20%`)により `.portrait` の実測幅が 8rem を大きく
超えることがあり、`cqw` だけだと軌道が AgentCard の想定サイズより肥大
して「グリッドへ戻る」ボタンにまで到達してしまう不具合を発見。
`min(cqw値, AgentCard絶対値)` で上限キャップし、8rem 以下の狭い
`.portrait` では引き続き cqw で比例縮小、8rem を超えるデスクトップでは
AgentCard と同じ絶対サイズ(sprite: 2rem/0.72rem、face: 1.35rem/0.49rem)
に頭打ちさせる。

キャップ後も実測でわずかにはみ出しが残った(`.portrait` の padding
0.8rem が AgentCard の `.card` の 1.4rem ほど広くないため)。
`TaskRing.svelte` に新規 `topOffset` prop(既定は AgentCard 既存の
`-2%`)を追加し、AgentDetail からは `topOffset="6%"` を渡して頭上退避の
アンカーを下(顔寄り)へシフトすることで解消した(顔に多少かかるのは
マスター了承済み)。Playwright e2e に T11(1600px 幅広デスクトップ、
sprite/face 両分岐)を新設し、CSS アニメーションを Web Animations API
で最遠点(0%/100% キーフレーム)に静止させ、box-shadow の 6px ブラー
込みで `.bar`(戻るボタン)に重ならないことを固定(修正前の値に戻すと
実際に失敗することも確認済み)。

**狭幅側の検証 (クロエ round2 指摘、2026-08-10)**: `topOffset` の絶対
寄与(6% × portrait 高さ)は portrait が大きいほど効く一方、
`orbitRy` はキャップで一定(0.72rem)なので、`.portrait` が
`max-width: 8rem` になる BottomSheet モードは理論上ワースト側になり
うる。「広い方で安全だから比例して安全」と実測せず結論しない方針
(クロエ自身が cqw の上限を実測せず判断したことが今回の不具合の原因、
という自己指摘あり)で 844px sheet-open でも同じ幾何チェックを T11 へ
追加。実測では `.bar` はページ最上部固定、`.portrait` は BottomSheet
として画面下部にオーバーレイされ 300px 超のマージンがあり、
8rem キャップと `.bar` 隣接は同一レイアウトで同時に起こらないことを
確認(8rem キャップは常に BottomSheet モード側でのみ有効)。

## Related

- spec: [subagent-tasks](../specs/subagent-tasks.md)、
  [protocol](../specs/protocol.md)、
  [agent-sdk-events](../specs/agent-sdk-events.md)。
- ADR: [0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md)、
  [0047](../adr/0047-task-envelope-schema.md)、
  [0048](../adr/0048-task-aggregation-delivery.md)、
  [0021](../adr/0021-role-information-disclosure-policy.md)
  (operator 限定配信が適用する fail-closed 既定)。
