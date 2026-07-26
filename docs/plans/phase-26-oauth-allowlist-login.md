---
title: Phase 26 — dashboard OAuth ログイン + 許可リスト (issue #65)
description: Google/GitHub/Nextcloud の OAuth 個人認証を dashboard に導入し、テキスト許可リスト (provider:identifier[:role]) で認可する。KAOIRO_CLIENT_TOKENS 未設定時は token 認証無効 (OAuth のみ)。設計は ADR-0042。
status: in-progress
phase: 26
depends_on: []
last_updated: 2026-07-26
---

# Phase 26 — dashboard OAuth ログイン + 許可リスト

## Goal

dashboard に個人を識別するログイン (OAuth: Google / GitHub /
Nextcloud + 許可リスト認可) を導入する。共有トークン認証は
`KAOIRO_CLIENT_TOKENS` 設定時のみ併存し、未設定時は OAuth のみ。
設計決定は [ADR-0042](../adr/0042-oauth-allowlist-login.md)、
issue は [#65](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/65)。

## 担当

- server (Elixir): **あお**
- dashboard (Svelte/TS): **もも**
- 計画・監督・本 doc の進捗更新: クロエ (担当者は本 doc を直接編集
  しない — 進捗はクロエへ報告)

## API contract (両者の並行作業境界)

- `GET /session/auth-methods` → 200
  `{"token": true|false, "oauth": ["google","github","nextcloud"]}`
  (oauth は有効 provider のみ。認証不要で参照可)
- `GET /auth/:provider` → 302 (provider の authorize URL へ)。
  無効 provider は 404
- `GET /auth/:provider/callback` → 成功: session cookie を積んで
  302 `/index.html` / 失敗: 302
  `/index.html?auth_error={provider_error|not_allowed|invalid_state}`
- 以降の WS 接続・refresh・logout は既存経路のまま
  (`/session/ticket` → `?ticket=`、`GET /session/refresh`、
  `DELETE /session`)
- 追補 (2026-07-26 あお、login CSRF 対策): `POST /session/new` は
  JSON content-type 必須 (それ以外は 415)。dashboard は元から JSON
  送信のため影響なし

## Scope / タスク

| # | task | file | owner | status |
|---|------|------|-------|--------|
| 26-1 | deps: assent + HTTP client (Req 想定) 追加。adapter 構成は assent 公式推奨に従う | `server/mix.exs` | あお | done |
| 26-2 | 許可リスト module: path 読み込み、`provider:identifier[:role]` parse (role 省略= viewer、malformed 行 warn+skip)、`role_for(provider, identifier)`。毎回 parse (キャッシュなし) | `server/lib/kaoiro_server/oauth_allowlist.ex` (新規) | あお | done |
| 26-3 | runtime.exs: `KAOIRO_OAUTH_*` provider 設定 + `KAOIRO_OAUTH_ALLOWLIST_PATH` 読み込み。`Auth.warn_token_config/0` に OAuth 構成状態の起動時 WARN を追従 | `server/config/runtime.exs`, `auth.ex` | あお | done |
| 26-4 | AuthController: `GET /auth/:provider` (session_params を session 保存) / callback (state 検証 → identity 正規化 → 許可リスト照合 → put_session → 302)。provider access token は破棄 | `server/lib/kaoiro_server_web/controllers/auth_controller.ex` (新規), `router.ex` | あお | done |
| 26-5 | session/WS 統合: session の identity 格納、ticket の identity 暗号化、`ClientSocket.connect/3` の identity 解決 (毎回 allowlist 再照合)、`Auth.socket_id` の oauth variant、refresh/delete の identity 対応 | `client_socket.ex`, `session_controller.ex`, `auth.ex` | あお | done |
| 26-6 | `GET /session/auth-methods` 実装 | `session_controller.ex`, `router.ex` | あお | done |
| 26-7 | server tests: allowlist parse/fail-closed、callback 認可/拒否、oauth ticket 接続、refresh 401 + 強制切断、auth-methods。既存 suite (auth_test 等) の形式に倣う | `server/test/**` | あお | done |
| 26-8 | docs/env: `.env.example` + `docs/specs/auth-and-authz.md` (socket 認証表・cookie/ticket 節・Known gaps) 更新 | `server/.env.example`, `docs/specs/auth-and-authz.md` | あお | done |
| 26-9 | dashboard: 起動時 `GET /session/auth-methods` 取得、token フォームの条件表示 (token 無効時は非表示)、両方無効時の案内文言 | `dashboard/src/App.svelte` | もも | done |
| 26-10 | dashboard: OAuth ログインボタン (トークン入力の下、`/auth/:provider` へのリンク)、`?auth_error=` の文言表示 + `history.replaceState` で URL 掃除 | `dashboard/src/App.svelte` | もも | done |
| 26-11 | Vite dev proxy に `/auth` を追加 | `dashboard/vite.config.ts` | もも | done |
| 26-12 | dashboard 検証: `pnpm typecheck` / `pnpm build` green。ログイン画面の状態分岐 (token のみ / oauth のみ / 併存 / 両方なし) を確認 | `dashboard/` | もも | done |

## 受け入れ基準

- `cd server && mix test` / `mix format --check-formatted` green
- `cd dashboard && pnpm typecheck && pnpm build` green
- 許可リスト外の identity は callback で `not_allowed` 拒否
  (fail-closed)。許可リスト行削除後、refresh (401) で稼働中 socket が
  切断される
- `KAOIRO_CLIENT_TOKENS` 未設定 + OAuth 有効の構成で、token フォームが
  出ず OAuth ボタンのみ表示される
- provider access token がログ・session・DETS のどこにも残らない

## Out of scope

- role 細分化 (approver 等)、監査ログ、マルチテナント隔離
- 案A (token ログインフォーム) の廃止 — 併存のまま
- kaoiro.env ウィザード (#144) への OAuth 質問追加 (followup 候補)

## 進捗ログ

- 2026-07-26: 計画作成 (クロエ)。あお/もも へ委任開始
- 2026-07-26: 26-9〜26-12 完了 (もも、commit 5887df0)。auth-methods
  取得失敗時は token フォームへ graceful degradation、fetchAuthMethods
  は形状検証つき。svelte-check 0 errors / build / test 338 green、
  レビュー must-fix 0
- 2026-07-26: 26-1〜26-8 完了 (あお、未コミット)。mix test 611 green
  (クロエ再実行で確認)。must-fix 1 件修正済 (OAuth 有効時に
  warn_config が Endpoint.url() を boot 前評価して起動不能 →
  enabled?/1 を env 参照のみに分離 + 別 BEAM 回帰テスト)。追加判明:
  Nextcloud は PKCE 未対応 (state のみ)、assent 0.3.1 Req adapter の
  ヘッダ混入バグ回避 (例外は型名のみログ)。followup: 許可リスト role
  降格が稼働中 socket に効かない件は issue 化 (共有トークン経路にも
  同穴、AgentsChannel 側の修正が本筋) → #158
- 引き継ぎメモ: AuthController.log_failure/3 が例外の型名しか出さない
  制約は assent 0.3.1 Req adapter のヘッダ混入バグ (upstream 修正済・
  未リリース) が根拠。assent 更新時に緩和可否を再判断。Nextcloud が
  PKCE 対応したら strategy に code_verifier: true を追加可
- 2026-07-26: 全コミット完了・push 済 (5887df0 dashboard / 8f75e92
  docs / 7f57a4c server)。残: マスターによる provider 登録 + 実機 E2E
  (手順はクロエがチャットで提示済)、role 降格は #158
