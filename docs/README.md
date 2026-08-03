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
| # | Title | Status |
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
| [0030](adr/0030-agent-directory-and-explicit-restore.md) | サーバ再起動越しの agent identity 永続と client 明示復元(一括/個別) | accepted |
| [0031](adr/0031-runner-persona-trust-mode.md) | runner の persona 受け入れは allowlist/blacklist の 2 モードから選択 | accepted |
| [0032](adr/0032-codex-adapter.md) | Codex アダプタ追加と wrapper マルチパッケージ構造の materialise | accepted |
| [0033](adr/0033-permission-model-dual-axis.md) | 権限モデルの共通抽象を sandbox × approval の二軸へ拡張 | accepted |
| [0034](adr/0034-session-capabilities-advertisement.md) | セッション機能 (session capabilities) の envelope advertisement | accepted |
| [0035](adr/0035-codex-model-catalog-and-mid-session-switch.md) | Codex model catalog 復活と mid-session switch 契約 | accepted |
| [0036](adr/0036-session-lifecycle-commands.md) | /new・/clear を第一級 session lifecycle command として扱う | accepted |
| [0037](adr/0037-claude-model-catalog-live-refresh.md) | Claude モデル catalog live 経路の SDK 実測一元化と launch bootstrap の default floor 縮小 | accepted |
| [0038](adr/0038-codex-internal-subagents-toggle.md) | Codex internal sub-agent の runner toggle と固有名 peer-routing contract | accepted |
| [0039](adr/0039-engine-catalog-live-probe.md) | LaunchDialog モデル catalog を短命 SDK probe + runner memory cache で live 化する (Option E) | accepted |
| [0040](adr/0040-context-usage-capability.md) | context-window 使用量表示を capability driven にし Codex の estimated 投影は行わない | accepted |
| [0041](adr/0041-operator-measurement-schema.md) | operator permission latency と dashboard 表示条件の measurement schema | proposed |
| [0042](adr/0042-oauth-allowlist-login.md) | dashboard の OAuth 個人認証 (Google/GitHub/Nextcloud) + 許可リスト | accepted |
| [0043](adr/0043-agent-initiated-session-reset.md) | agent 自身が turn 境界で要求する session reset | accepted |
| [0044](adr/0044-coordination-injection-hitl.md) | 協調指針の共通フッター自動注入と都度指名 director 下の責務内自律 | accepted |
| [0045](adr/0045-footer-file-externalization.md) | 共通フッターの外部ファイル化 — system-footer.md と user-footer.md | accepted |
| [0046](adr/0046-persona-cache-relocation.md) | persona 取り込みディレクトリの extraction cache 外部化 | accepted |
| [0047](adr/0047-task-envelope-schema.md) | task envelope の正式名称と payload スキーマ | accepted |
| [0048](adr/0048-task-aggregation-delivery.md) | task の server 集約・進捗間引き・スナップショット | accepted |
| [0049](adr/0049-tasklist-on-task-envelope.md) | Tasklist (todo) を task envelope に相乗りさせる | accepted |
<!-- adr-index:end -->

再生成: `scripts/build-adr-index.sh docs` (skill `my-docs-restructure`)。マーカー間は手で書き換えない。

## 更新フロー

- 仕様変更 → `specs/<slug>.md` を編集、`status` を更新
- 仕様の曖昧点 → `open-questions/<slug>.md` を追加
- 重要な決定 → `adr/NNNN-<slug>.md` を作成、参照 spec を更新
- フェーズ進捗 → `plans/phase-N-<slug>.md` の表を更新
