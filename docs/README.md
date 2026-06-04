# docs

kaoiro のドキュメント。各サブフォルダに README index がある。

| フォルダ | 内容 |
|--------|------|
| [specs/](specs/) | 機能仕様(トピック別) |
| [plans/](plans/) | フェーズ別の実装計画とステータス |
| [open-questions/](open-questions/) | 未決の論点 |
| [adr/](adr/) | アーキテクチャ決定記録 |

## はじめに読む

1. [specs/overview.md](specs/overview.md) — kaoiro とは
2. [plans/README.md](plans/README.md) — 現在のフェーズと残作業
3. [open-questions/README.md](open-questions/README.md) — 要決定事項

## ADR 索引

| # | 決定 | Status |
|---|------|--------|
| [0001](adr/0001-agent-sdk-integration.md) | Claude Agent SDK を統合方式に採用 | accepted |
| [0002](adr/0002-local-wrapper-websocket-topology.md) | ラッパーはローカル、WebSocket で集約 | accepted |
| [0003](adr/0003-persona-identity-persistence.md) | ペルソナ同一性の永続化 | accepted |
| [0004](adr/0004-client-rendering-staged.md) | 描画は静的差分→将来アニメ/3D | accepted |
| [0005](adr/0005-access-control-oauth-stub.md) | アクセス制御は OAuth+RBAC、当面 stub | accepted |
| [0006](adr/0006-doc-language-i18n.md) | 日本語→ベータ前に全英訳 | accepted |

## 更新フロー

- 仕様変更 → `specs/<slug>.md` を編集、`status` を更新
- 仕様の曖昧点 → `open-questions/<slug>.md` を追加
- 重要な決定 → `adr/NNNN-<slug>.md` を作成、参照 spec を更新
- フェーズ進捗 → `plans/phase-N-<slug>.md` の表を更新
