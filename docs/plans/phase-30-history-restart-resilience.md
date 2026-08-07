---
title: Phase 30 — 表示履歴の再起動耐性 (ADR-0051)
description: server 再起動後の reconnect 時 replay・IA sidecar による DETS 撤廃・boot epoch による client バッファ置換を実装する。
status: draft
phase: 30
depends_on: []
last_updated: 2026-08-08
---

# Phase 30 — 表示履歴の再起動耐性 (ADR-0051)

## Goal

[ADR-0051](../adr/0051-history-restart-resilience.md) を実装する:
server 再起動を跨いでも全 operator 端末が同一の timeline を見られる
状態にし、`InterAgentHistory` DETS を撤廃して server の durable 状態を
削減する。

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 30-1 | ADR-0051 仕様レビュー | ふじ | ⏳ | 仕様段階レビュー(実装前)。マスター方針: レビューは仕様・実装の 2 段 |
| 30-2 | ADR 確定 + specs 改訂 | クロエ | ⏳ | protocol.md(`request_history_replay` + epoch field)/ protocol-inter-agent.md(sidecar 節、#105 差替え)/ architecture.md |
| 30-3 | deployment.md 等の機械的更新 | もも | ⏳ | DETS 8 種 → 7 種、ADR-0014 A4 への訂正参照追記 |
| 30-4 | wrapper: IA sidecar 記録 + 読出 | あお | ⏳ | agent-common に共通化、claude-code / codex 両対応 |
| 30-5 | wrapper: reconnect 時 replay 受け口 | あお | ⏳ | `request_history_replay` 受信 → 既存 replay 経路発火 |
| 30-6 | server: epoch 付与 + replay 要求 trigger + IA DETS 撤廃 | あお | ⏳ | 「履歴ゼロの agent の channel join」で要求。InterAgentHistory purge 経路も除去 |
| 30-7 | dashboard: epoch 置換 | あお | ⏳ | epoch 変化で local バッファ破棄、同一 epoch 内は既存 merge 維持 |
| 30-8 | docs 整合 sweep | もも | ⏳ | 実装後の README / specs 齟齬確認 |
| 30-9 | 実装レビュー | ふじ | ⏳ | must-fix ループ |
| 30-10 | dogfood 検証 | デフォルトくん + マスター | ⏳ | 検証シナリオは下記 |

Status legend: ✅ done, 🟡 in progress, ⚠ partial, ⏳ not started,
⛔ blocked.

## Acceptance Criteria

- [ ] server 再起動後、live wrapper の agent timeline が operator
      操作なしで現 session 分復元される(claude-code / codex 両方)
- [ ] IA バブルが sidecar 経由で復元され、`InterAgentHistory` DETS が
      コードベース・deployment doc から消えている
- [ ] 再起動前から開いていたタブが再起動前ログを表示し続けない
      (epoch 置換)。複数端末で同一表示になる
- [ ] server 稼働中の F5 全復元・端末間一致が従来どおり成立する
      (回帰なし)
- [ ] 全テスト green(server `mix test` / wrapper `pnpm test` /
      dashboard `pnpm test`)

## Dogfood 検証シナリオ (30-10)

1. 稼働中: 端末 2 台で同一 agent を表示 → 双方 F5 → 同一表示。
2. 再起動: 片方のタブを開いたまま server container を再起動 →
   wrapper 再接続後、開きっぱなしタブ・新規タブとも現 session 分が
   同一表示(亡霊なし)。
3. IA: agent 間で数往復させてから再起動 → IA バブルが復元される。
4. offline: wrapper を停止した agent は再起動後 offline tile +
   空 timeline → resume 操作で履歴復元(既存経路の回帰確認)。

## See Also

- ADR: [0051](../adr/0051-history-restart-resilience.md)
- 前提 ADR: [0014](../adr/0014-session-resume-and-restore.md),
  [0030](../adr/0030-agent-directory-and-explicit-restore.md)
- Specs: [protocol](../specs/protocol.md),
  [protocol-inter-agent](../specs/protocol-inter-agent.md),
  [deployment](../specs/deployment.md)
