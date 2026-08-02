---
title: Phase 6 — 感情フィルタ(味付け)
description: 正規化イベントに感情 property を付与するフィルタを追加し、表情に情緒を重ねる。2026-08-02 のマスター判断で当分の間塩漬け(未着手のまま優先度を下げた状態)。
status: planned
phase: 6
depends_on: [phase-3-server-multiagent]
last_updated: 2026-08-02
---

# Phase 6 — 感情フィルタ(味付け)

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
| 6-1 | 感情推論フィルタ(ローカル、非同期) | ⏳ | ノンブロッキング |
| 6-2 | クライアントの表情への味付け反映 | ⏳ | |
| 6-3 | 「機嫌」(持続レイヤ)の spec 化 + 実装 | ⏳ | 採用は決定済み(2026-06-11、issue #5)。機嫌 = 感情イベント由来のゆっくり変化・永続する状態。変化速度・減衰・表情合成の詳細は着手時の方針相談で確定 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

なし。

## Open Questions Blocking This Phase

なし。

## 進捗ログ

- 2026-08-02: マスター判断により当分の間塩漬け (status: shelved)。
  再開時期は未定、着手時に本 plan を再活性化する

## See Also

- Specs: [overview](../specs/overview.md),
  [plugin-model](../specs/plugin-model.md)
- Previous: [phase-5-i18n](phase-5-i18n.md)
