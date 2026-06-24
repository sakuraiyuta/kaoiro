# @kaoiro/runner

各ホストに 1 つ常駐し、ホスト内の wrapper(エージェント)群のライフサイクルを
担う supervisor 専任プログラム([ADR-0023](../docs/adr/0023-host-runner-architecture.md))。
データ経路は通らず、サーバへは制御専用トピック `runner:<host_id>` で接続する。

## 現状(phase 4-4a)

- runner config(JSON)を読み、サーバへ接続して**ホスト登録(register)**と
  **生存通知(heartbeat)**を行うところまで。
- spawn / stop / restart の監督ループ(4-4b)、session 列挙 + resume(4-5)は未実装。

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
