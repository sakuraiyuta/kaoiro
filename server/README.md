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

ダッシュボードはトークンを URL クエリで渡す(読み込み後アドレスバーから
自動で消える): `http://localhost:4000/?token=dev-op`。

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

既定で `127.0.0.1:4000` のみに bind(loopback)。LAN 公開時は両トークン必須 +
中央 nginx(WebSocket の Upgrade/Connection 転送・`proxy_read_timeout` > 60s)
配下に置く。

### ローカル(mix)

`mix phx.server` 単体ではダッシュボードが接続拒否されるため、
`KAOIRO_CLIENT_TOKENS` を環境変数で渡す:

```sh
KAOIRO_CLIENT_TOKENS=dev-op:operator mix phx.server
# → http://localhost:4000/?token=dev-op
```
