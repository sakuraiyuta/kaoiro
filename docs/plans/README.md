# Plans

フェーズは順に進める(スキップしない)。Status 列は各 plan の
frontmatter `status` を legend の記号へ写したもので、`done` でも
followup が issue へ外出しされている場合は 🟡 とする。

| Phase | File | Status | 説明 |
|-------|------|--------|------|
| 0 | [phase-0-project-setup](phase-0-project-setup.md) | ✅ | 企画・リポジトリ立ち上げ |
| 1 | [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md) | 🟡 | ラッパー1個 + 状態機械。`waiting_permission` の実駆動確認(1-5)のみ未達 |
| 1.5 | [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md) | ✅ | 最小サーバ + 最小クライアント(縦串) |
| 2 | [phase-2-client-character](phase-2-client-character.md) | ✅ | クライアント + キャラ + 表情 |
| 3 | [phase-3-server-multiagent](phase-3-server-multiagent.md) | ✅ | サーバ集約 + 複数 + 双方向 |
| 3.5 | [phase-3.5-response-display](phase-3.5-response-display.md) | 🟡 | 返答表示(同梱ダッシュボード実用化)。Stage ポリッシュ(R-5〜R-7、[issue #21](https://github.com/sakuraiyuta/kaoiro/issues/21))残 |
| 3.6 | [phase-3.6-dashboard-separation](phase-3.6-dashboard-separation.md) | ✅ | ダッシュボード別ディレクトリ化 + 同梱整理 |
| 4 | [phase-4-host-runner](phase-4-host-runner.md) | ✅ | ホスト常駐 runner(spawn/監督/ホスト登録、[ADR-0023](../adr/0023-host-runner-architecture.md))。配布(4-7)は単一バイナリを撤回し Node 前提の自己完結 tarball で完了([ADR-0018](../adr/0018-runner-distribution.md) 改訂)。release への資産アップロード自動化は [#140](https://github.com/sakuraiyuta/kaoiro/issues/140) |
| 5 | [phase-5-i18n](phase-5-i18n.md) | ⏳ | ベータ前 英訳工程 |
| 6 | [phase-6-emotion-filter](phase-6-emotion-filter.md) | ⏳ | 感情フィルタ(味付け)。当分の間塩漬け(2026-08-02 マスター判断) |
| 7 | [phase-7-file-upload](phase-7-file-upload.md) | ✅ | ファイルアップロード(添付の取り込み、[ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)) |
| 8 | [phase-8-inter-agent-messaging](phase-8-inter-agent-messaging.md) | ✅ | エージェント間メッセージング(複数 AI エージェントの協調対話、[issue #17](https://github.com/sakuraiyuta/kaoiro/issues/17) closed)。Stage C 残 / Stage D は [ADR-0044](../adr/0044-coordination-injection-hitl.md)・[#87](https://github.com/sakuraiyuta/kaoiro/issues/87)・[#18](https://github.com/sakuraiyuta/kaoiro/issues/18) へ引き継ぎ(2026-08-02 close) |
| 9 | [phase-9-external-human-messaging](phase-9-external-human-messaging.md) | ⏳ | 外部人間メッセージング(Discord、双方向 transport / 一方向 authority、[ADR-0028](../adr/0028-external-human-messaging.md)) |
| 10 | [phase-10-persona-server-sot](phase-10-persona-server-sot.md) | ✅ | ペルソナ server 集約 SoT + zip pack 配布、[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) |
| 11 | [phase-11-agent-directory-and-restore](phase-11-agent-directory-and-restore.md) | ✅ | サーバ再起動越しの agent identity 永続と client 明示復元(一括/個別)、[ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md)、[issue #41](https://github.com/sakuraiyuta/kaoiro/issues/41) |
| 12 | [phase-12-runner-persona-trust-mode](phase-12-runner-persona-trust-mode.md) | ✅ | runner の persona 受け入れ方針を allowlist / blocklist の 2 モードから選択(未設定は既定の accept-all)、[ADR-0031](../adr/0031-runner-persona-trust-mode.md) |
| 13 | [phase-13-wrapper-multipackage-restructure](phase-13-wrapper-multipackage-restructure.md) | ✅ | wrapper のマルチパッケージ構造 materialise (`core` + `agent-common` + `claude-code` + `codex` の 4 パッケージ)、[ADR-0017](../adr/0017-wrapper-multientity-packages.md) / [ADR-0032](../adr/0032-codex-adapter.md) F1 |
| 14 | [phase-14-codex-adapter](phase-14-codex-adapter.md) | ✅ | Codex アダプタ実装 (F2-F9、権限二軸 UI、engine セレクト、共通 Tool 記述層への inter-agent tool 移送)、[ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md) |
| 15 | [phase-15-wrapper-ux-parity](phase-15-wrapper-ux-parity.md) | ✅ | Claude / Codex の UX 非対称の解消(model 解決経路の対称化と `ext.model_source`、権限二軸 UI、session capabilities、resume 差分検出)、[ADR-0034](../adr/0034-session-capabilities-advertisement.md) |
| 16 | [phase-16-codex-model-switch](phase-16-codex-model-switch.md) | ✅ | Codex model catalog と session 継続のまま行う mid-session model/effort switch(pending → effective → rollback の 3 段)、[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) |
| 17 | [phase-17-session-lifecycle-commands](phase-17-session-lifecycle-commands.md) | ✅ | `/new`・`/clear` を第一級の session lifecycle command として扱う(四段 request_id 相関 + session_boundary marker)、[ADR-0036](../adr/0036-session-lifecycle-commands.md) |
| 18 | [phase-18-claude-model-catalog-live](phase-18-claude-model-catalog-live.md) | ✅ | Claude モデル catalog を SDK 実測へ一元化し launch bootstrap の default floor を縮小、[ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) |
| 19 | [phase-19-codex-internal-subagents-toggle](phase-19-codex-internal-subagents-toggle.md) | ✅ | Codex 内部サブエージェント toggle と固有名 peer-routing contract、[ADR-0038](../adr/0038-codex-internal-subagents-toggle.md) |
| 20 | [phase-20-engine-catalog-live-probe](phase-20-engine-catalog-live-probe.md) | ✅ | LaunchDialog モデル catalog を短命 SDK probe + runner memory cache で live 化 (Option E)、[ADR-0039](../adr/0039-engine-catalog-live-probe.md) |
| 21 | [phase-21-context-usage-capability](phase-21-context-usage-capability.md) | ✅ | context 使用量表示の capability 化と Codex 側 estimated 投影の撤回、[ADR-0040](../adr/0040-context-usage-capability.md) |
| 22 | [phase-22-resume-privilege-restoration](phase-22-resume-privilege-restoration.md) | ✅ | resume 時の privilege 三軸(sandbox / network_access / permission_mode)再適用 (P0)、[ADR-0014](../adr/0014-session-resume-and-restore.md) F1 追補 |
| 23 | [phase-23-resume-model-effort-restoration](phase-23-resume-model-effort-restoration.md) | 🟡 | resume 時の model / effort / `*_source` 再適用 (P1)。dogfood 手動検証(23-9)がマスター実機確認待ち |
| 24 | [phase-24-codex-auth-mode-explicit](phase-24-codex-auth-mode-explicit.md) | 🟡 | runner config で codex auth mode を明示宣言。dogfood 手動検証(24-7)がマスター実機確認待ち |
| 25 | [phase-25-fresh-restore-without-session](phase-25-fresh-restore-without-session.md) | ✅ | session_id を持たない offline agent を snapshot だけで復元する fresh-restore、[ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) D8 追補 |
| 26 | [phase-26-oauth-allowlist-login](phase-26-oauth-allowlist-login.md) | 🟡 | dashboard OAuth ログイン (Google/GitHub/Nextcloud) + テキスト許可リスト、token 認証は KAOIRO_CLIENT_TOKENS 設定時のみ併存、[ADR-0042](../adr/0042-oauth-allowlist-login.md) / [issue #65](https://github.com/sakuraiyuta/kaoiro/issues/65)。実装タスク 26-1〜26-12 は完了・push 済で、残るのはマスターによる provider 登録と実機 E2E。許可リストの role 降格が稼働中 socket に効かない件は [#148](https://github.com/sakuraiyuta/kaoiro/issues/148) |
| 27 | [phase-27-list-agents-metadata](phase-27-list-agents-metadata.md) | ✅ | `list_agents` に状況判断メタデータ 6 field (残 context / セッション開始 / turn 数 / 最終活動 / IA 対話状況 / rate_limits) を追加、[issue #150](https://github.com/sakuraiyuta/kaoiro/issues/150) / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6 (agent 間開示) |
| 28 | [phase-28-agent-initiated-session-ops](phase-28-agent-initiated-session-ops.md) | ✅ | コンテキスト疲労の自己認識と、agent 自身が turn 境界で要求する session reset / compact、[ADR-0043](../adr/0043-agent-initiated-session-reset.md) / [issue #158](https://github.com/sakuraiyuta/kaoiro/issues/158) |
| 29 | [P29](phase-29-footer-and-persona-cache.md) | 🟡 | footer / cache |
| | | | 実装完了、レビュー中 (ADR-0045 / ADR-0046) |
| 30 | [phase-30-history-restart-resilience](phase-30-history-restart-resilience.md) | ✅ | 表示履歴の再起動耐性 — hydration handshake・IA sidecar による DETS 撤廃・projection epoch 再同期、[ADR-0051](../adr/0051-history-restart-resilience.md)(accepted、rollout・dogfood 含め完了 2026-08-08) |
| 31 | [phase-31-responsive-ui](phase-31-responsive-ui.md) | ⏳ | dashboard の 3 サイズ対等レスポンシブ化 — breakpoint とシート機構の基盤、lobby / AgentDetail / 周辺 UI、[ADR-0052](../adr/0052-responsive-three-tier-layout.md) |
| 32 | [phase-32-subagent-workflow-visibility](phase-32-subagent-workflow-visibility.md) | 🟡 | 内部 subagent/workflow 稼働の可視化 — wrapper 検知・server 集約(operator 限定)・dashboard 頭上リング、[ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md) / [ADR-0047](../adr/0047-task-envelope-schema.md) / [ADR-0048](../adr/0048-task-aggregation-delivery.md) |
| | | | 実装完了、内部レビュー中(こはく確認・外部レビュー・commit/push 待ち) |

## Feature-local plans

ロードマップ番号を持たない feature-local plan。対象 feature の phase-0 /
phase-1 を plan 内の節として持つ(project の phase-N とは無関係)。

現在は登録なし(旧 `persona-personality-injection` は
[ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) で
supersede され、以降は [phase-10-persona-server-sot](phase-10-persona-server-sot.md)
に引き継がれた)。

## 将来

(旧: 「アダプタ拡張(Codex 等)」および「wrapper のマルチエンティティ・
パッケージ構造化」は 2026-07-10 に phase-13 / phase-14 として着手決定。
[ADR-0032](../adr/0032-codex-adapter.md) 参照。「wrapper/runner の配布」は
phase-4 の 4-7 として tarball 形態で決着した)

## Status legend

- ✅ done
- 🟡 mostly done, followups remaining
- ⚠ partial — important spec items missing
- ⏳ not started
- ⛔ blocked
