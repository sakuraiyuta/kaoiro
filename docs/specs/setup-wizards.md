---
title: セットアップウィザード(設定 / env 生成)
description: wrapper の kaoiro.config.json と server の .env を一問一答で生成する対話ウィザードの仕様。
status: provisional
related: [protocol, threat-model]
---

# セットアップウィザード(設定 / env 生成)

## Purpose

トークンや接続設定を 1 行に手書きする初期セットアップは見づらく、追加・修正も
しづらい。wrapper / server それぞれに一問一答の対話ウィザードを設け、妥当な設定
ファイルを生成して手間と書き間違い(特に fail-closed なクライアント認証の設定
漏れ)を減らす。

ウィザードは 2 本。生成物も配置も別系統で、相互に独立して動く。

| ウィザード | 生成物 | 配置 |
|---|---|---|
| wrapper 設定ウィザード | `wrapper/kaoiro.config.json` | wrapper |
| server env ウィザード | `server/.env` | server |

## 共通方針

- **トークン入力**: 各トークンは「手入力 / 自動生成」をユーザに選ばせる。自動
  生成の既定は `openssl rand -hex 32`。
- **既存ファイル**: 既存の生成先がある場合は上書き前に確認する。
- **独立運用**: 2 本のウィザード間でトークンの受け渡し連携はしない。wrapper の
  `server_token` と server の `KAOIRO_WRAPPER_TOKENS` は同じトークンを共有する
  ため、「片方で生成 → もう片方に貼る」運用をウィザードが案内する(自動連携は
  スコープ外)。

## wrapper 設定ウィザード(kaoiro.config.json)

生成物のスキーマ・検証は wrapper 側のローダ(`wrapper/src/persona.ts` の
`parseConfig()` / `loadConfig()`)に従い、逸脱しない。

| 項目 | キー | 必須 | 既定 / 制約 |
|---|---|---|---|
| Agent ID | `agent_id` | 必須 | `^[A-Za-z0-9._-]+$` / 1–256 文字 |
| Persona ID | `persona.id` | 必須 | 1–256 文字 |
| Persona 表示名 | `persona.name` | 必須 | 1–256 文字 |
| Persona 立ち絵 | `persona.sprite_set` | 必須 | 1–256 文字 |
| Server URL | `server_url` | 任意 | `ws://` または `wss://` |
| Wrapper トークン | `server_token` | 任意 | server 接続時のみ |
| 許可タイムアウト | `permission_timeout_ms` | 任意 | 既定 600000 / 正の整数 |
| 許可ツール | `allowed_tools` | 任意 | 既定 `[Read, Grep, Glob, LS, NotebookRead]` / 最大 64 |

- **persona の候補補完**: `id` / `name` / `sprite_set` は server の
  `GET /api/personas` から候補を取得し「候補選択のみ」とする(
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  で「野良 persona 禁止」を server 側で enforce するため、manifest に
  ない id を書き込むと wrapper 起動時に reject される)。**server に
  到達できない場合はウィザードを中断し、server を立てるよう案内**する
  (fail-closed、[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  F3)。
- **server 接続は必須**: `server_url` / `server_token` は wrapper 起動
  の必要条件。旧仕様の「ローカルのみモード(server なしでも動く)」は
  [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
  で撤廃された。ローカル利用時も dev 向け minimal server を並行起動
  する運用を案内する(F10)。
- **人格プロンプトはサーバ配送**: 旧仕様の `persona.personality_prompt_file`
  / `persona.language` フィールドは wrapper config には持たない。人格
  プロンプトの一次ソースは server 側 persona pack
  ([persona-pack-schema](persona-pack-schema.md))、配送は WS ハンド
  シェイクの push([persona-personality-injection](persona-personality-injection.md))。
- **初回起動で自動起動**: 設定ファイルが無い初回起動時はウィザードを自動的に
  起動する(配布バイナリ運用、[ADR-0018](../adr/0018-runner-distribution.md))。
- **設定の配置(配布時)**: 配布インストールでは設定をインストール先でなく
  **OS 別のユーザ設定ディレクトリ**(Linux `~/.config`、macOS
  `~/Library/Application Support`、Windows `%APPDATA%`)に置く。開発時は従来の
  `wrapper/kaoiro.config.json` も可。
- **CLI のみ**: ウィザードは対話 CLI で完結し GUI を要さない(ヘッドレスホスト
  対応、[ADR-0018](../adr/0018-runner-distribution.md))。

## server env ウィザード(.env)

生成する env 名・意味は `server/config/runtime.exs` と `server/.env.example` に
従う。`.env` は docker compose の `env_file`(`server/docker-compose.yaml`)が
読む正本。`mix phx.server` 単体起動ではシェル環境変数が必要。

| 項目 | env | 必須 | 備考 |
|---|---|---|---|
| シークレットキー | `SECRET_KEY_BASE` | 本番必須 | `mix phx.gen.secret`(64 バイト)生成。`openssl rand -hex 32` では短い |
| ホスト名 | `PHX_HOST` | 本番必須 | 未設定は起動時 raise (fail-fast、issue #139)。`.env.example` の既定値 `localhost` は開発/検証用 |
| ポート | `PORT` | 任意 | 既定 4000 |
| bind IP | `KAOIRO_BIND_IP` | 任意 | `:prod` (release) 限定。既定 = 全 IF。IPv4/IPv6 リテラル。dev (`mix phx.server`) は常に loopback 固定で対象外 (issue #139) |
| クライアント認証 | `KAOIRO_CLIENT_TOKENS` | 実質必須 | `token:role` の複数。role = `operator` / `viewer`。未設定だと全クライアント拒否(fail-closed) |
| wrapper 認証 | `KAOIRO_WRAPPER_TOKENS` | LAN 公開時必須 | `agent_id:token` の複数。未設定 = dev mode(loopback 限定) |
| 立ち絵ディレクトリ | `KAOIRO_PERSONA_DIR` | 任意 | コンテナ内パス |

- `KAOIRO_CLIENT_TOKENS` / `KAOIRO_WRAPPER_TOKENS` は「何件追加するか」を繰り返し
  聞き、複数エントリを組み立てる。各トークンは共通方針どおり手入力 / 自動生成を
  選ばせる。
- `SECRET_KEY_BASE` の自動生成はトークン(`openssl`)とは別系統で、
  `mix phx.gen.secret` を用いる(下記 Open Questions)。

## スコープ外

- 2 本のウィザード間でのトークン自動受け渡し(独立運用 — [ADR-0011](../adr/0011-phase3-reliability-and-auth.md)
  のトークン体系を前提に人手で揃える)。

## Open Questions

実装着手時に確定する細目(本 spec は `provisional`):

- ウィザードの起動形態 — wrapper: `pnpm run init` 等のスクリプト名 / CLI サブ
  コマンド名。server: `mix kaoiro.env` 等の mix task / shell / node。
- `SECRET_KEY_BASE` 自動生成を `mix phx.gen.secret` で行うか手入力のみか。
- `.env` に加え `mix phx.server` 単体向けの `export` スニペット出力も出すか。
- `allowed_tools` の聞き方(既定採用 / 候補から選択)。

## See Also

- 関連 specs: [protocol](protocol.md), [threat-model](threat-model.md)
- ADRs: [0011](../adr/0011-phase3-reliability-and-auth.md) — トークン認証、
  [0018](../adr/0018-runner-distribution.md) — 配布(初回ウィザード自動・配置)
