# @kaoiro/runner

各ホストに 1 つ常駐し、ホスト内の wrapper(エージェント)群のライフサイクルを
担う supervisor 専任プログラム([ADR-0023](../docs/adr/0023-host-runner-architecture.md))。
データ経路は通らず、サーバへは制御専用トピック `runner:<host_id>` で接続する。

## 現状

- runner config(JSON)を読み、サーバへ接続して**ホスト登録(register)**と
  **生存通知(heartbeat)**を行う(4-4a)。
- operator 指示で wrapper を **spawn / stop / restart** する監督ループ(4-4b)、
  当該 cwd 配下の **session 列挙 + resume**(4-5、T3 実在検証 + F4 ローカルロック)。
- spawn は dashboard からの案A 経路に対応([ADR-0024](../docs/adr/0024-agent-instance-identity-and-spawn-auth.md)):
  agent_id 採番・per-agent token 発行はサーバが行い、runner は `server_url` を
  自 config から補完する。

## 使い方

```sh
node dist/cli.js [configPath]   # configPath 既定 = runner.config.json
```

認証トークンは設定ファイルに置かず、環境変数 `KAOIRO_RUNNER_TOKEN` から渡す
(未設定 = サーバ側 runner 認証が無効な dev 時)。設定例は
[runner.config.example.json](runner.config.example.json) を参照。

## 常駐化(systemd / launchd)

ホスト常駐用のサービス定義は [`deploy/`](deploy) にある(issue #141)。

| ファイル | 用途 |
|---|---|
| [`deploy/kaoiro-runner-launch.sh`](deploy/kaoiro-runner-launch.sh) | 起動シム。env ファイル読込・config 解決・`exec` を集約 |
| [`deploy/kaoiro-runner.service`](deploy/kaoiro-runner.service) | systemd **user** unit(Linux) |
| [`deploy/com.kaoiro.runner.plist`](deploy/com.kaoiro.runner.plist) | launchd **LaunchAgent**(macOS) |
| [`deploy/runner.env.example`](deploy/runner.env.example) | `KAOIRO_RUNNER_TOKEN` 等を置く env ファイルの雛形 |

**user サービスとして動かす**(root の system service にはしない)。runner は
ホストユーザの `~/.claude` / `~/.codex` の認証情報を読み、そのユーザのリポジトリ
内で wrapper を spawn するため([ADR-0023](../docs/adr/0023-host-runner-architecture.md))。

**トークンはユニット/plist に書かない**。起動シムが 0600 の env ファイルから
読む。`token` は Phoenix transport のログでも `token=<REDACTED>` に伏せられる。

### 共通の準備

```sh
pnpm install --frozen-lockfile
pnpm -C wrapper build && pnpm -C runner build   # dist/cli.js を作る

# 設定ディレクトリ(Linux: ${XDG_CONFIG_HOME:-~/.config}/kaoiro、
#                  macOS: ~/Library/Application Support/kaoiro)
conf="${XDG_CONFIG_HOME:-$HOME/.config}/kaoiro"   # macOS は上記に読み替え
mkdir -p "$conf"
cp runner/runner.config.example.json "$conf/runner.config.json"
cp runner/deploy/runner.env.example "$conf/runner.env"
chmod 600 "$conf/runner.env"
# runner.config.json の host_id / server_url / cwd_allowlist を実環境に合わせ、
# runner.env に KAOIRO_RUNNER_TOKEN を書く
```

`server_url` は現状 `runner.config.json` から読む(env 上書きは issue #140 の
予定。入り次第 `runner.env` 側へ移せる)。

### Linux(systemd user unit)

```sh
sed "s|@@DEPLOY_DIR@@|$PWD/runner/deploy|" \
  runner/deploy/kaoiro-runner.service \
  > ~/.config/systemd/user/kaoiro-runner.service
systemctl --user daemon-reload
systemctl --user enable --now kaoiro-runner
sudo loginctl enable-linger "$USER"   # ログインなしで boot 起動させる
```

- 状態: `systemctl --user status kaoiro-runner`
- ログ: `journalctl --user -u kaoiro-runner -f`
- `enable-linger` を忘れると boot 時に起動しない(ログイン時のみ起動)

### macOS(launchd LaunchAgent)

```sh
mkdir -p ~/Library/Logs/kaoiro
sed -e "s|@@DEPLOY_DIR@@|$PWD/runner/deploy|" -e "s|@@HOME@@|$HOME|" \
  runner/deploy/com.kaoiro.runner.plist \
  > ~/Library/LaunchAgents/com.kaoiro.runner.plist
launchctl bootstrap gui/"$(id -u)" \
  ~/Library/LaunchAgents/com.kaoiro.runner.plist
```

- 停止/解除: `launchctl bootout gui/"$(id -u)"/com.kaoiro.runner`
- 再起動: `launchctl kickstart -k gui/"$(id -u)"/com.kaoiro.runner`
- ログ: `~/Library/Logs/kaoiro/runner.log`
- `launchctl load` / `unload` は deprecated。`bootstrap` / `bootout` を使う
- plist は `~` やシェル変数を展開しないため、絶対パスへ置換してから配置する
- **launchd はログをローテートしない**。長期稼働ホストでは `newsyslog.d` に
  設定を追加するか、定期的に切り詰める

### 再起動ポリシーと終了コード

- SIGTERM で runner は配下の wrapper を停止してから **exit 0** で終わる。
  systemd は `Restart=on-failure`、launchd は `KeepAlive.SuccessfulExit=false`
  なので、正常停止は再起動されない
- 起動シムは設定不備(config が無い / node が見つからない / dist 未ビルド)で
  **exit 78**(`EX_CONFIG`)を返す。systemd は `RestartPreventExitStatus=78` で
  再起動せず failed のまま止まる — 原因は `systemctl --user status` に出る。
  launchd に同等の設定はないため `ThrottleInterval=30` で間隔を空けるだけで、
  原因はログファイルを見る
- サーバへ繋がらない間は runner 自身が再接続を続ける(プロセスは落ちない)ため、
  サービスマネージャ側の再起動対象はプロセス死のみ

### 動作確認

サービス登録前に起動シムだけを試せる。**`server_url` は到達不能な値にする**
(`runner.config.example.json` のまま実行すると、稼働中の localhost:4000 の
サーバに同じ `host_id` で register してしまい、既存 runner のホスト登録を
上書き・削除する)。

```sh
tmp=$(mktemp -d)
cp runner/runner.config.example.json "$tmp/runner.config.json"
# server_url を ws://127.0.0.1:59999/runner 等に書き換える
printf 'KAOIRO_RUNNER_TOKEN=dummy\n' > "$tmp/runner.env"
chmod 600 "$tmp/runner.env"
KAOIRO_RUNNER_DIR="$tmp" timeout 6 sh runner/deploy/kaoiro-runner-launch.sh
# 接続エラーを出しつつ生存すれば OK(timeout の 124 で終了)
```

### nvm / fnm / asdf を使っている場合

systemd user unit と launchd agent は最小の PATH で起動するため、
`node` が見つからない。`runner.env` に絶対パスを書く:

```sh
KAOIRO_NODE=/home/you/.nvm/versions/node/v22.20.0/bin/node
```

### 単一バイナリ配布へ移行するとき

配布形態が変わっても差分は
[`deploy/kaoiro-runner-launch.sh`](deploy/kaoiro-runner-launch.sh) 末尾の
`exec` 行 1 行(issue #70)。unit / plist は変更不要。

## Codex 設定

`runner.config.json` の `codex` ブロックで Codex engine 固有の設定を渡す。

- `chatgpt_plan` — operator 申告の ChatGPT plan(catalog 解決に使用、
  API-key auth では無視)。
- `internal_subagents`(boolean、既定 `true`)— Codex の内部サブエージェント
  spawn の可否。正の boolean で、`true` は force-enable、`false` は無効化、
  省略は effective default の `true`。wrapper が per-run config に effective 値を
  常に `features.multi_agent` として注入する
  ([ADR-0038](../docs/adr/0038-codex-internal-subagents-toggle.md))。

**precedence**: runner option を SoT とし、user-global な Codex config
(`~/.codex/config.toml` 等)より **上位**。effective(= configured ?? true)を
常に per-run config へ書き込むため、global 設定に依らず runner の意図が優先
される(`false` のみ実際に無効化、`true` / 省略も明示注入)。

**live reload**: config を書き換えると次回以降の spawn にのみ反映される。稼働中の
wrapper プロセスは launch 時の値を保持し、即時には変わらない。

## 開発

```sh
pnpm -C runner typecheck
pnpm -C runner test
pnpm -C runner build
```

ローカルスタックは [`scripts/dev.sh`](../scripts/dev.sh) が server / dashboard /
runner を一括起動する。runner は `tsx watch` で動き、環境変数
`KAOIRO_WRAPPER_DEV=1` のとき **spawn する wrapper も `tsx watch` で起動**するため、
wrapper のソース編集が稼働中エージェントへホットリロードされる(本番は dist を
直接起動、ADR-0018)。
