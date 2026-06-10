# @kaoiro/server

kaoiro のサーバ層(Elixir/Phoenix)。ラッパーからの共通エンベロープを
WebSocket(Phoenix Channels, vsn=2.0.0)で受け、最新状態を保持して
クライアントへ配信する。

仕様: [docs/specs/architecture.md](../docs/specs/architecture.md),
[docs/specs/protocol.md](../docs/specs/protocol.md)。
接続方式の決定: [docs/adr/0009-client-transport.md](../docs/adr/0009-client-transport.md)。

## 現状(Phase 1.5)

トレーサーバレットの最小中継。認証・TLS・複数集約・双方向ルーティングは
Phase 3([docs/plans/](../docs/plans/))。

| モジュール | 役割 |
|---|---|
| `KaoiroServer.AgentStates` | agent_id → 最新エンベロープの保持 |
| `KaoiroServerWeb.WrapperSocket` / `WrapperChannel` | ラッパー受信(`wrapper:<agent_id>`)、検証、中継 |
| `KaoiroServerWeb.ClientSocket` / `AgentsChannel` | クライアント配信(`agents:lobby`)、join 時スナップショット |

## 開発

```sh
mix setup       # 依存導入
mix test        # ExUnit
mix phx.server  # localhost:4000
```

ソケットエンドポイント: `/wrapper/websocket`(ラッパー)、
`/client/websocket`(クライアント)。
