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
| クライアント接続 | ユーザトークン + role(指示・承認は operator のみ) | 同上 |

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

### 緩和策

| 緩和策 | 状態 |
|---|---|
| 指示・承認を operator role に限定 | Phase 3 で実装 |
| `permission_request.input` のサイズ上限(16KB 切り詰め、`truncated` 明示) | Phase 3 で実装([protocol](protocol.md)) |
| ラッパー側の `allowedTools` 上限 — 指示が来ても実行可能なツールは ラッパー設定が天井(サーバ・クライアントからは拡張不可) | ラッパー設計で担保(canUseTool はサーバ側から上書き不可) |
| 指示の監査ログ(誰が・いつ・どの agent に何を送ったか) | 将来(SQLite 導入時) |
| tool input のマスキング(シークレットパターンの伏字) | 将来 |
| 返答ログ(`log`/`result`、tool 入出力含む)を operator 限定配信 | Phase 3.5([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)) |
| OAuth + RBAC 本実装 | 将来([ADR-0005](../adr/0005-access-control-oauth-stub.md)) |

## Constraints

- MUST: 指示・承認の受理は operator role のみ([protocol](protocol.md))。
- MUST: 返答ログ(`log`/`result`)の配信は operator role のみ
  ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md))。
- MUST: ラッパーはサーバから受けた指示で `allowedTools` /
  `canUseTool` の設定を変更しない(実行能力の天井はローカル設定)。
- SHOULD: operator トークンは viewer と分け、配布範囲を最小にする。

## Open Questions

なし(監査ログ・マスキングは上表の通り将来項目)。

## See Also

- 関連 specs: [protocol](protocol.md), [architecture](architecture.md)
- ADRs: [0002](../adr/0002-local-wrapper-websocket-topology.md),
  [0005](../adr/0005-access-control-oauth-stub.md),
  [0011](../adr/0011-phase3-reliability-and-auth.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md)
