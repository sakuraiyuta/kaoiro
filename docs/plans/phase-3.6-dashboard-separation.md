---
title: Phase 3.6 — ダッシュボード別ディレクトリ化 + 同梱整理
description: 参照ダッシュボードを server/assets からトップレベル dashboard/ へ移出し、リリースビルド時に同梱する構成へ整理。完了。
status: done
phase: 3.6
depends_on: [phase-3.5-response-display]
last_updated: 2026-07-25
---

# Phase 3.6 — ダッシュボード別ディレクトリ化 + 同梱整理

## Goal

参照実装ダッシュボード(Svelte 5 + Vite、旧 `server/assets/`)を server 配下から
独立ディレクトリへ移出し、ビルド・リリース時に成果物を同梱する構成へ整理する。
依存・ビルド・CI を server 本体から切り離し、将来の外部クライアント分離
([ADR-0007](../adr/0007-client-separation-reference-dashboard.md))への布石と
する(対応 issue: #44)。

## Acceptance Criteria

- [x] ダッシュボードを server/ 外の独立ディレクトリ(トップレベル `dashboard/`)
      へ移出し、自己完結の `package.json` を持つ
- [x] server は配信を維持しつつビルド成果物のみを同梱(`DashboardStatic` /
      `Plug.Static` の `/` ・ `/assets` 配信は不変)
- [x] リリースで同梱ビルドが走る経路を整備(`server/Dockerfile` の node
      ステージ。`mix setup` からは意図的に外した — 下記 D-2)
- [x] CI: ダッシュボードのビルド失敗が server ビルドと切り離される
- [x] `:serve_dashboard` による静的配信オフの挙動を維持

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| D-1 | 移出先ディレクトリ確定と移動(`server/assets/` → `dashboard/`) | ✅ | `git mv` で履歴保持。`vite.config.ts` の `outDir` を `../server/priv/static` へ |
| D-2 | `mix.exs` の assets エイリアス見直し | ✅ | `assets.setup` / `assets.build` → `dashboard.setup` / `dashboard.build`(`--cd ../dashboard`)。`setup` から除外し server ビルドの Node 依存を排除 |
| D-3 | 配信パス・`DashboardStatic` の維持確認 | ✅ | prod イメージ起動で `/assets/*` `/favicon.ico` = 200、`/` = 302(既存の RootRedirect)。`:serve_dashboard` off は `dashboard_toggle_test.exs` が継続 green |
| D-4 | CI 分離(dashboard ビルドと server ビルド) | ✅ | `dashboard` job の `working-directory` / cache path のみ変更(既に別 job)。`dashboard/pnpm-workspace.yaml` 新設で単独 install が成立 |
| D-5 | ドキュメント更新([ADR-0007](../adr/0007-client-separation-reference-dashboard.md) 整合) | ✅ | ADR-0007 Neutral に位置と同梱方式を追記。README / server README / docs のパス参照を更新 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Decisions

- **移出先**: トップレベル `dashboard/`。CI の既存 job 名と一致し、外部
  クライアントが複数化する見込みが当面ないため `clients/` 階層は導入しない
  (2026-07-25、#44 コメント)。
- **同梱方式**: リリース時にビルド実行。`server/Dockerfile` の multi-stage
  (node ステージで build → `priv/static` へ copy)を維持し、事前ビルド成果物の
  コミットは行わない(同上)。
- **Docker build context はリポジトリルート**。`dashboard/` が server/ の外に
  出たため、`docker-compose.yaml` は `context: ..` + `dockerfile:
  server/Dockerfile` を指定し、`.dockerignore` をルートへ移動(ホワイトリスト
  方式で `server/` と `dashboard/` のみ投入)。素の `docker build` はルートから
  `-f server/Dockerfile .` で叩く。
- **`dashboard/pnpm-workspace.yaml`(`packages: []`)を新設**。これが無いと
  pnpm がルートの `pnpm-workspace.yaml` まで遡り、非メンバの dashboard では
  なくルート workspace を install してしまい `dashboard/node_modules` が空に
  なる(移出前から同じ罠があり、CI の dashboard job も同状態だった)。

## Followups (in-phase but unfinished)

- 完全な別リポジトリ化([ADR-0007](../adr/0007-client-separation-reference-dashboard.md)
  の最終形)は本フェーズのスコープ外。本フェーズは同一リポジトリ内での移出に留める。

## See Also

- ADRs: [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md)
- Previous: [phase-3.5-response-display](phase-3.5-response-display.md)
