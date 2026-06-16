---
title: Phase 3.5 — 返答表示(同梱ダッシュボードの実用化)
description: エージェント応答テキストを中継・表示し、同梱ダッシュボードを単体で最低限実用にする。既定タイル一覧→詳細窓。
status: in_progress
phase: 3.5
depends_on: [phase-3-server-multiagent]
last_updated: 2026-06-16
---

# Phase 3.5 — 返答表示(同梱ダッシュボードの実用化)

## Goal

指示への返答(エージェント応答テキスト)を中継・表示し、「指示は届くが何と
答えたか見えない」状態を解消する。既定はタイル一覧、クリックで全画面詳細(返答
ログ)。方向性と線引きは [ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)。

## Acceptance Criteria

- [x] 返答はチャット風 `log` ストリーム(`assistant` 逐次 + tool 入出力は
      折りたたみ/展開)
- [x] 再読込・再接続で返答ログが復元される(サーバ インメモリ履歴 A)
- [x] 返答ログは operator のみ閲覧(viewer はグリッド止まり)
- [x] 全画面詳細中も他エージェントの要対応に気付ける(盲点インジケータ)
- [ ] 任意の1体へ指示 → その返答が同梱ダッシュボードで読める(end-to-end)
      — 実装完了(各層のテスト green)。実機ブラウザ + wrapper の e2e は
      未実施(残る検証ステップ)。

## Tasks

### Stage MVP(issue #13 解消)

| # | Task | Status | Notes |
|---|------|--------|-------|
| R-1 | protocol: `log`/`result` payload を予約→定義、operator 限定配信 | ✅ | [protocol](../specs/protocol.md)。`log.kind` = assistant/tool_use/tool_result |
| R-2 | wrapper: assistant テキスト・tool_use/tool_result・result を中継 | ✅ | SDK メッセージ→`log` 種別マッピングは [agent-sdk-events](../specs/agent-sdk-events.md)。`d5d120c` |
| R-3 | server: `AgentStates` にインメモリ・リングバッファ履歴、join で snapshot + 履歴、log/result の operator role フィルタ | ✅ | 新規 DB 依存なし。永続は issue #24。`7410d68`/`f7af05f` |
| R-4 | dashboard: grid→クリック→全画面詳細窓(チャット風ログ・tool 折りたたみ・指示・承認・盲点インジケータ) | ✅ | カードは顔・名前・状態・agent_id を表示(指示入力は 2026-06-16 に撤去)。指示・承認の操作は詳細。`8319576` |

MVP 実装完了(wrapper 68 / server 70 / dashboard 13 tests green)。レビュー
サイクル各段消化。surface した security 3 件は #26/#28 を実装(`0e81680`)、
# 27 は据置候補。残るは実機 e2e 検証と Stage ポリッシュ(issue #21)。

### Stage ポリッシュ(issue #21 = ゲーム風 UI)

| # | Task | Status | Notes |
|---|------|--------|-------|
| R-5 | タイル→詳細のアニメ/モーフ遷移 | ⏳ | 遷移は MVP では簡易表示でも可 |
| R-6 | Wizardry 風の枠線 UI の作り込み | ⏳ | issue #21 |
| R-7 | 盲点インジケータ色の最緊急追従の調整 | ⏳ | error > waiting_permission > 他 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- 履歴ディスク永続(再デプロイ耐性)は issue #24(仕様策定込み)。
- 3列グリッド + 最新応答タイムラインは issue #25。
- Claude Code 独自の token/context 可視化は issue #16(`ext` 経由)。

## Open Questions Blocking This Phase

なし([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md) で解決)。

## See Also

- ADRs: [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0010](../adr/0010-protocol-precisification.md)
- Specs: [protocol](../specs/protocol.md),
  [non-goals](../specs/non-goals.md),
  [threat-model](../specs/threat-model.md)
- Previous: [phase-3-server-multiagent](phase-3-server-multiagent.md)
