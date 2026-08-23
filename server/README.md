# @kaoiro/server

kaoiro のサーバ層(Elixir/Phoenix)。ラッパーからの共通エンベロープを
WebSocket(Phoenix Channels, vsn=2.0.0)で受け、最新状態を保持して
クライアントへ配信する。

仕様: [docs/specs/architecture.md](../docs/specs/architecture.md),
[docs/specs/protocol.md](../docs/specs/protocol.md)。
接続方式の決定: [docs/adr/0009-client-transport.md](../docs/adr/0009-client-transport.md)。

## 現状

ラッパーからのエンベロープを受けて最新状態を保持・配信し、双方向ルーティング
(指示・承認・質問)、トークン認証(ADR-0011、issue #28 で client は
fail-closed)と OAuth ログイン(ADR-0042)、返答ログのインメモリ履歴・
operator 限定配信(ADR-0012)、runner のホスト登録と spawn/resume/session
reset 中継(ADR-0023/0024/0036)、ペルソナ pack の集約 SoT 配信(ADR-0029)、
エージェント間メッセージングの routing と wrapper ホスト sidecar による
履歴復元(ADR-0051)、再起動を越える agent identity の永続と明示復元
(ADR-0030)まで実装済み。TLS はリバースプロキシ終端。フェーズ別の状態は
[docs/plans/README.md](../docs/plans/README.md)。

チャネル層:

| モジュール | 役割 |
|---|---|
| `KaoiroServerWeb.WrapperSocket` / `WrapperChannel` | ラッパー受信(`wrapper:<agent_id>`)、検証、中継、disconnected 導出、`persona_prompt` push |
| `KaoiroServerWeb.ClientSocket` / `AgentsChannel` | クライアント配信(`agents:lobby`)、snapshot/history、指示・承認・起動制御 relay、role 配信制御 |
| `KaoiroServerWeb.RunnerSocket` / `RunnerChannel` | ランナー受信(`runner:<host_id>`)、ホスト登録・生存通知、spawn/stop/restart/session reset/catalog probe 中継(ADR-0023) |
| `KaoiroServerWeb.AuthController` / `SessionController` | OAuth ログイン(`/auth/:provider`)と session cookie / WS チケットの発行(ADR-0013 / ADR-0042) |

状態ストア(`Restart-surviving` は DETS 永続、他はインメモリ):

| モジュール | 役割 |
|---|---|
| `AgentStates` | agent_id → 最新エンベロープ + 返答ログ履歴(リングバッファ) |
| `AgentDirectory` | 再起動を越える identity 台帳 `agent_id => {persona, last_seen}`(ADR-0030、restart-surviving) |
| `AgentActivity` | peer-directory メタデータ用の稼働状況投影(phase-27) |
| `SessionPointers` | agent ごとの最新 `session_id` と最後の実効設定 snapshot(ADR-0014、restart-surviving) |
| `SessionStarts` / `ClearWatermarks` | 現行 session の開始点と IA 表示 watermark(issue #106、restart-surviving) |
| `SessionResets` | `/new`・`/clear` の pending lock SSOT と two-phase 完了(ADR-0036 F6/F7) |
| `PermissionModes` | operator が最後に選んだ `permission_mode`(issue #58、restart-surviving) |
| `ConversationStates` / `IngressOrder` | エージェント間メッセージの会話追跡(in-memory)と、clear 境界・IA ingress 用の順序採番(restart-surviving)。IA 履歴の正本は wrapper ホスト sidecar([ADR-0051](../docs/adr/0051-history-restart-resilience.md)) |
| `HostRegistry` | 稼働中ホストと persona trust policy + cwd allow-list(ADR-0023 / ADR-0031) |
| `PersonaAssets` / `PersonaWatcher` | persona pack の取り込み・manifest 生成と zip 変更の auto-watch(ADR-0029) |
| `Auth` / `TokenDenylist` / `OAuth` / `OAuthAllowlist` | wrapper/client/runner のトークン認証、agent_id 単位の失効、OAuth provider 配線と許可リスト |

## 開発

```sh
mix setup       # 依存導入(Elixir のみ)
mix test        # ExUnit
mix phx.server  # localhost:4000
```

ダッシュボードのソースは repo ルートの [`dashboard/`](../dashboard) にあり
(issue #44)、`mix setup` には含めない(Node/pnpm の失敗が server ビルドを
壊さないようにするため)。開発は Vite dev server(下記「ローカル開発」)を使う。
`mix phx.server` 単体で `/` から静的配信させたいときだけ、明示的にビルドする:

```sh
mix dashboard.setup   # cd ../dashboard && pnpm install
mix dashboard.build   # cd ../dashboard && pnpm build → server/priv/static へ出力
```

リリースイメージでは `Dockerfile` の node ステージが同等のビルドを行う。

ソケットエンドポイント: `/wrapper/websocket`(ラッパー)、
`/client/websocket`(クライアント)、`/runner/websocket`(ランナー)。

## セットアップ / 運用

### 認証(必読、issue #28)

接続認証はトークン + role(ADR-0011)で、ダッシュボードだけは OAuth 個人認証
との**併存**([ADR-0042](../docs/adr/0042-oauth-allowlist-login.md))。
**未設定時の挙動は socket で異なる**:

- **`KAOIRO_CLIENT_TOKENS` 未設定 → トークン認証は成立しない(fail-closed)**。
  誤設定で operator が無防備に公開される事故を防ぐため、無認証では稼働しない。
  この状態で入れるのは OAuth ログインを構成した場合だけで、**どちらも未構成
  ならダッシュボードは繋がらず空表示になる**(ローカル開発・デモは通常
  トークンを設定する)。有効な認証手段はダッシュボードが
  `GET /session/auth-methods` で取得して入力欄を出し分ける。
- **`KAOIRO_WRAPPER_TOKENS` 未設定 → リリース(`:prod`)は全ラッパーを拒否
  (fail-closed、issue #133)**。認証を無効化して任意のラッパーを通すのは
  `mix` を `:dev` / `:test` で動かした場合だけで、loopback 限定の開発向け。
- **`KAOIRO_RUNNER_TOKENS` 未設定 → 同じ規則を host_id 単位でランナーに適用
  (ADR-0023)**。`:prod` では join が `unauthorized` で全拒否される。
  docker compose と [`scripts/dogfood.sh`](../scripts/dogfood.sh) は
  リリースイメージを起動するのでこちらに該当する(dogfood は未設定を検出
  すると `.env` にエントリを自動生成し、同じ値を runner へ渡す)。

いずれも未設定なら起動時に警告をログ出力する([threat-model](../docs/specs/threat-model.md))。

| env | 形式 | 例 |
|---|---|---|
| `KAOIRO_CLIENT_TOKENS` | `token:role[:name],...`(role = `viewer` / `operator`。任意の 3 番目の name は kaoiro 内 user の表示名初期値、issue #187) | `dev-op:operator:Ops Bot,view1:viewer` |
| `KAOIRO_WRAPPER_TOKENS` | `agent_id:token,...` | `lab-pc-1.claude-a:wrap-tok` |
| `KAOIRO_RUNNER_TOKENS` | `host_id:token,...` | `lab-pc-1:runner-tok` |
| `KAOIRO_OAUTH_{GOOGLE,GITHUB,NEXTCLOUD}_CLIENT_{ID,SECRET}` | provider ごとの OAuth クレデンシャル(Nextcloud は `KAOIRO_OAUTH_NEXTCLOUD_BASE_URL` も) | — |
| `KAOIRO_OAUTH_ALLOWLIST_PATH` | 許可リストのパス。1 行 `provider:identifier[:role]`(role 省略 = `viewer`)。**未設定/読めない場合は全 OAuth ログインを拒否**(fail-closed) | `/etc/kaoiro/oauth-allowlist.txt` |
| `KAOIRO_EXPOSE_USERS_TO_AGENTS` | agent へ kaoiro user 一覧(id/kind/display_name/role)を開示するか。**config の既定は `true`**(未設定 = 開示)、明示 `false` で opt-out(issue #187 段階2、制約節「原則見える」は config の既定値として実現)。`config` key そのものが欠落する異常系(config/runtime.exs 未実行相当)でのみ実装側 fallback が `false` に倒れる。`directory_request`(`mcp__kaoiro__list_agents` companion)の `users` フィールドに現れる | `false`(既定は開示なので opt-out 時のみ設定) |

**形式の注意**: `KAOIRO_CLIENT_TOKENS` は `<token>:<role>[:<name>]` の順。
生成したシークレット(例 `openssl rand -hex 32`)は **`<token>` 側(コロンの
前)** に置き、role(`operator` / `viewer`)を後ろに書く。省略可能な
`<name>` はこの token での初回ログイン時にだけ使われる表示名の初期値で、
以後は kaoiro 側で独立管理される(issue #187)。例
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

`.env` は対話ウィザードで作れる(issue #139、
[setup-wizards](../docs/specs/setup-wizards.md)):

```sh
cd server
mix kaoiro.env        # SECRET_KEY_BASE 生成・token 3 種の組み立てまで対話で
```

トークンは手入力と自動生成(32 バイト hex)を選べる。DETS パスは同梱
`docker-compose.yaml` が設定するのでウィザードでは聞かず、生成した `.env` に
コメントとして残る。runner 側の設定は別ウィザード
([runner/README.md](../runner/README.md) の「設定ウィザード」)で、トークンは
自動連携しないため値を貼り合わせる。

手で書く場合:

```sh
cd server
cp .env.example .env
# .env を編集:
#   SECRET_KEY_BASE       … `mix phx.gen.secret` で生成
#   KAOIRO_CLIENT_TOKENS  … 必須(未設定だとダッシュボードが接続拒否される)
#   KAOIRO_WRAPPER_TOKENS … 必須(未設定だとリリースが全ラッパーを拒否)
#   KAOIRO_RUNNER_TOKENS  … 必須(未設定だとリリースが全ランナーを拒否)
docker compose up -d --build
# ダッシュボード: http://localhost:4000/?token=<KAOIRO_CLIENT_TOKENS の token>
```

`.env` を変更したら `docker compose up -d`(`restart` では env_file が再読込
されない)、サーバのコードを変えたら `--build` も付けてコンテナを作り直す。

既定で `127.0.0.1:4000` のみに bind(loopback、`docker-compose.yaml` の
`ports` マッピング)。LAN 公開時は両トークン必須 + 中央 nginx(WebSocket の
Upgrade/Connection 転送・`proxy_read_timeout` > 60s)配下に置く。VPN 内
限定なら nginx なしの plain-HTTP 直結も選べる(`KAOIRO_PLAIN_HTTP` +
`KAOIRO_PUBLISH_IP`、[docs/specs/deployment.md](../docs/specs/deployment.md)
1.5 参照)。

コンテナ内の Phoenix 自体の bind IP(compose の `ports` とは別レイヤー)は
既定で prod = 全インターフェース。`docker compose` を使わずホストで直接
release を動かす場合など bind IP を変えたいときは `KAOIRO_BIND_IP`(IPv4/
IPv6 リテラル、例 `0.0.0.0` / `::` / `192.168.1.10`)で上書きできる
(issue #134)。**`:prod` (release) にのみ効き、`mix phx.server`(dev)は
`config/dev.exs` の loopback 固定のまま**— 後述の dev secret_key_base
警告どおり dev を誤って外部公開しないための意図的な仕様。

### ローカル開発(ホットリロード)

> 一括起動なら repo ルートの `./scripts/dev.sh`(サーバ + Vite ダッシュボード +
> runner をホットリロード/watch 付きで起動し、Ctrl-C で一括停止)。`.env` の
> source と runner の `tsx watch` 起動(`KAOIRO_WRAPPER_DEV=1` で wrapper も
> hot-reload spawn)をまとめて行い、エージェントはダッシュボードの「+ 起動」
> から runner 経由で spawn する(ADR-0023)。以下はその手動の内訳。

開発時は docker を使わず、サーバとクライアントをホストで直接起動する。
docker compose は prod release(コンパイル済みを焼き込む)の通し検証用で、
ソースを変えても自動反映しない — ホットリロードには使わない。

env は **docker と同じ `.env` を共用する**(二重管理を避ける)。
`mix phx.server` は `.env` を自動で読まないので、起動前に source する。
dev で最低限必要なのは `KAOIRO_CLIENT_TOKENS` のみ(`SECRET_KEY_BASE` は
`config/dev.exs` のハードコード値、`PHX_HOST` は `localhost` 既定が効くため
dev では不要)。

> **注意(issue #134)**: `config/dev.exs` の `SECRET_KEY_BASE` はリポジトリに
> 平文でハードコードされた固定値。`mix phx.server`(dev モード)を
> `127.0.0.1` 以外に bind して公開すると、この既知の鍵で署名 wrapper
> token(ADR-0024)を偽造できてしまう。**dev モードは常に loopback 限定
> で運用し**、LAN や公開ホストで動かす場合は必ず上の Docker(prod
> release、`SECRET_KEY_BASE` は `.env` の生成値)を使うこと。

```sh
cd server
cp .env.example .env        # Docker 用に用意済みならそのまま使える
# .env に最低限: KAOIRO_CLIENT_TOKENS=dev-op:operator

# 1) サーバ(別ターミナル。lib/ の変更は code_reloader が保存時に自動反映)
set -a && . ./.env && set +a && mix phx.server

# 2) クライアント(別ターミナル。Vite dev server で HMR)
cd ../dashboard && pnpm dev

# 3) runner(別ターミナル、repo ルートから。エージェントの起動・再開は
#    ダッシュボードの「+ 起動」から行う)
cd runner &&
  KAOIRO_WRAPPER_DEV=1 pnpm exec tsx watch src/cli.ts runner.config.json
```

- サーバ: `config/dev.exs` の `code_reloader: true` で `lib/` の変更を保存時に
  自動再コンパイル・反映。`.env` を書き換えたときだけ source し直して再起動する。
- クライアント: Vite が表示する URL(既定 `http://localhost:5173`)を開く。
  `defaultSocketUrl` は origin 基準で `/client` に繋ぐため、その WebSocket は
  `../dashboard/vite.config.ts` の proxy で 4000 の Phoenix へ転送される
  (dev は `check_origin: false`)。ダッシュボードは従来どおり `?token=<token>`
  が必要: `http://localhost:5173/?token=dev-op`。
- runner: 設定は `runner/runner.config.json`(gitignored。初回は
  `./scripts/dev.sh` が localhost 既定で自動生成)。wrapper は runner が
  ダッシュボードの「+ 起動」指示で spawn し、`KAOIRO_WRAPPER_DEV=1` なら
  wrapper ソースの編集も実行中エージェントへ hot-reload される。
- `.env` は単純な `KEY=VALUE` 形式にする(値にスペースやクォートを含めると
  `set -a && . ./.env` での読み込みが壊れる)。

最小確認だけなら source せず 1 変数を inline で渡してもよい(HMR なし):

```sh
KAOIRO_CLIENT_TOKENS=dev-op:operator mix phx.server
# → http://localhost:4000/?token=dev-op
```
