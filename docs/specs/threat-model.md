---
title: 脅威モデル(双方向ルーティング)
description: クライアント → エージェントへの指示・承認がもたらす脅威と緩和策(issue #10)。
status: accepted
related: [protocol, architecture]
---

# 脅威モデル(双方向ルーティング)

## Purpose

Phase 3 の双方向ルーティング(指示・承認)は、**設計上、クライアント
からエージェント同居マシンでのツール実行を意味する**。本格運用・外部
公開前に脅威と緩和策を一筆残す(issue #10)。

## Definition

### 前提(入口の防御)

| レイヤ | 防御 | 出典 |
|---|---|---|
| 経路 | リバースプロキシ終端の TLS | 2026-06-11 決定 |
| ラッパー接続 | agent_id 別トークン | [ADR-0011](../adr/0011-phase3-reliability-and-auth.md) |
| クライアント接続 | ユーザトークン + role(指示・承認は operator のみ。token は httpOnly + 暗号化 cookie に保持) | 同上 / [ADR-0013](../adr/0013-user-token-cookie-persistence.md) |

### 脅威

1. **指示 = リモートツール実行**: operator トークンを得た攻撃者は、
   エージェントに任意の指示を送れる。エージェントの権限内で
   ファイル読み書き・コマンド実行が起こり得る(開発マシンへの侵入と
   同等の影響範囲)。
2. **承認の悪用**: 攻撃者が `permission_decision` を allow で返すと、
   本来人間が止めるはずだったツール実行が通る。
3. **tool input 経由の情報漏えい**: `permission_request` の `input` には
   コマンドライン・ファイルパス・環境値などシークレットが混入し得る。
   閲覧権限(viewer)にも配信されるため、トークン管理が緩いと漏れる。
4. **statusline メタ(`ext`)経由の情報漏えい**: state_change の `ext` に
   付く cwd(作業ディレクトリの絶対パス = ファイルシステム構成・プロジェクト
   名が露出)や model / context / rate_limits は、当初 catch-all で viewer にも
   素通ししていた(#16 由来)。cwd は特に機微(#46)。
5. **セッション resume/召喚 = リモート起動 + 履歴露出**: クライアントから
   サーバ経由で wrapper を resume 起動する経路は脅威1(リモートツール実行)の
   延長([ADR-0014](../adr/0014-session-resume-and-restore.md)、issue #22)。
   さらに候補提示で runner が返す JSONL のメタ(先頭プロンプト要約等)は会話
   断片の露出面となり、任意 session_id / 任意 cwd の resume 要求は他者の会話を
   読む/継続する経路にもなり得る。

### 緩和策

| 緩和策 | 状態 |
|---|---|
| 指示・承認を operator role に限定 | Phase 3 で実装 |
| `KAOIRO_CLIENT_TOKENS` 未設定時はクライアント接続を fail-closed(全拒否)— 誤設定で operator が無防備に公開される事故を防ぐ(起動時に警告ログ) | Phase 3.5([issue #28](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/28)) |
| `permission_request.input` のサイズ上限(16KB 切り詰め、`truncated` 明示) | Phase 3 で実装([protocol](protocol.md)) |
| ラッパー側の `allowedTools` 上限 — 指示が来ても実行可能なツールは ラッパー設定が天井(サーバ・クライアントからは拡張不可) | ラッパー設計で担保(canUseTool はサーバ側から上書き不可) |
| 指示の監査ログ(誰が・いつ・どの agent に何を送ったか) | 将来(SQLite 導入時) |
| tool input のマスキング(シークレットパターンの伏字) | 将来 |
| 返答ログ(`log`/`result`、tool 入出力含む)を operator 限定配信 | Phase 3.5([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)) |
| state_change の `ext`(cwd / model / context / rate_limits)を operator 限定配信(viewer には `ext` を除去) | #46 で実装 |
| ユーザトークンを httpOnly + 暗号化 session cookie に保持(XSS でも JS から読めず、cookie jar 上でも秘匿)。CSRF は SameSite=Lax + prod の `check_origin` で抑止 | Phase 3.5([ADR-0013](../adr/0013-user-token-cookie-persistence.md)) |
| OAuth + RBAC 本実装 | 将来([ADR-0005](../adr/0005-access-control-oauth-stub.md)) |
| セッション召喚時に runner が返す JSONL メタ(先頭プロンプト要約等)を operator role 限定・最小限に露出(T2、[ADR-0014](../adr/0014-session-resume-and-restore.md)) | 将来(resume 機能と同時) |
| resume 対象 session_id を当該 agent 束縛 cwd 配下に実在検証し、他 cwd/任意パスの resume を拒否(T3、runner が検証) | 将来(resume 機能と同時) |

## Constraints

- MUST: 指示・承認の受理は operator role のみ([protocol](protocol.md))。
- MUST: 返答ログ(`log`/`result`)の配信は operator role のみ
  ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md))。
- MUST: envelope の `ext`(statusline メタ: cwd / model / context /
  rate_limits / slash_commands)の配信は operator role のみ(#46。viewer には
  全 type で除去)。viewer ロールの情報公開範囲全体の定義は別途
  spec-elicitation([issue #46](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/46))。
- MUST: ラッパーはサーバから受けた指示で `allowedTools` /
  `canUseTool` の設定を変更しない(実行能力の天井はローカル設定)。
- MUST: resume 対象 session_id は当該 agent の束縛 cwd 配下に実在するものに
  限定する(他 cwd/任意パスの resume を拒否、
  [ADR-0014](../adr/0014-session-resume-and-restore.md))。
- MUST: セッション召喚時の JSONL メタ配信は operator role のみ。
- SHOULD: operator トークンは viewer と分け、配布範囲を最小にする。

## Open Questions

なし(監査ログ・マスキングは上表の通り将来項目)。

## See Also

- 関連 specs: [protocol](protocol.md), [architecture](architecture.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0005](../adr/0005-access-control-oauth-stub.md),
  [0011](../adr/0011-phase3-reliability-and-auth.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0014](../adr/0014-session-resume-and-restore.md)
