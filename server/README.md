# @kaoiro/server

kaoiro のサーバ層(Elixir/Phoenix)。ラッパーからの共通エンベロープを
WebSocket(Phoenix Channels, vsn=2.0.0)で受け、最新状態を保持して
クライアントへ配信する。

仕様: [docs/specs/architecture.md](../docs/specs/architecture.md),
[docs/specs/protocol.md](../docs/specs/protocol.md)。
接続方式の決定: [docs/adr/0009-client-transport.md](../docs/adr/0009-client-transport.md)。

## 現状(Phase 3.5)

ラッパーからのエンベロープを受けて最新状態を保持・配信し、双方向ルーティング
(指示・承認)、トークン認証(ADR-0011、issue #28 で client は fail-closed)、
返答ログのインメモリ履歴・operator 限定配信(ADR-0012)まで実装済み。TLS は
リバースプロキシ終端。詳細は [docs/plans/](../docs/plans/)。

| モジュール | 役割 |
|---|---|
| `KaoiroServer.AgentStates` | agent_id → 最新エンベロープ + 返答ログ履歴(リングバッファ)の保持 |
| `KaoiroServer.Auth` | wrapper/client トークン認証(client は token 未設定で fail-closed) |
| `KaoiroServerWeb.WrapperSocket` / `WrapperChannel` | ラッパー受信(`wrapper:<agent_id>`)、検証、中継、disconnected 導出 |
| `KaoiroServerWeb.ClientSocket` / `AgentsChannel` | クライアント配信(`agents:lobby`)、snapshot/history、指示・承認 relay、role 配信制御 |

## 開発

```sh
mix setup       # 依存導入
mix test        # ExUnit
mix phx.server  # localhost:4000
```

ソケットエンドポイント: `/wrapper/websocket`(ラッパー)、
`/client/websocket`(クライアント)。

## セットアップ / 運用

### 認証(必読、issue #28)

接続認証はトークン + role(ADR-0011)。**未設定時の挙動は socket で異なる**:

- **`KAOIRO_CLIENT_TOKENS` 未設定 → クライアント接続を全拒否(fail-closed)**。
  誤設定で operator が無防備に公開される事故を防ぐため、無認証では稼働せず
  認証不可能な状態で起動する。**ローカル開発・デモでもトークン設定が必須**
  (未設定だとダッシュボードが繋がらず空表示になる)。
- **`KAOIRO_WRAPPER_TOKENS` 未設定 → ラッパー認証を無効化(dev mode)**。
  任意のラッパーが接続可。loopback 限定の開発向け。

いずれも未設定なら起動時に警告をログ出力する([threat-model](../docs/specs/threat-model.md))。

| env | 形式 | 例 |
|---|---|---|
| `KAOIRO_CLIENT_TOKENS` | `token:role,...`(role = `viewer` / `operator`) | `dev-op:operator,view1:viewer` |
| `KAOIRO_WRAPPER_TOKENS` | `agent_id:token,...` | `lab-pc-1.claude-a:wrap-tok` |

**形式の注意**: `KAOIRO_CLIENT_TOKENS` は `<token>:<role>` の順。生成した
シークレット(例 `openssl rand -hex 32`)は **`<token>` 側(コロンの前)** に
置き、role(`operator` / `viewer`)を後ろに書く。例
`KAOIRO_CLIENT_TOKENS=<hex>:operator`。`KAOIRO_WRAPPER_TOKENS` は逆順で
`<agent_id>:<token>`。

ダッシュボードへは `http://localhost:4000/?token=<hex>` で入る(`<token>`
部分のみ、role は含めない)。サーバは初回に `?token=` を検証して **httpOnly +
暗号化 session cookie に交換**し、アドレスバーからは即座に消える(ADR-0013)。
**以降はリロード・ブラウザ再起動でも cookie が認証を保持する**(開いている間は
heartbeat で更新され、閉じてから `max_age`=3日 で失効)。
dev で Vite(:5173)を単独起動した場合は RootRedirect を経由しないが、SPA が
`?token=` を `POST /session/new`(Vite proxy 経由)で cookie に交換し、リロード
時は `GET /session/ticket` で短命 WS チケットを得て接続するため(Vite proxy は
cookie を WS に乗せられないため)、dev でもリロード後の再接続が維持される
(ADR-0013)。

### Docker(推奨)

```sh
cd server
cp .env.example .env
# .env を編集:
#   SECRET_KEY_BASE       … `mix phx.gen.secret` で生成
#   KAOIRO_CLIENT_TOKENS  … 必須(未設定だとダッシュボードが接続拒否される)
#   KAOIRO_WRAPPER_TOKENS … LAN 公開時は必須
docker compose up -d --build
# ダッシュボード: http://localhost:4000/?token=<KAOIRO_CLIENT_TOKENS の token>
```

`.env` を変更したら `docker compose up -d`(`restart` では env_file が再読込
されない)、サーバのコードを変えたら `--build` も付けてコンテナを作り直す。

既定で `127.0.0.1:4000` のみに bind(loopback)。LAN 公開時は両トークン必須 +
中央 nginx(WebSocket の Upgrade/Connection 転送・`proxy_read_timeout` > 60s)
配下に置く。

### ローカル開発(ホットリロード)

> 一括起動なら repo ルートの `./scripts/dev.sh`(サーバ + Vite ダッシュボード +
> ラッパーをホットリロード/watch 付きで起動し、Ctrl-C で一括停止)。`.env` の
> source とラッパーの `tsx watch` 起動もまとめて行う。以下はその手動の内訳。

開発時は docker を使わず、サーバとクライアントをホストで直接起動する。
docker compose は prod release(コンパイル済みを焼き込む)の通し検証用で、
ソースを変えても自動反映しない — ホットリロードには使わない。

env は **docker と同じ `.env` を共用する**(二重管理を避ける)。
`mix phx.server` は `.env` を自動で読まないので、起動前に source する。
dev で最低限必要なのは `KAOIRO_CLIENT_TOKENS` のみ(`SECRET_KEY_BASE` は
`config/dev.exs` のハードコード値、`PHX_HOST` は `localhost` 既定が効くため
dev では不要)。

```sh
cd server
cp .env.example .env        # Docker 用に用意済みならそのまま使える
# .env に最低限: KAOIRO_CLIENT_TOKENS=dev-op:operator

# 1) サーバ(別ターミナル。lib/ の変更は code_reloader が保存時に自動反映)
set -a && . ./.env && set +a && mix phx.server

# 2) クライアント(別ターミナル。Vite dev server で HMR)
cd assets && pnpm dev
```

- サーバ: `config/dev.exs` の `code_reloader: true` で `lib/` の変更を保存時に
  自動再コンパイル・反映。`.env` を書き換えたときだけ source し直して再起動する。
- クライアント: Vite が表示する URL(既定 `http://localhost:5173`)を開く。
  `defaultSocketUrl` は origin 基準で `/client` に繋ぐため、その WebSocket は
  `assets/vite.config.ts` の proxy で 4000 の Phoenix へ転送される
  (dev は `check_origin: false`)。ダッシュボードは従来どおり `?token=<token>`
  が必要: `http://localhost:5173/?token=dev-op`。
- `.env` は単純な `KEY=VALUE` 形式にする(値にスペースやクォートを含めると
  `set -a && . ./.env` での読み込みが壊れる)。

最小確認だけなら source せず 1 変数を inline で渡してもよい(HMR なし):

```sh
KAOIRO_CLIENT_TOKENS=dev-op:operator mix phx.server
# → http://localhost:4000/?token=dev-op
```
