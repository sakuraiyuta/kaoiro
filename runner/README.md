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

## Configuration

See [Runner configuration](../docs/reference/configuration/runner.md#other-runnerconfigjson-and-env-fields) for the remaining runner config fields and environment variables.

## Setup wizard

The [setup wizard reference](../docs/reference/configuration/setup-wizards.md) covers runner config and environment file generation. When Antigravity is selected, the wizard checks for `agy` and reports its version when available; the runner's later `agy --version` probe is informational and does not gate startup.

## Running as a service (systemd / launchd)

Moved to [Runner install and distribution](../docs/operations/runner-install.md#running-as-a-service-systemd--launchd).

### Common preparation

Moved to [Runner install and distribution](../docs/operations/runner-install.md#common-preparation).

### Deployment forms (issue #219, [ADR-0018](../docs/adr/0018-runner-distribution.md))

Moved to [Runner install and distribution](../docs/operations/runner-install.md#deployment-forms-issue-219-adr-0018).

### Linux (systemd user unit)

Moved to [Runner install and distribution](../docs/operations/runner-install.md#linux-systemd-user-unit).

### macOS (launchd LaunchAgent)

Moved to [Runner install and distribution](../docs/operations/runner-install.md#macos-launchd-launchagent).

### Restart policy and exit codes

See [rollout ordering](../docs/architecture/deployment.md#rollout-ordering) and the [runner artifact contract](../docs/reference/deployment/runner-artifacts.md#restart-policy-and-exit-codes).

### Verification

Moved to [Runner install and distribution](../docs/operations/runner-install.md#verification).

### When using nvm / fnm / asdf

Moved to [Runner install and distribution](../docs/operations/runner-install.md#when-using-nvm--fnm--asdf).

## Creating distribution tarballs

Moved to [Runner install and distribution](../docs/operations/runner-install.md#creating-distribution-tarballs).

### Installation on the target host

Moved to [Runner install and distribution](../docs/operations/runner-install.md#installation-on-the-target-host).

## Codex backend selection

Moved to [Runner configuration](../docs/reference/configuration/runner.md#codex-backend-selection).

## Codex configuration

Moved to [Runner configuration](../docs/reference/configuration/runner.md#codex-configuration).

## Antigravity configuration

Moved to [Runner configuration](../docs/reference/configuration/runner.md#antigravity-configuration).

## Development

Install workspace dependencies and build the wrapper packages first, including on a
fresh checkout. The runner test command builds its own distribution before Vitest
starts because CLI integration tests execute the distributed entry points. A build
failure stops the test command.

```sh
pnpm install --frozen-lockfile
pnpm -C wrapper build
pnpm -C runner typecheck
pnpm -C runner test
pnpm -C runner build
```

See [Runner development](../docs/contributing/runner-development.md) for dev.sh hot reload.
