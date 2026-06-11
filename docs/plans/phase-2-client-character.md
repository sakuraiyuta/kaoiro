---
title: Phase 2 — クライアント + キャラ + 状態ベース表情
description: Web クライアントでエージェントをキャラ表示し、状態を表情へマッピングする。
status: in_progress
phase: 2
depends_on: [phase-1.5-minimal-server-client]
last_updated: 2026-06-11
# status stays in_progress until the kuroe mixed-touch evaluation
# (user review) closes the phase.
---

# Phase 2 — クライアント + キャラ + 状態ベース表情

## Goal

Web クライアント(TS)でエージェントをキャラ絵表示し、Phase 1 の状態変化を
表情として可視化する(感情 NLP はまだ無し)。

## Acceptance Criteria

- [x] 状態 → 表情のマッピングが動作する
- [x] ペルソナ(立ち絵セット)をクライアントに反映
- [x] 描画はペルソナごとの静的差分切り替え
- [x] 表情差分素材を ComfyUI で量産(状態別 + ペルソナ別)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2-1 | クライアント雛形(状態購読 → 表示) | ✅ | リファレンスダッシュボード(Svelte 5 + Vite、`server/assets/`、issue #12)。プロトコル層は Svelte 非依存の `protocol.ts` |
| 2-2 | 状態 → 表情マッピング | ✅ | スプライト版実装済(2026-06-11): [ADR-0008](../adr/0008-persona-asset-distribution.md) 第 1 段階のマニフェスト + 配信を実装し、カードはスプライト優先・CSS 顔フォールバック。`disconnected` は idle のグレースケール |
| 2-3 | ComfyUI による表情差分の量産 | ✅ | 3 ペルソナ x 7 状態 = 21 枚完成。`server/priv/personas/` へ正式配置済み。方針・規格・provenance は [specs/personas](../specs/personas.md) |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- kuroe 混在タッチ(非デフォルメ)の見え方評価 — 実画面が出たので
  ユーザ確認待ち([specs/personas](../specs/personas.md) の実験枠)。
- アニメ/3D 描画の調査(将来、[ADR-0004](../adr/0004-client-rendering-staged.md))。

## Open Questions Blocking This Phase

なし。

## See Also

- Specs: [architecture](../specs/architecture.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md)
- Previous: [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md)
