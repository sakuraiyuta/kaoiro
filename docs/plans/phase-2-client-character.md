---
title: Phase 2 — クライアント + キャラ + 状態ベース表情
description: Web クライアントでエージェントをキャラ表示し、状態を表情へマッピングする。
status: in_progress
phase: 2
depends_on: [phase-1.5-minimal-server-client]
last_updated: 2026-06-11
---

# Phase 2 — クライアント + キャラ + 状態ベース表情

## Goal

Web クライアント(TS)でエージェントをキャラ絵表示し、Phase 1 の状態変化を
表情として可視化する(感情 NLP はまだ無し)。

## Acceptance Criteria

- [ ] 状態 → 表情のマッピングが動作する
- [ ] ペルソナ(立ち絵セット)をクライアントに反映
- [ ] 描画はペルソナごとの静的差分切り替え
- [ ] 表情差分素材を ComfyUI で量産(状態別 + ペルソナ別)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2-1 | クライアント雛形(状態購読 → 表示) | ✅ | リファレンスダッシュボード(Svelte 5 + Vite、`server/assets/`、issue #12)。プロトコル層は Svelte 非依存の `protocol.ts` |
| 2-2 | 状態 → 表情マッピング | 🟡 | プレースホルダ実装済(`expression.ts` + CSS 描画の顔、全 8 状態)。スプライト版は 2-3 の素材と [ADR-0008](../adr/0008-persona-asset-distribution.md) 配信の後 |
| 2-3 | ComfyUI による表情差分の量産 | ⏳ | キャラデザイン方針の決定(ユーザ判断)が前提 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- アニメ/3D 描画の調査(将来、[ADR-0004](../adr/0004-client-rendering-staged.md))。

## Open Questions Blocking This Phase

なし。

## See Also

- Specs: [architecture](../specs/architecture.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md)
- Previous: [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md)
