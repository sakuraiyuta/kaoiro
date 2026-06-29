---
title: Phase 2 — クライアント + キャラ + 状態ベース表情
description: Web クライアントでエージェントをキャラ表示し、状態を表情へマッピングする。
status: done
phase: 2
depends_on: [phase-1.5-minimal-server-client]
last_updated: 2026-06-16
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
- [x] 手待ち(waiting_input / waiting_permission)遷移でクライアントが通知
  (デスクトップ通知 + 音)を発火する(#7)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2-1 | クライアント雛形(状態購読 → 表示) | ✅ | リファレンスダッシュボード(Svelte 5 + Vite、`server/assets/`、issue #12)。プロトコル層は Svelte 非依存の `protocol.ts` |
| 2-2 | 状態 → 表情マッピング | ✅ | スプライト版実装済(2026-06-11): [ADR-0008](../adr/0008-persona-asset-distribution.md) 第 1 段階のマニフェスト + 配信を実装し、カードはスプライト優先・CSS 顔フォールバック。`disconnected` は idle のグレースケール |
| 2-3 | ComfyUI による表情差分の量産 | ✅ | 3 ペルソナ x 7 状態 = 21 枚完成。`server/priv/personas/` へ正式配置済み。方針・規格・provenance は [specs/personas](../specs/personas.md) |
| 2-4 | 手待ち通知(デスクトップ通知 + 音) | ✅ | waiting_input / waiting_permission への遷移で `Notification` + 状態別 wav 音(`input.wav` / `permission.wav`、HTMLAudioElement)を発火(#7、`server/assets/src/lib/notify.ts`)。`onEnvelope` のライブ遷移のみで発火しスナップショットでは鳴らさない。音は autoplay ポリシー次第の best-effort |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- アニメ/3D 描画の調査(将来、[ADR-0004](../adr/0004-client-rendering-staged.md))。

## Outcome notes

- kuroe 混在タッチは実画面評価で採用確定(2026-06-11)。リファレンス
  実装はカタログ的多様性に価値、統一はクライアント側の意思
  ([specs/personas](../specs/personas.md) 基本方針に反映)。

## Open Questions Blocking This Phase

なし。

## See Also

- Specs: [architecture](../specs/architecture.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md)
- Previous: [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md)
