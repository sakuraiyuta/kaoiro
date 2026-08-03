---
title: セットアップウィザード(設定 / env 生成)
description: server の .env と runner の設定(runner.config.json / runner.env)を一問一答で生成する対話ウィザードの仕様。
status: accepted
last_updated: 2026-07-27
related: [protocol, threat-model]
---

# セットアップウィザード(設定 / env 生成)

## Purpose

トークンや接続設定を手書きする初期セットアップは見づらく、追加・修正もしづらい。
一問一答の対話ウィザードで妥当な設定ファイルを生成し、手間と書き間違い(特に
fail-closed なクライアント認証の設定漏れ)を減らす。

配備手順書([#142](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/142))が
**手動手順の正本**で、ウィザードは**その自動化**という関係にする。ウィザードは
手順書の内容を再説明せず、生成した設定と「次にやること」だけを出力する。

## ウィザードは 2 本

生成物も配置も別系統で、相互に独立して動く。

| ウィザード | 起動 | 生成物 | 配置 |
|---|---|---|---|
| server env | `mix kaoiro.env` | `.env` | server 側 |
| runner 設定 | `deploy/kaoiro-runner-setup.sh` | `runner.config.json` / `runner.env` | 各エージェントホスト |

実装形態が分かれるのは配布形態の違いから。server は Elixir 環境で動かすので mix
task にできるが、runner は tarball 配布([ADR-0018](../adr/0018-runner-distribution.md)
2026-07-25 改訂)で **配布先に mix も pnpm も無い**ため Node 実装
(`runner/src/setup.ts`)+ 同梱シムにする。

## 共通方針

- **トークン**: 各トークンは「手入力 / 自動生成」を選ばせる。自動生成は **32
  バイトの hex**(`openssl rand -hex 32` と同じ形。実装は Node の
  `crypto.randomBytes` / Erlang の `:crypto.strong_rand_bytes` で、openssl バイナリ
  に依存しない)。
- **既存ファイル**: 生成先が既にある場合は上書き前に確認する。断ったファイルは
  内容を保持し、どれを残したかを結果に出す。
- **独立運用**: 2 本の間でトークンの受け渡し連携はしない。runner の
  `KAOIRO_RUNNER_TOKEN` と server の `KAOIRO_RUNNER_TOKENS` は同じトークンを共有
  するため、「片方で生成 → もう片方へ貼る」運用をウィザードが案内する(自動連携は
  スコープ外)。
- **対話専用**: 非対話セッションでは起動を拒否する。systemd / launchd から
  呼ばれた場合に TTY が無いまま無応答で止まる事故を防ぐため、runner 側は
  `process.stdin.isTTY` を検査して exit 78、server 側は stdin が閉じていれば
  `Mix.raise` で中断する。無人配備向けのフラグ指定は
  [#146](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/146) で扱う。
- **初回起動での自動起動はしない**。設定が無いときの起動シムは exit 78
  (`EX_CONFIG`)で止まり、**ウィザードのコマンドを案内する**に留める(上記の
  非対話事故を避けるため。[ADR-0018](../adr/0018-runner-distribution.md) の
  「初回起動でウィザードを自動起動」はこの判断で上書きする)。

## server env ウィザード(`mix kaoiro.env`)

生成する env 名・意味は `server/config/runtime.exs` と `server/.env.example` に
従う。`.env` は docker compose の `env_file`(`server/docker-compose.yaml`)が読む
正本。`mix phx.server` 単体起動では `set -a && . ./.env && set +a` で読み込む
(専用の `export` スニペットは出さない — 正本を 2 つにしないため)。

| 項目 | env | 必須 | 備考 |
|---|---|---|---|
| シークレットキー | `SECRET_KEY_BASE` | 本番必須 | 64 文字 base64。`mix phx.gen.secret` と同じ生成(32 バイト hex では短い) |
| ホスト名 | `PHX_HOST` | 本番必須 | 未設定は起動時 raise(fail-fast、issue #139) |
| ポート | `PORT` | 任意 | 既定 4000 |
| bind IP | `KAOIRO_BIND_IP` | 任意 | `:prod`(release)限定。既定 = 全 IF。dev は常に loopback 固定(issue #139) |
| クライアント認証 | `KAOIRO_CLIENT_TOKENS` | 実質必須 | `token:role` の複数。role = `operator` / `viewer`。未設定で全クライアント拒否(fail-closed) |
| wrapper 認証 | `KAOIRO_WRAPPER_TOKENS` | 公開時必須 | `agent_id:token` の複数(client と順序が逆) |
| runner 認証 | `KAOIRO_RUNNER_TOKENS` | 公開時必須 | `host_id:token` の複数([ADR-0023](../adr/0023-host-runner-architecture.md)) |
| OAuth 個人認証 | `KAOIRO_OAUTH_*` / `KAOIRO_OAUTH_ALLOWLIST_PATH` | 任意 | Google / GitHub / Nextcloud。詳細は[配備手順 1.6](deployment.md) |
| 立ち絵ディレクトリ | `KAOIRO_PERSONA_DIR` | 任意 | コンテナ内パス |
| footer ディレクトリ | `KAOIRO_FOOTER_DIR` | 任意 | 質問せず comment hint を出す |
| persona cache dir | `KAOIRO_PERSONA_CACHE_DIR` | 任意 | comment hint を出す |

- トークン 3 種は「追加するか」「もう 1 件追加するか」を繰り返し聞いて複数
  エントリを組み立てる。prod では 3 種すべて必須(未設定は接続拒否、issue #138)。
- **DETS パス 8 種は聞かない**。同梱 `docker-compose.yaml` が `environment:` で
  設定済みで、compose 外運用のときだけ必要になる。生成ファイルにはコメントとして
  残し、意味と一覧は配備手順書(#142)に委ねる。
- `KAOIRO_FOOTER_DIR` / `KAOIRO_PERSONA_CACHE_DIR` も質問項目を増やさない。
  `mix kaoiro.env` は未設定時の挙動と compose の設定例を comment hint として
  render する。質問なしで既定の設定を保ちつつ、必要な運用導線を示す。
- 収集しなかった任意項目は**空代入ではなくコメント行**で出す(未設定と空文字の
  取り違えを防ぐ)。
- 既存の質問の後で **「OAuth ログインを設定しますか?」** を既定 No で尋ねる。No
  なら OAuth 用の env / allowlist / 次の手順は出さず、従来の生成物と案内を保つ。
- Yes のときは Google / GitHub / Nextcloud を個別に有効化するか尋ねる。有効な
  provider は provider console で発行した client ID / client secret を**手入力**する
  (自動生成しない)。Nextcloud は base URL も必須。すべて無効なら OAuth 設定なしとして
  扱う。secret は入力後に再表示しない。
- 1 provider 以上を有効にしたときは、`.env` と同じ server ディレクトリに
  `oauth-allowlist.txt` を書く。書式コメントを添え、少なくとも 1 件の
  `provider:identifier[:role]` (role 省略時は viewer) を入力させる。空・欠落の
  allowlist は OAuth ログインを全拒否する fail-closed であることを入力時に表示する。
  `.env` と allowlist はともに 0600 で生成し、既存 allowlist は `.env` と同じく
  上書き確認を行う。
- 有効 provider のみ `KAOIRO_OAUTH_*` を `.env` に書き、
  `KAOIRO_OAUTH_ALLOWLIST_PATH=/etc/kaoiro/oauth-allowlist.txt` を設定する。compose
  では `docker-compose.yaml` の `volumes:` に
  `- ./oauth-allowlist.txt:/etc/kaoiro/oauth-allowlist.txt:ro` を追加するよう案内する。
  compose を使わない単体起動では `KAOIRO_OAUTH_ALLOWLIST_PATH` を allowlist の実ファイル
  パスへ書き換える。
  provider console の登録は配備手順 1.6 を参照する。Google は localhost 以外の
  plain-HTTP 配備では使えない。

## runner 設定ウィザード(`deploy/kaoiro-runner-setup.sh`)

生成物のスキーマ・検証は runner 側のローダ(`runner/src/config.ts` の
`parseRunnerConfig()`)に従う。ウィザードは書き出す前に必ずローダを通し、
**runner が起動時に reject する内容を生成し得ない**ようにする。

| 項目 | 生成先 | 必須 | 既定 / 制約 |
|---|---|---|---|
| Host ID | `runner.config.json` `host_id` | 必須 | `^[A-Za-z0-9._-]+$`(チャネル topic に載る) |
| Server URL | 同 `server_url` | 必須 | `ws://` または `wss://`。prod は `force_ssl` により `wss://` 必須 |
| 起動許可 cwd | 同 `cwd_allowlist` | 必須 | 絶対パスを 1 件以上。空行で入力終了 |
| capabilities | 同 `capabilities` | 任意 | `claude-code` / `codex` を個別に可否。全 off なら `claude-code` に落とす |
| Codex auth mode | 同 `codex.auth_mode` | 任意 | capabilities に codex を含む場合のみ。明示すると `codex doctor` 起動を避けられる(phase-24) |
| runner トークン | `runner.env` の `KAOIRO_RUNNER_TOKEN` | 公開時必須 | 手入力 / 自動生成。**config JSON には書かない** |
| node パス | 同 `KAOIRO_NODE` | 任意 | systemd user unit / launchd は最小 PATH で起動するため、version manager 利用時は絶対パスを固定する |

- **配置先は OS 別ユーザ設定ディレクトリ**(Linux
  `${XDG_CONFIG_HOME:-~/.config}/kaoiro`、macOS `~/Library/Application Support/kaoiro`)。
  `KAOIRO_RUNNER_DIR` で上書き可。解決順は起動シム
  (`deploy/kaoiro-runner-launch.sh`)と一致させる — ずれるとウィザードが
  サービスの見ない場所へ書いてしまう。
- **`runner.env` は 0600 で生成**する(トークンを持つため。issue #141)。この
  ファイルは起動シムに `source` されるので、値はクォートして書き出す。
- `server_url` は `runner.config.json` を正本とする。env 上書き
  (`KAOIRO_RUNNER_SERVER_URL`、[#140](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/140))
  が入り次第、`runner.env` 側にコメント例を追記する。
- wrapper の設定は runner が spawn 時に生成する
  ([ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))ため、
  ウィザードの対象外。

## スコープ外

- **wrapper 設定ウィザード**(`kaoiro.config.json`)— 実運用では runner が spawn
  時に一時 config を生成する([ADR-0023](../adr/0023-host-runner-architecture.md) /
  [ADR-0024](../adr/0024-agent-instance-identity-and-spawn-auth.md))ため、人が
  書くのは dev の単独起動時のみ。その用途には engine 別の example
  (`wrapper/kaoiro.config.claude-code.example.json` ほか)がある。**dev 向け・
  優先度低**として保留する。
- **非対話モード**(フラグ一括指定)—
  [#146](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/146)。
- **2 本の間でのトークン自動受け渡し** — 独立運用
  ([ADR-0011](../adr/0011-phase3-reliability-and-auth.md) のトークン体系を前提に
  人手で揃える)。
- **Gitea release への配布物アップロード** —
  [#145](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/145)。

## See Also

- 関連 specs: [protocol](protocol.md), [threat-model](threat-model.md)
- ADRs: [0011](../adr/0011-phase3-reliability-and-auth.md) — トークン認証、
  [0018](../adr/0018-runner-distribution.md) — 配布形態、
  [0023](../adr/0023-host-runner-architecture.md) — runner 常駐、
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md) — spawn 時の
  agent_id / token 採番
- 手順書: 配備手順書(#142)が手動手順の正本
