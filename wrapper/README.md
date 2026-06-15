# @kaoiro/wrapper

kaoiro のラッパー層(TypeScript)。Claude Agent SDK をホストし、SDK メッセージ
列から kaoiro の状態を導出して共通エンベロープへ翻訳する。

仕様: [docs/specs/protocol.md](../docs/specs/protocol.md),
[docs/specs/agent-sdk-events.md](../docs/specs/agent-sdk-events.md)。
計画: [docs/plans/phase-1-wrapper-state-machine.md](../docs/plans/phase-1-wrapper-state-machine.md)。

## 現状(Phase 3.5)

状態導出ロジックを SDK 依存から切り離した純粋関数として実装し、実 SDK
ホスト(`query()` / `canUseTool` / ストリーミング入力)の配線まで完了。
並列ツール実行は未完了 tool_use 集合の追跡で追従する(issue #3)。応答
テキスト(`log`/`result`、operator の指示エコー含む)の中継、サーバ接続
(`ServerLink`)・承認仲介(`PermissionBroker`)も実装済み(ADR-0011/0012)。

| モジュール | 役割 |
|---|---|
| `src/types.ts` | 状態セット・共通エンベロープ v0・アダプタ入力イベントの型 |
| `src/state.ts` | 状態導出(`stepState` / `reduceStates`)とエンベロープ生成 |
| `src/adapter.ts` | 実 SDK メッセージ → `AdapterEvent` の橋渡し |
| `src/host.ts` | `AgentHost` — `query()`/`canUseTool`/ストリーミング入力の配線 |
| `src/persona.ts` | ペルソナ・安定 ID 設定の読み込みと検証 |

`AdapterEvent` は SDK メッセージ列 + `canUseTool` を正規化した状態機械の入力。

## 開発

```sh
pnpm install
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit
```

`pnpm test` / `pnpm typecheck` は push / PR ごとに Gitea Actions
([.gitea/workflows/ci.yml](../.gitea/workflows/ci.yml))でも実行する
(ダッシュボード `server/assets` の `check` / `build` も同 CI で回す)。

## 設定(kaoiro.config.json)

ラッパーは設定ファイル(既定 `kaoiro.config.json`)を読み込む。例は
[kaoiro.config.example.json](kaoiro.config.example.json)。

| キー | 必須 | 意味 |
|---|---|---|
| `agent_id` | ✓ | 安定 ID(再起動をまたいで同一)。文字種は `[A-Za-z0-9._-]`、1〜256 文字 |
| `persona` | ✓ | `{ id, name, sprite_set }`。表示名・立ち絵セット |
| `server_url` | | サーバの wrapper ソケット(例 `ws://localhost:4000/wrapper`)。省略=ローカルのみ(中継なし) |
| `server_token` | | wrapper 認証トークン。サーバで `KAOIRO_WRAPPER_TOKENS` を設定した時に必要(下記) |
| `permission_timeout_ms` | | ツール許可の無応答 deny までの時間(既定 600000 = 600 秒) |
| `allowed_tools` | | 実行可能ツールの上限(ローカル天井、サーバから拡張不可)。省略=読み取り専用 |

## 手動起動

```sh
pnpm build                 # dist/ を生成
pnpm demo                  # = node dist/cli.js(既定 kaoiro.config.json)
# または明示的に:
node dist/cli.js [configPath] [prompt]
```

- **サーバ接続モード**(`server_url` 設定時): 常駐し、ダッシュボードからの
  指示を受けてターンを回す。`prompt` 省略時は idle で起動し最初の指示を待つ。
  ツール許可要求はダッシュボードの承認 UI に中継(無応答は既定 600 秒で deny)。
- **ローカルモード**(`server_url` なし): 1 ターン実行して終了(`prompt`
  省略時はデモ指示)。

### 認証(運用時)

サーバでトークンを設定した場合:

- **ラッパー**: `server_token` を設定し、サーバ側 `KAOIRO_WRAPPER_TOKENS` の
  `agent_id:token` と一致させる(サーバ側未設定なら dev mode で不要)。
- **ダッシュボード(クライアント)**: サーバは `KAOIRO_CLIENT_TOKENS` 未設定
  だと**全クライアント接続を拒否する(fail-closed、issue #28)**。ローカル
  でも必ず設定し、`http://localhost:4000/?token=<token>` で開く。手順は
  [server/README.md](../server/README.md) を参照。
