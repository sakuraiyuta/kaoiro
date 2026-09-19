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

Moved to [Runner configuration](../docs/reference/configuration/runner.md#other-runnerconfigjson-and-env-fields) (`KAOIRO_RUNNER_SERVER_URL` の優先順位、`context_work_budget_percent`、`KAOIRO_RUNNER_LOG_PHOENIX_HEARTBEATS`)。

## 設定ウィザード

`runner.config.json` と `runner.env` を対話生成する(issue #139、
[setup-wizards](../docs/reference/configuration/setup-wizards.md))。手で書くより取り違えが
少ないので、初回はこちらを使う。

```sh
./deploy/kaoiro-runner-setup.sh   # 配布物・リポジトリのどちらからでも
node dist/setup-cli.js            # 直接叩く場合 (runner/ から)
```

聞かれるのは host_id / server URL / 起動許可 cwd / engine(capabilities)/
Codex を選んだ場合はその auth mode / トークン / node の絶対パス。
`codex.chatgpt_plan` / `codex.extra_models` / `codex.internal_subagents` /
`antigravity.extra_models` / `antigravity.cli_path` /
`antigravity.probe_timeout_ms` / `context_work_budget_percent` は
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

Moved to [Runner install and distribution](../docs/operations/runner-install.md#常駐化systemd--launchd).

### 共通の準備

Moved to [Runner install and distribution](../docs/operations/runner-install.md#共通の準備).

### 設置形態(issue #219、[ADR-0018](../docs/adr/0018-runner-distribution.md))

Moved to [Runner install and distribution](../docs/operations/runner-install.md#設置形態issue-219adr-0018).

### Linux(systemd user unit)

Moved to [Runner install and distribution](../docs/operations/runner-install.md#linuxsystemd-user-unit).

### macOS(launchd LaunchAgent)

Moved to [Runner install and distribution](../docs/operations/runner-install.md#macoslaunchd-launchagent).

### 再起動ポリシーと終了コード

Moved: the rollout-ordering rationale to [Multi-host deployment architecture](../docs/architecture/deployment.md#rollout-ordering); the exit-code and manifest-verification contract to [Runner artifacts](../docs/reference/deployment/runner-artifacts.md#restart-policy-and-exit-codes).

### 動作確認

Moved to [Runner install and distribution](../docs/operations/runner-install.md#動作確認).

### nvm / fnm / asdf を使っている場合

Moved to [Runner install and distribution](../docs/operations/runner-install.md#nvm--fnm--asdf-を使っている場合).

## 配布物の作成(tarball)

Moved to [Runner install and distribution](../docs/operations/runner-install.md#配布物の作成tarball).

### 配布先での設置

Moved to [Runner install and distribution](../docs/operations/runner-install.md#配布先での設置).

## Codex backend selection

Moved to [Runner configuration](../docs/reference/configuration/runner.md#codex-backend-selection).

## Codex 設定

Moved to [Runner configuration](../docs/reference/configuration/runner.md#codex-設定).

## Antigravity configuration

Moved to [Runner configuration](../docs/reference/configuration/runner.md#antigravity-configuration).

## 開発

```sh
pnpm -C runner typecheck
pnpm -C runner test
pnpm -C runner build
```

dev.sh のホットリロード運用は
[Runner development](../docs/contributing/runner-development.md) が正本。
