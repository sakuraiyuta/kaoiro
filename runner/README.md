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

env ファイルは起動シムに **`source` される**ため、シェルとして妥当な内容でなければ
ならない(`KEY=VALUE` の羅列、`=` の前後に空白を入れない、空白を含む値は
クォート)。構文が壊れているとシムは exit 78 で止まる(下記「再起動ポリシーと
終了コード」)。**0600 はシムでは検査しない**(モード確認の可搬性が OS 依存で、
ACL 運用のホストを弾いてしまうため)ので、運用側で担保する。

### 共通の準備

以下のコマンドはすべて**リポジトリルートで実行する**(パスが相対のため)。

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

サービス登録前に起動シムだけを試せる。**`server_url` を到達不能な値にし、かつ
`host_id` を実環境と衝突しない値にする**。二重に必要な理由:

- `server_url` を実サーバに向けたまま起動すると、そのサーバへ register して
  しまう
- `HostRegistry.register/4` は `host_id` をキーに entry を**上書き**し(runner_pid
  も差し替わる)、切断時の `drop/3` は pid 一致で**エントリを削除**する。実 runner
  は socket を維持している間 re-register しないため(`updateRegister` は config
  reload 時のみ発火)、**同じ host_id で一瞬繋ぐだけで実ホストの登録が消える**。
  host_id が違えば `server_url` を間違えても上書きは起きない

```sh
tmp=$(mktemp -d)
python3 - "$tmp/runner.config.json" <<'PY'
import json, sys, os
cfg = json.load(open("runner/runner.config.example.json"))
cfg["host_id"] = f"test-host-{os.urandom(3).hex()}"   # 実環境と衝突しない
cfg["server_url"] = "ws://127.0.0.1:59999/runner"     # 到達不能にする
cfg["cwd_allowlist"] = [os.getcwd()]
json.dump(cfg, open(sys.argv[1], "w"), indent=2)
PY
printf 'KAOIRO_RUNNER_TOKEN=dummy\n' > "$tmp/runner.env"
chmod 600 "$tmp/runner.env"
KAOIRO_RUNNER_DIR="$tmp" timeout 6 sh runner/deploy/kaoiro-runner-launch.sh
# 接続エラーを出しつつ生存すれば OK(timeout の 124 で終了)
```

`timeout` は GNU coreutils のコマンドで、macOS には標準で入っていない。
`brew install coreutils` で入る `gtimeout` に読み替えるか、`timeout` を外して
Ctrl-C で止める。

設定不備の扱いも同じ手順で確認できる(いずれも exit 78):

```sh
KAOIRO_RUNNER_DIR=$(mktemp -d) sh runner/deploy/kaoiro-runner-launch.sh
KAOIRO_RUNNER_DIR="$tmp" KAOIRO_NODE=/nonexistent sh \
  runner/deploy/kaoiro-runner-launch.sh
```

### nvm / fnm / asdf を使っている場合

systemd user unit と launchd agent は最小の PATH で起動するため、
`node` が見つからない。`runner.env` に絶対パスを書く:

```sh
KAOIRO_NODE=/home/you/.nvm/versions/node/v22.20.0/bin/node
```

## 配布物の作成(tarball)

Node ランタイムだけを前提とする自己完結アーカイブを作る(issue #70、
[ADR-0018](../docs/adr/0018-runner-distribution.md) の 2026-07-25 改訂)。
wrapper 一式・エンジン CLI(Claude Code / codex は platform 別 npm パッケージ
として実体が入る)・ネイティブモジュールがすべて同梱されるため、**配布先で
`pnpm install` も build も要らない**。

**リポジトリルートで実行する**(スクリプトは自身の位置からルートを解決して
`cd` する)。

```sh
./scripts/build-runner-tarball.sh                      # このホスト向け
./scripts/build-runner-tarball.sh --target linux-x64   # クロス生成
./scripts/build-runner-tarball.sh --out /path/to/dir   # 出力先を変える
```

対象は `darwin-arm64` / `linux-x64`(実需要の 2 arch)。それ以外のホスト
(Intel mac、arm64 Linux)では `--target` を明示しないとエラーになる。出力先は
既定で `dist-tarball/kaoiro-runner-<rev>-<os>-<arch>.tar.gz`(gitignore 済み)。
`--out` に相対パスを渡した場合は**リポジトリルート基準**で解決される。

クロス生成は pnpm の `supportedArchitectures` をビルド中だけ
`pnpm-workspace.yaml` に注入して行い、終了時(中断時も)復元する。この注入は
追跡ファイルを書き換えるため **2 つのビルドを同時に走らせられない**。
`.tarball-build.lock` で排他し、取得できなければ exit 75 で止まるので、
**2 arch は逐次実行する**(異常終了でロックが残った場合はディレクトリを消す)。

サイズ実測(tar.gz): darwin-arm64 **256 MB** / linux-x64 **368 MB**。エンジン
CLI の実体が大半を占める。linux 版は musl 変種も含むため glibc / musl 両対応。

### 配布先での設置

```sh
tar xzf kaoiro-runner-<rev>-linux-x64.tar.gz
cd kaoiro-runner-<rev>-linux-x64

# 設定ディレクトリ(Linux: ${XDG_CONFIG_HOME:-~/.config}/kaoiro、
#                  macOS: ~/Library/Application Support/kaoiro)
conf="${XDG_CONFIG_HOME:-$HOME/.config}/kaoiro"
mkdir -p "$conf"
cp runner.config.example.json "$conf/runner.config.json"
cp deploy/runner.env.example "$conf/runner.env"
chmod 600 "$conf/runner.env"
# runner.config.json の host_id / server_url / cwd_allowlist を編集し、
# runner.env に KAOIRO_RUNNER_TOKEN を書く

./deploy/kaoiro-runner-launch.sh   # 前景起動で疎通確認
```

常駐させるときは上記「常駐化」節の unit / plist を配置する
(`@@DEPLOY_DIR@@` には展開先の `deploy/` の絶対パスを入れる)。**配布物内の
シムは無改造でそのまま使える**。

Gitea release への資産アップロードは
[#145](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/145) で扱う。

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
