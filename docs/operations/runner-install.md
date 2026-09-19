---
title: Runner install and distribution
description: Build and distribute runner tarballs to agent hosts, install and switch releases, and run the runner as a systemd/launchd service.
status: accepted
last_updated: 2026-09-19
related: [deployment]
---

# Runner install and distribution

## 2. Deploy runners (multiple hosts)

Distribution currently uses tarballs (issue #70, revised 2026-07-25 in
[ADR-0018](../adr/0018-runner-distribution.md)); expand one on each agent host.
This page is canonical for the full procedure and service setup (systemd user
unit / launchd LaunchAgent); this section covers only points specific to
multi-host deployment.

```sh
# ビルドホスト(1 台)で対象アーキテクチャごとに生成
./scripts/build-runner-tarball.sh --target linux-x64
./scripts/build-runner-tarball.sh --target darwin-arm64

# 各エージェントホストへ転送し、release として install する
# (展開先は <install-root>/releases/<rev>/、ADR-0018 2026-08-16 改訂)
./kaoiro-runner-install.sh kaoiro-runner-<rev>-linux-x64.tar.gz
./kaoiro-runner-switch.sh <release-id>
```

The install / switch scripts are in the package's `deploy/`. For the first
installation, expand the archive once and run from there
(`tar xzf ... && cd ... && ./deploy/kaoiro-runner-install.sh ../<archive>`).
Afterward use `<install-root>/current/deploy/`. [Runner artifacts](../reference/deployment/runner-artifacts.md) is canonical for layout; [Runner update and rollback](runner-update-and-rollback.md) is canonical for updates and rollback.

### Run as a service

Templates for systemd user units (Linux) and launchd LaunchAgents (macOS) ship
in `runner/deploy/`. See "常駐化(systemd / launchd)" below for installation,
exit codes, and troubleshooting. In the release profile set `@@DEPLOY_DIR@@` to
`<install-root>/current/deploy`; starting the unit through the symlink is what
makes switching atomic. **Restarting a runner (including service restart) stops
all wrappers beneath it** (`supervisor.stopAll()` on SIGTERM), so
`systemctl --user restart` / `launchctl kickstart -k` with active agents
disconnects every agent on that host.

## 常駐化(systemd / launchd)

ホスト常駐用のサービス定義は [`deploy/`](../../runner/deploy) にある(issue #136)。

**初回設置は `kaoiro-runner-bootstrap.sh <tarball>` の1本で完結する**(issue
#314): wizard(対話はここだけ) → install → switch → unit/plist 配置 →
enable/start を順に行う。OS は `uname -s` で自動判定(Linux は systemd user
unit、macOS は launchd LaunchAgent)。冪等 — 既に config があれば wizard を
スキップし(`--reconfigure` で強制、既存 config は退避してから上書き)、
unit/plist の内容が変わっていなければ何もしない。稼働中サービスを黙って
再起動することはなく、変更があれば再起動コマンドを表示するだけに留める。
`--dry-run` で計画のみ表示。以下は個別 script を手で叩く場合の参照(更新は
対象外、`kaoiro-runner-bootstrap.sh` は初回専用)。

> **既に稼働している配備を新しいバージョンへ更新する手順**は
> [docs/operations/server-update-and-rollback.md](server-update-and-rollback.md)
> (server 側) と
> [docs/operations/runner-update-and-rollback.md](runner-update-and-rollback.md)
> (runner 側) が正本。本節は初回の設置手順のみを扱う。更新は停止順序・DETS
> バックアップ・失敗時の復旧が絡むため、ここには書かない。

| ファイル | 用途 |
|---|---|
| [`deploy/kaoiro-runner-bootstrap.sh`](../../runner/deploy/kaoiro-runner-bootstrap.sh) | 初回設置の単一 entry point。wizard → install → switch → unit/plist → enable/start |
| [`deploy/kaoiro-runner-launch.sh`](../../runner/deploy/kaoiro-runner-launch.sh) | 起動シム。env ファイル読込・config 解決・`exec` を集約 |
| [`deploy/kaoiro-runner.service`](../../runner/deploy/kaoiro-runner.service) | systemd **user** unit(Linux) |
| [`deploy/com.kaoiro.runner.plist`](../../runner/deploy/com.kaoiro.runner.plist) | launchd **LaunchAgent**(macOS) |
| [`deploy/runner.env.example`](../../runner/deploy/runner.env.example) | `KAOIRO_RUNNER_TOKEN` 等を置く env ファイルの雛形 |
| [`deploy/kaoiro-runner-install.sh`](../../runner/deploy/kaoiro-runner-install.sh) | tarball を `releases/<rev>/` へ install する(稼働中の release には触れない) |
| [`deploy/kaoiro-runner-switch.sh`](../../runner/deploy/kaoiro-runner-switch.sh) | `current` を atomic に切り替える / `--rollback` |
| [`deploy/kaoiro-runner-update.sh`](../../runner/deploy/kaoiro-runner-update.sh) | build → install → 停止 → 切替 → 起動 → 確認 → prune を一括で行う。`--detach` で自滅を避ける |
| [`deploy/kaoiro-runner-common.sh`](../../runner/deploy/kaoiro-runner-common.sh) | 上記 3 本が source する共通処理(install root 解決・lock・symlink swap) |

**user サービスとして動かす**(root の system service にはしない)。runner は
ホストユーザの `~/.claude` / `~/.codex` の認証情報を読み、そのユーザのリポジトリ
内で wrapper を spawn するため([ADR-0023](../adr/0023-host-runner-architecture.md))。

**トークンはユニット/plist に書かない**。起動シムが 0600 の env ファイルから
読む。`token` は Phoenix transport のログでも `token=<REDACTED>` に伏せられる。

env ファイルは起動シムに **`source` される**ため、シェルとして妥当な内容でなければ
ならない(`KEY=VALUE` の羅列、`=` の前後に空白を入れない、空白を含む値は
クォート)。構文が壊れているとシムは exit 78 で止まる([Runner artifacts](../reference/deployment/runner-artifacts.md#restart-policy-and-exit-codes)「再起動ポリシーと
終了コード」参照)。**0600 はシムでは検査しない**(モード確認の可搬性が OS 依存で、
ACL 運用のホストを弾いてしまうため)ので、運用側で担保する。

### 共通の準備

以下のコマンドはすべて**リポジトリルートで実行する**(パスが相対のため)。

```sh
pnpm install --frozen-lockfile
pnpm -C wrapper build && pnpm -C runner build   # dist/cli.js を作る

# 設定は runner/README.md の「設定ウィザード」で作るのが早い:
./runner/deploy/kaoiro-runner-setup.sh

# 手で置く場合(Linux: ${XDG_CONFIG_HOME:-~/.config}/kaoiro、
#              macOS: ~/Library/Application Support/kaoiro)
conf="${XDG_CONFIG_HOME:-$HOME/.config}/kaoiro"   # macOS は上記に読み替え
mkdir -p "$conf"
cp runner/runner.config.example.json "$conf/runner.config.json"
cp runner/deploy/runner.env.example "$conf/runner.env"
chmod 600 "$conf/runner.env"
# runner.config.json の host_id / server_url / cwd_allowlist を実環境に合わせ、
# runner.env に KAOIRO_RUNNER_TOKEN を書く
```

`server_url` の env 上書き (`KAOIRO_RUNNER_SERVER_URL`) は
[Runner configuration](../reference/configuration/runner.md) が正本。

`kaoiro-runner-setup.sh` が尋ねる項目・生成先・検証規則は
[Setup wizards](../reference/configuration/setup-wizards.md) が正本。

### 設置形態(issue #219、[ADR-0018](../adr/0018-runner-distribution.md))

**source origin(どこから持ってくるか)と activation layout(どう置いて
起動するか)は別の軸である**。後者は release profile なら 1 通りしかなく、
`@@DEPLOY_DIR@@` に何を入れるかで決まる。

| 形態 | `@@DEPLOY_DIR@@` | 用途 |
|---|---|---|
| **checkout 直挿し** | `<repo>/runner/deploy` | 開発時の手起動のみ。checkout がそのまま live path |
| **local-build release** | `<install-root>/current/deploy` | **本番**。repo で tarball を作り、release として install する |
| **Gitea release** | `<install-root>/current/deploy` | **本番**。配布 tarball を release として install する |

**本番ホストは release profile にする**。checkout を直挿ししたまま常駐させると、
更新のたびに稼働中の `dist` を上書きすることになり、runner が新旧の混ざった
wrapper を掴みうる(runner は wrapper を spawn するたびに on-disk の
artifact を解決し、codex は初回 spawn まで lazy に解決する)。release
profile では build も展開も `releases/<rev>/` の中で完結し、稼働中の
release には一切触れない。

移行手順・更新手順・rollback は
[docs/operations/runner-update-and-rollback.md](runner-update-and-rollback.md)
が正本。

### Linux(systemd user unit)

**以下は release profile(本番)の設置例**。checkout 直挿しで開発時に手起動
したい場合だけ、`$install_root/current/deploy` を `$PWD/runner/deploy` に
読み替える。

```sh
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/kaoiro"
sed "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" \
  runner/deploy/kaoiro-runner.service \
  > ~/.config/systemd/user/kaoiro-runner.service
systemctl --user daemon-reload
systemctl --user enable --now kaoiro-runner
sudo loginctl enable-linger "$USER"   # ログインなしで boot 起動させる
```

- 状態: `systemctl --user status kaoiro-runner`
- ログ: `journalctl --user -u kaoiro-runner -f`
- `enable-linger` を忘れると boot 時に起動しない(ログイン時のみ起動)。
  さらに **SSH セッションのたびに user systemd インスタンス自体が再起動され、
  enabled unit も道連れで再起動される**(issue #142 実機検証で確認、2026-07-26)。
  再起動ポリシー(`Restart=on-failure` / `RestartPreventExitStatus=78`)自体は
  1 つの user systemd インスタンス内では正しく機能するが、`enable-linger` なし
  のホストを SSH 越しに検証すると、接続のたびに unit が再起動しているように
  見えて紛らわしい。「起動 → 異常時再起動」を確認するときは 1 回の SSH
  セッション内で完結させ、接続を跨いだタイムスタンプ変化だけで再起動と
  誤認しないこと。

### macOS(launchd LaunchAgent)

macOS の orchestration は未検証(後続 issue
[#242](https://github.com/sakuraiyuta/kaoiro/issues/242))。
release layout と install / switch は OS 共通に動くが、`@@DEPLOY_DIR@@` を
`current/deploy` へ向けた運用の実機確認は済んでいない。

```sh
mkdir -p ~/Library/Logs/kaoiro
install_root="$HOME/Library/Application Support/kaoiro"
sed -e "s|@@DEPLOY_DIR@@|$install_root/current/deploy|" -e "s|@@HOME@@|$HOME|" \
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
[ADR-0018](../adr/0018-runner-distribution.md) の 2026-07-25 改訂)。
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

./deploy/kaoiro-runner-setup.sh    # 対話で設定を生成
./deploy/kaoiro-runner-launch.sh   # 前景起動で疎通確認
```

ウィザードを使わず手で置く場合は、runner/README.md の「設定ウィザード」節に
挙げた設定ディレクトリへ `runner.config.example.json` /
`deploy/runner.env.example` をコピーして編集する(`runner.env` は
`chmod 600`)。

常駐させるときは上記「常駐化」節の unit / plist を配置する
(`@@DEPLOY_DIR@@` には展開先の `deploy/` の絶対パスを入れる)。**配布物内の
シムは無改造でそのまま使える**。

Gitea release への資産アップロードは
[#140](https://github.com/sakuraiyuta/kaoiro/issues/140) で扱う。

## See Also

- [Multi-host deployment architecture](../architecture/deployment.md).
- [runner/README.md](../../runner/README.md).
- [Runner update and rollback](runner-update-and-rollback.md).
- [Runner artifacts](../reference/deployment/runner-artifacts.md).
- [Runner configuration](../reference/configuration/runner.md).
