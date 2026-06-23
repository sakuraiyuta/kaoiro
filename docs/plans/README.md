# Plans

フェーズは順に進める(スキップしない)。

| Phase | File | Status | 説明 |
|-------|------|--------|------|
| 0 | [phase-0-project-setup](phase-0-project-setup.md) | ✅ | 企画・リポジトリ立ち上げ |
| 1 | [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md) | ✅ | ラッパー1個 + 状態機械 |
| 1.5 | [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md) | ✅ | 最小サーバ + 最小クライアント(縦串) |
| 2 | [phase-2-client-character](phase-2-client-character.md) | ✅ | クライアント + キャラ + 表情 |
| 3 | [phase-3-server-multiagent](phase-3-server-multiagent.md) | ✅ | サーバ集約 + 複数 + 双方向 |
| 3.5 | [phase-3.5-response-display](phase-3.5-response-display.md) | ⏳ | 返答表示(同梱ダッシュボード実用化) |
| 3.6 | [phase-3.6-dashboard-separation](phase-3.6-dashboard-separation.md) | ⏳ | ダッシュボード別ディレクトリ化 + 同梱整理(優先度低) |
| 4 | [phase-4-host-runner](phase-4-host-runner.md) | ⏳ | ホスト常駐 runner(spawn/監督/ホスト登録、[ADR-0023](../adr/0023-host-runner-architecture.md)) |
| 5 | [phase-5-i18n](phase-5-i18n.md) | ⏳ | ベータ前 英訳工程 |
| 6 | [phase-6-emotion-filter](phase-6-emotion-filter.md) | ⏳ | 感情フィルタ(味付け) |

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
