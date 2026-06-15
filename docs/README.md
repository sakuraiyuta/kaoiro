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
| [0007](adr/0007-client-separation-reference-dashboard.md) | クライアント分離、リファレンスダッシュボード同梱 | accepted |
| [0008](adr/0008-persona-asset-distribution.md) | ペルソナアセットはサーバ管理・マニフェスト配信 | accepted |
| [0009](adr/0009-client-transport.md) | クライアント接続は Phoenix Channels に一本化 | accepted |
| [0010](adr/0010-protocol-precisification.md) | エンベロープ type/payload は実証範囲のみ確定 | accepted |
| [0011](adr/0011-phase3-reliability-and-auth.md) | Phase 3 の信頼性・認証規約(seq/permission/トークン) | accepted |
| [0012](adr/0012-response-display-and-dashboard-scope.md) | 返答表示と同梱ダッシュボードのスコープ改訂 | accepted |
| [0013](adr/0013-user-token-cookie-persistence.md) | ユーザトークンを httpOnly cookie で永続化 | accepted |
| [0014](adr/0014-session-resume-and-restore.md) | セッション resume で wrapper を復帰・召喚 | accepted |
| [0015](adr/0015-protocol-version-stamping.md) | 全通信へ version 付与・不一致は警告しつつ受理 | accepted |
| [0016](adr/0016-error-body-relay.md) | ラッパーエラー本文を result.error_message でリレー | accepted |

## 更新フロー

- 仕様変更 → `specs/<slug>.md` を編集、`status` を更新
- 仕様の曖昧点 → `open-questions/<slug>.md` を追加
- 重要な決定 → `adr/NNNN-<slug>.md` を作成、参照 spec を更新
- フェーズ進捗 → `plans/phase-N-<slug>.md` の表を更新
