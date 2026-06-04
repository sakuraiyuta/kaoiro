---
title: Phase 4 — 感情フィルタ(味付け)
description: 正規化イベントに感情 property を付与するフィルタを追加し、表情に情緒を重ねる。
status: planned
phase: 4
depends_on: [phase-3-server-multiagent]
last_updated: 2026-06-04
---

# Phase 4 — 感情フィルタ(味付け)

## Goal

共通イベントに感情 property を付与するフィルタを追加し、状態ベースの表情に
情緒のニュアンスを重ねる(ゴール B の味付け)。

## Acceptance Criteria

- [ ] 感情フィルタが `ext.emotion` を付与する
- [ ] クライアントが状態ベース表情に感情の味付けを重ねる
- [ ] 感情フィルタが落ちても Phase 3 の実用性が保たれる

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4-1 | 感情推論フィルタ(ローカル、非同期) | ⏳ | ノンブロッキング |
| 4-2 | クライアントの表情への味付け反映 | ⏳ | |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

なし。

## Open Questions Blocking This Phase

なし。

## See Also

- Specs: [overview](../specs/overview.md),
  [plugin-model](../specs/plugin-model.md)
- Previous: [phase-3-server-multiagent](phase-3-server-multiagent.md)
