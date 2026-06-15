---
title: Phase 3.6 — ダッシュボード別ディレクトリ化 + 同梱整理
description: 参照ダッシュボードを server/assets から独立ディレクトリへ移出し、ビルド / リリース時に同梱する構成へ整理。優先度低。
status: planned
phase: 3.6
depends_on: [phase-3.5-response-display]
last_updated: 2026-06-15
---

# Phase 3.6 — ダッシュボード別ディレクトリ化 + 同梱整理

## Goal

参照実装ダッシュボード(Svelte 5 + Vite、現 `server/assets/`)を server 配下から
独立ディレクトリへ移出し、ビルド・リリース時に成果物を同梱する構成へ整理する。
依存・ビルド・CI を server 本体から切り離し、将来の外部クライアント分離
([ADR-0007](../adr/0007-client-separation-reference-dashboard.md))への布石と
する。優先度は低い(対応 issue: #44)。

## Acceptance Criteria

- [ ] ダッシュボードを server/ 外の独立ディレクトリ(例 `dashboard/` /
      `clients/dashboard/`)へ移出し、自己完結の `package.json` を持つ
- [ ] server は配信を維持しつつビルド成果物のみを同梱(`DashboardStatic` /
      `Plug.Static` の `/` ・ `/assets` 配信は不変)
- [ ] リリース / `mix setup` で同梱ビルドが走る、または成果物を取り込む経路を整備
- [ ] CI: ダッシュボードのビルド失敗が server ビルドと切り離される
- [ ] `:serve_dashboard` による静的配信オフの挙動を維持

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| D-1 | 移出先ディレクトリ確定と移動(`server/assets/` → 独立 dir) | ⏳ | 名前は Open Questions |
| D-2 | `mix.exs` の assets エイリアス見直し(成果物取り込みへ) | ⏳ | 現状 `assets.setup` / `assets.build` が mix に統合 |
| D-3 | 配信パス・`DashboardStatic` の維持確認 | ⏳ | `/` と `/assets`、`:serve_dashboard` |
| D-4 | CI 分離(dashboard ビルドと server ビルド) | ⏳ | 失敗の独立化 |
| D-5 | ドキュメント更新([ADR-0007](../adr/0007-client-separation-reference-dashboard.md) 整合) | ⏳ | 別リポジトリ化はさらに将来 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- 完全な別リポジトリ化([ADR-0007](../adr/0007-client-separation-reference-dashboard.md)
  の最終形)は本フェーズのスコープ外。本フェーズは同一リポジトリ内での移出に留める。

## Open Questions Blocking This Phase

- 移出先ディレクトリ名(`dashboard/` か `clients/dashboard/` か)。
- 同梱方式(リリース時にビルド実行 / 事前ビルド成果物の取り込み)。

## See Also

- ADRs: [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md)
- Previous: [phase-3.5-response-display](phase-3.5-response-display.md)
