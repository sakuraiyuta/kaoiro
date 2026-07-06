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

<!-- adr-index:start -->
| # | 決定 | Status |
|---|-------|--------|
| [0001](adr/0001-agent-sdk-integration.md) | Claude Agent SDK を統合方式に採用 | accepted |
| [0002](adr/0002-local-wrapper-websocket-topology.md) | ラッパーはローカル動作、WebSocket で中央サーバへ集約 | accepted |
| [0003](adr/0003-persona-identity-persistence.md) | ペルソナ同一性の永続化 | accepted |
| [0004](adr/0004-client-rendering-staged.md) | 描画は静的差分から、将来アニメ/3D を選択制 | accepted |
| [0005](adr/0005-access-control-oauth-stub.md) | アクセス制御は OAuth + RBAC、プロトタイプは stub | accepted |
| [0006](adr/0006-doc-language-i18n.md) | ドキュメント・UI は日本語、ベータ前に全英訳 | accepted |
| [0007](adr/0007-client-separation-reference-dashboard.md) | クライアントは別プロジェクト分離、リファレンスダッシュボードを同梱 | accepted |
| [0008](adr/0008-persona-asset-distribution.md) | ペルソナアセットはサーバ管理、マニフェスト + content-addressed 配信 | superseded |
| [0009](adr/0009-client-transport.md) | クライアント接続は Phoenix Channels に一本化 | accepted |
| [0010](adr/0010-protocol-precisification.md) | エンベロープの type/payload は実証範囲のみ確定し、残りは予約名とする | accepted |
| [0011](adr/0011-phase3-reliability-and-auth.md) | Phase 3 の信頼性・認証規約(seq / permission 相関 / トークン) | accepted |
| [0012](adr/0012-response-display-and-dashboard-scope.md) | 返答表示と同梱ダッシュボードのスコープ改訂 | accepted |
| [0013](adr/0013-user-token-cookie-persistence.md) | ユーザトークンの httpOnly cookie 永続化(リロード耐性) | accepted |
| [0014](adr/0014-session-resume-and-restore.md) | セッション resume による wrapper 復帰・既存セッション召喚 | accepted |
| [0015](adr/0015-protocol-version-stamping.md) | 全通信への version 付与と不一致時の警告(ベストエフォート受理) | accepted |
| [0016](adr/0016-error-body-relay.md) | ラッパーエラー本文のクライアントへのリレー(result.error_message) | accepted |
| [0017](adr/0017-wrapper-multientity-packages.md) | wrapper のマルチエンティティ・パッケージ構造(3層 pnpm ワークスペース) | accepted |
| [0018](adr/0018-runner-distribution.md) | wrapper/runner の配布(OS 別単一バイナリ・CLI のみ・Gitea release) | accepted |
| [0019](adr/0019-subagent-workflow-entity-and-task-envelope.md) | subagent/workflow を親付き子エンティティとし専用 envelope type で通知 | accepted |
| [0020](adr/0020-dashboard-battery-included-client.md) | 同梱ダッシュボードを battery-included な最低限実用クライアントへ格上げ(新プロトコル面の追加を許容) | accepted |
| [0021](adr/0021-role-information-disclosure-policy.md) | viewer / operator ロールの情報公開ポリシ — allow-list 方式と envelope 別マトリクス | accepted |
| [0022](adr/0022-pending-permission-authoritative-source.md) | pending_permission の authoritative source を state_change.ext へ — permission_request envelope は初出通知に降格 | accepted |
| [0023](adr/0023-host-runner-architecture.md) | ホスト常駐 runner — supervisor 専任・1 process=1 agent・TS/Node 単一バイナリ | accepted |
| [0024](adr/0024-agent-instance-identity-and-spawn-auth.md) | エージェントのインスタンス同一性と spawn 認証 — persona=型 / agent_id=インスタンス、runner 一本化の発行型認証 | accepted |
| [0025](adr/0025-file-upload-wire-and-wrapper-rendering.md) | ファイルアップロードの wire と wrapper-internal レンダリング | accepted |
| [0026](adr/0026-persona-personality-injection.md) | 人格プロンプト注入 — SDK systemPrompt.append + wrapper 同梱 md | superseded |
| [0027](adr/0027-askuserquestion-envelope.md) | AskUserQuestion 用に専用 envelope(question_request / question_response)と状態 waiting_question を新設 | accepted |
| [0028](adr/0028-external-human-messaging.md) | 外部人間メッセージング — 人間を外部チャネルの participant 化・一方向 authority・discord-wrapper トポロジ | accepted |
| [0029](adr/0029-persona-server-sot-and-pack-distribution.md) | ペルソナは server 集約 SoT、zip pack で配布し auto-watch で反映 | accepted |
| [0030](adr/0030-agent-directory-and-explicit-restore.md) | サーバ再起動越しの agent identity 永続と client 明示復元(一括/個別) | proposed |
<!-- adr-index:end -->

再生成: `scripts/build-adr-index.sh --columns "# 決定 Status" docs` (skill `my-docs-restructure`)。マーカー間は手で書き換えない。

## 更新フロー

- 仕様変更 → `specs/<slug>.md` を編集、`status` を更新
- 仕様の曖昧点 → `open-questions/<slug>.md` を追加
- 重要な決定 → `adr/NNNN-<slug>.md` を作成、参照 spec を更新
- フェーズ進捗 → `plans/phase-N-<slug>.md` の表を更新
