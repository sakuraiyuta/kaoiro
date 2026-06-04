---
title: Phase 2 — クライアント + キャラ + 状態ベース表情
description: Web クライアントでエージェントをキャラ表示し、状態を表情へマッピングする。
status: planned
phase: 2
depends_on: [phase-1-wrapper-state-machine]
last_updated: 2026-06-04
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
| 2-1 | クライアント雛形(状態購読 → 表示) | ⏳ | |
| 2-2 | 状態 → 表情マッピング | ⏳ | |
| 2-3 | ComfyUI による表情差分の量産 | ⏳ | |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- アニメ/3D 描画の調査(将来、[ADR-0004](../adr/0004-client-rendering-staged.md))。

## Open Questions Blocking This Phase

なし。

## See Also

- Specs: [architecture](../specs/architecture.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md)
- Previous: [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md)
