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
