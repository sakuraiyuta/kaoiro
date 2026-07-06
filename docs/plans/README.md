# Plans

フェーズは順に進める(スキップしない)。

| Phase | File | Status | 説明 |
|-------|------|--------|------|
| 0 | [phase-0-project-setup](phase-0-project-setup.md) | ✅ | 企画・リポジトリ立ち上げ |
| 1 | [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md) | ✅ | ラッパー1個 + 状態機械 |
| 1.5 | [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md) | ✅ | 最小サーバ + 最小クライアント(縦串) |
| 2 | [phase-2-client-character](phase-2-client-character.md) | ✅ | クライアント + キャラ + 表情 |
| 3 | [phase-3-server-multiagent](phase-3-server-multiagent.md) | ✅ | サーバ集約 + 複数 + 双方向 |
| 3.5 | [phase-3.5-response-display](phase-3.5-response-display.md) | 🟡 | 返答表示(同梱ダッシュボード実用化)。Stage ポリッシュ([issue #21](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/21))残 |
| 3.6 | [phase-3.6-dashboard-separation](phase-3.6-dashboard-separation.md) | ⏳ | ダッシュボード別ディレクトリ化 + 同梱整理(優先度低) |
| 4 | [phase-4-host-runner](phase-4-host-runner.md) | 🟡 | ホスト常駐 runner(spawn/監督/ホスト登録、[ADR-0023](../adr/0023-host-runner-architecture.md))。単一バイナリ配布(4-7)のみ残 |
| 5 | [phase-5-i18n](phase-5-i18n.md) | ⏳ | ベータ前 英訳工程 |
| 6 | [phase-6-emotion-filter](phase-6-emotion-filter.md) | ⏳ | 感情フィルタ(味付け) |
| 7 | [phase-7-file-upload](phase-7-file-upload.md) | ✅ | ファイルアップロード(添付の取り込み、[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)) |
| 8 | [phase-8-inter-agent-messaging](phase-8-inter-agent-messaging.md) | 🟡 | エージェント間メッセージング(複数 AI エージェントの協調対話、[issue #17](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/17))。Stage B(MVP)まで実装、Stage C/D 未着手 |
| 9 | [phase-9-external-human-messaging](phase-9-external-human-messaging.md) | ⏳ | 外部人間メッセージング(Discord、双方向 transport / 一方向 authority、[ADR-0028](../adr/0028-external-human-messaging.md)) |
| 10 | [phase-10-persona-server-sot](phase-10-persona-server-sot.md) | ✅ | ペルソナ server 集約 SoT + zip pack 配布、[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) |
| 11 | [phase-11-agent-directory-and-restore](phase-11-agent-directory-and-restore.md) | 🟡 | サーバ再起動越しの agent identity 永続と client 明示復元(一括/個別)、[ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md)、[issue #41](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/41)。実装は完了、手動 dogfooding 検収のみ残 |

## Feature-local plans

ロードマップ番号を持たない feature-local plan。対象 feature の phase-0 /
phase-1 を plan 内の節として持つ(project の phase-N とは無関係)。

現在は登録なし(旧 `persona-personality-injection` は
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) で
supersede され、以降は [phase-10-persona-server-sot](phase-10-persona-server-sot.md)
に引き継がれた)。

## 将来

- アダプタ拡張(Codex 等)— コアの agent 非依存性を保ったまま追加。
- wrapper のマルチエンティティ・パッケージ構造化(3層 pnpm workspace、
  [ADR-0017](../adr/0017-wrapper-multientity-packages.md))— 主要機能が
  出揃ってから着手。
- wrapper/runner の配布(OS 別単一バイナリ・CLI のみ・Gitea release、
  [ADR-0018](../adr/0018-runner-distribution.md))— 同上。

## Status legend

- ✅ done
- 🟡 mostly done, followups remaining
- ⚠ partial — important spec items missing
- ⏳ not started
- ⛔ blocked
