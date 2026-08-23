# @kaoiro/runner

各ホストに 1 つ常駐し、ホスト内の wrapper(エージェント)群のライフサイクルを
担う supervisor 専任プログラム([ADR-0023](../docs/adr/0023-host-runner-architecture.md))。
データ経路は通らず、サーバへは制御専用トピック `runner:<host_id>` で接続する。

## 現状

- runner config(JSON)を読み、サーバへ接続して**ホスト登録**(register)と
  **生存通知**(heartbeat)を行う(4-4a)。config はホットリロードに対応
  (`config-watcher.ts`)。
- operator 指示で wrapper を **spawn / stop / restart** する監督ループ(4-4b)、
  当該 cwd 配下の **session 列挙 + resume**(4-5、T3 実在検証 + F4 ローカルロック)、
  稼働中 agent の resume 先差し替え(`switch_session`)。
- 予告済み wrapper cycle の相関(issue #256)。`restart` の
  server-issued `request_id` を relaunch 後 wrapper config の
  `transition_id` に置き換え、server が planned 復帰を exact match で
  確定できるようにする。`request_id` 省略(旧 server) は従来動作。
- spawn は dashboard からの案A 経路に対応([ADR-0024](../docs/adr/0024-agent-instance-identity-and-spawn-auth.md)):
  agent_id 採番・per-agent token 発行はサーバが行い、runner は `server_url` を
  自 config から補完する。
- **session reset**(`/new`・`/clear`)の実行主体。kill → fresh relaunch し、
  失敗時は旧 session へ rollback する([ADR-0036](../docs/adr/0036-session-lifecycle-commands.md) F2)。
- **resume snapshot の再適用**。server が同梱する最後の実効設定(model /
  effort / permission_mode / sandbox / network_access)を 5-case の pair
  ルールで `ParsedSpawn` へ反映する([ADR-0014](../docs/adr/0014-session-resume-and-restore.md)
  F1 追補、phase-22 / 23)。session_id を持たない agent の fresh-restore
  (`apply_resume_snapshot`)も同経路(phase-25)。
- **engine catalog の live probe**。`refresh_engine_catalog` を受けて短命な
  SDK probe を回し、memory-only の last-known-good キャッシュを更新して
  再 register する([ADR-0039](../docs/adr/0039-engine-catalog-live-probe.md))。

## 使い方

```sh
node dist/cli.js [configPath]   # configPath 既定 = runner.config.json
```

認証トークンは設定ファイルに置かず、環境変数 `KAOIRO_RUNNER_TOKEN` から渡す。
サーバ側 `KAOIRO_RUNNER_TOKENS` が未設定のとき、runner 認証が無効になるのは
`:dev` / `:test` のみで、**`:prod` では全 runner が拒否される**(runner には
wrapper のようなサーバ署名トークン経路が無いため、issue #133)。設定例は
[runner.config.example.json](runner.config.example.json) を参照。

接続先 `server_url` は環境変数 `KAOIRO_RUNNER_SERVER_URL` で上書きできる
(**env が config ファイルより優先**、issue #135)。配布バイナリ/サービス運用
(systemd/launchd ユニット、`env_file` 等)で `runner.config.json` を編集せず
接続先を切り替えたい場合に使う。`ws://` または `wss://` で始まる必要があり、
不正な形式は起動時 / config reload 時に fail-fast する。ホットリロード
(`watchRunnerConfig`)でも同じ優先順位を維持するため、env 設定中に
`runner.config.json` の `server_url` を書き換えても実際の接続先は変わらない
(host_id 等の他フィールド変更によるホットリロード自体は通常どおり効く)。

`context_work_budget_percent` は Claude の context window に対する soft な
作業予算の割合で、既定は `60`。wrapper は SDK が返した各 model の `maxTokens`
から token 分母を導出するため、1M window では 600k、200k window では 120k が
作業予算になる。`0 < 値 <= 100` の有限数だけを受け付け、変更は hot reload 後の
次回 spawn から反映される。生窓の使用率とこの作業予算比は、dashboard と wrapper
の context 通知で分母付きに併記される(issue #254)。

runner の Phoenix wire log は、定期 heartbeat の push と対応する reply を既定で
省略する。他の transport / reconnect / error / 制御メッセージは従来どおり出力される。
接続レベルの調査で従来の全量出力が必要な場合だけ、`runner.env` に
`KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1` を設定する。`1` 以外・未設定は省略のまま。
この値は runner 起動時に `process.env` から読むため、変更後は runner サービスを
再起動する。dogfood の一時調査では
`KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS=1 scripts/dogfood.sh` として起動すれば、
`tmp/dogfood-logs/runner.log` にも全量が出る。

## 設定ウィザード

`runner.config.json` と `runner.env` を対話生成する(issue #139、
[setup-wizards](../docs/specs/setup-wizards.md))。手で書くより取り違えが
少ないので、初回はこちらを使う。

```sh
./deploy/kaoiro-runner-setup.sh   # 配布物・リポジトリのどちらからでも
node dist/setup-cli.js            # 直接叩く場合 (runner/ から)
```

聞かれるのは host_id / server URL / 起動許可 cwd / engine(capabilities)/
Codex を選んだ場合はその auth mode / トークン / node の絶対パス。
`codex.chatgpt_plan` / `codex.internal_subagents` / `context_work_budget_percent` は
ウィザードでは聞かず、必要なら生成後の `runner.config.json` に手で足す。出力先は OS 別ユーザ設定ディレクトリ(Linux
`${XDG_CONFIG_HOME:-~/.config}/kaoiro`、macOS
`~/Library/Application Support/kaoiro`。`KAOIRO_RUNNER_DIR` で上書き可)で、
起動シムが読む場所と同じ。

- トークンは「手入力 / 自動生成(32 バイト hex)」を選べる。`runner.env` は 0600
  で書き、**config JSON にトークンは入らない**
- 書き出す前に runner のローダ(`parseRunnerConfig`)を通すので、起動時に
  reject される設定は生成されない
- 既存ファイルは上書き前に確認する(断ればそのファイルは保持される)
- **対話専用**。TTY が無い環境では exit 78 で止まる(systemd / launchd から
  呼ばれたときに無応答で固まるのを防ぐため)。無人配備向けのフラグ指定は
  [#141](https://github.com/sakuraiyuta/kaoiro/issues/141)
- server 側の `.env` は別ウィザード(`mix kaoiro.env`、
  [server/README.md](../server/README.md))。トークンは自動連携しないので、
  表示された値を server 側の `KAOIRO_RUNNER_TOKENS` に貼る

## 常駐化(systemd / launchd)

ホスト常駐用のサービス定義は [`deploy/`](deploy) にある(issue #136)。

> **既に稼働している配備を新しいバージョンへ更新する手順**は
> [docs/specs/deployment.md](../docs/specs/deployment.md) の「既存配備の更新」が
> 正本。本節は初回の設置手順のみを扱う。更新は停止順序・DETS バックアップ・
> 失敗時の復旧が絡むため、ここには書かない。

| ファイル | 用途 |
|---|---|
| [`deploy/kaoiro-runner-launch.sh`](deploy/kaoiro-runner-launch.sh) | 起動シム。env ファイル読込・config 解決・`exec` を集約 |
| [`deploy/kaoiro-runner.service`](deploy/kaoiro-runner.service) | systemd **user** unit(Linux) |
| [`deploy/com.kaoiro.runner.plist`](deploy/com.kaoiro.runner.plist) | launchd **LaunchAgent**(macOS) |
| [`deploy/runner.env.example`](deploy/runner.env.example) | `KAOIRO_RUNNER_TOKEN` 等を置く env ファイルの雛形 |
| [`deploy/kaoiro-runner-install.sh`](deploy/kaoiro-runner-install.sh) | tarball を `releases/<rev>/` へ install する(稼働中の release には触れない) |
| [`deploy/kaoiro-runner-switch.sh`](deploy/kaoiro-runner-switch.sh) | `current` を atomic に切り替える / `--rollback` |
| [`deploy/kaoiro-runner-update.sh`](deploy/kaoiro-runner-update.sh) | build → install → 停止 → 切替 → 起動 → 確認 → prune を一括で行う。`--detach` で自滅を避ける |
| [`deploy/kaoiro-runner-common.sh`](deploy/kaoiro-runner-common.sh) | 上記 3 本が source する共通処理(install root 解決・lock・symlink swap) |

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

# 設定は上記「設定ウィザード」で作るのが早い:
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

`server_url` は `runner.config.json` から読むほか、`runner.env` に
`KAOIRO_RUNNER_SERVER_URL` を書いて上書きできる(env が優先 — 冒頭の説明を
参照。issue #135)。

### 設置形態(issue #219、[ADR-0018](../docs/adr/0018-runner-distribution.md))

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
[docs/specs/deployment.md](../docs/specs/deployment.md) の 4.6 が正本。

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

### 再起動ポリシーと終了コード

issue #256 を含む release の rollout は **runner / wrapper を先行し、server を
後行**する。新 server は operator restart の `request_id` を wrapper の
`transition_id` まで運べる runner と、`peer_reconnecting` / `reconnected` を
解釈できる wrapper が配備済みであることを前提に planned window を開始する。
逆順(server 先行)では旧 runner が token を relaunch へ運べず、当該 agent 宛 IA
が最大 60 秒 bounce し、旧 wrapper は close notice を解釈できないため
reconnecting 状態も解消されない。

- SIGTERM で runner は配下の wrapper を停止してから **exit 0** で終わる。
  systemd は `Restart=on-failure`、launchd は `KeepAlive.SuccessfulExit=false`
  なので、正常停止は再起動されない
- 起動シムは設定不備(config が無い / node が見つからない / release 検証に
  失敗)で **exit 78**(`EX_CONFIG`)を返す。検証は
  [`deploy/verify-release.mjs`](deploy/verify-release.mjs) が行い、**シムは
  build しない**(issue #219)。
- **どんな検証失敗も 78 へ写す**のが要点。sentinel を数個並べる方式では、
  実 dist から module を 1 つ削っただけで検査を通過し、import 時に node の
  exit 1 で落ちた — `RestartPreventExitStatus=78` が一致せず **restart loop**
  になる。78 にすることで failed のまま止まり、`systemctl --user status` に
  原因が出る。
- 検証対象は builder が生成する `MANIFEST.json`。中身は runner 自身の
  `dist/` と、runner が spawn する wrapper 2 種から **依存宣言をたどって
  到達する `@kaoiro/*` パッケージ全部**の `dist/`(`@kaoiro/wrapper-core` /
  `@kaoiro/agent-common` を含む)。dist を 3 本列挙する初版はこの推移層を
  落としており、`wrapper-core` から 1 ファイル消しても検証を通過して
  agent spawn 時に落ちた(実 tarball で実測、2026-08-16)。起動時は存在検査のみで、
  sha256 の照合は install / switch 時に行う(起動 latency を守るため)。
  **縮退の判別子は `VERSION` の有無であって、manifest が読めたかどうかでは
  ない。**`VERSION` を書くのは builder だけで、同じ実行で `MANIFEST.json` も
  書く。したがって `VERSION` があって manifest が無い木は「release が
  ファイルを失った」であり、repo-direct checkout ではない — この場合は
  exit 78 で拒否する。縮退するのは `VERSION` も無いときだけ。`ENOENT` 以外の
  read error は「不在」ではなく「読めない」として扱う。
- **install / switch は manifest を単独の証拠として扱わない。**module graph を
  独立に再導出し(各 module に書かれた import を実際に辿る)、manifest が
  取りこぼした module を拒否する。ディレクトリ列挙では削除を検出できない —
  削除されたファイルは列挙からも消えるため。`dist/cli.js` は `args.js` を
  消しても `./args.js` を import したままなので、その宙吊りの参照が検出の
  手がかりになる。
  **信頼境界: 再導出の入力は同一 tree 内の `package.json` である。**
  `MANIFEST.json` を書き換えられる主体は依存宣言も書き換えられるので、
  **これは改ざん耐性ではない。**閉じるのは builder 自身のバグと、配布後の
  部分的・素朴な破損である。その閾値を超える保証が要るなら、署名または
  tree 外の digest を別途検討すること。systemd は `RestartPreventExitStatus=78` で
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

./deploy/kaoiro-runner-setup.sh    # 対話で設定を生成
./deploy/kaoiro-runner-launch.sh   # 前景起動で疎通確認
```

ウィザードを使わず手で置く場合は、上記「設定ウィザード」節に挙げた設定
ディレクトリへ `runner.config.example.json` / `deploy/runner.env.example` を
コピーして編集する(`runner.env` は `chmod 600`)。

常駐させるときは上記「常駐化」節の unit / plist を配置する
(`@@DEPLOY_DIR@@` には展開先の `deploy/` の絶対パスを入れる)。**配布物内の
シムは無改造でそのまま使える**。

Gitea release への資産アップロードは
[#140](https://github.com/sakuraiyuta/kaoiro/issues/140) で扱う。

## Codex 設定

`runner.config.json` の `codex` ブロックで Codex engine 固有の設定を渡す。

- `auth_mode`(`"chatgpt"` / `"apikey"`)— Codex アダプタの catalog 解決に
  使う auth mode の明示宣言(phase-24)。優先順位は **明示宣言 > codex CLI
  の `doctor` 検出 > `"unknown"`** で、宣言があれば検出をスキップするため
  runner の PATH に codex binary が無くても catalog が空にならない。これは
  catalog 選択用の宣言 metadata にすぎず、runner は credential を付与も変更
  もしない。`chatgpt_plan` からの暗黙推定はしない(API-key auth なのに plan
  が書かれた config を誤判定するため)。誤宣言すると catalog が実 entitlement
  とずれ、未対応 model / effort の明示要求が SDK 側で loud fail して既存の
  `switch_error` rollback に落ちる。
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
