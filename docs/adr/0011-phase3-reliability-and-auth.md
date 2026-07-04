---
title: Phase 3 の信頼性・認証規約(seq / permission 相関 / トークン)
status: accepted
date: 2026-06-11
opened: 2026-06-11
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [2, 5, 10, 12, 13, 14, 21, 22, 24, 27]
---

# ADR-0011 — Phase 3 の信頼性・認証規約(seq / permission 相関 / トークン)

## Status

Accepted

## Context

Phase 3(双方向ルーティング・複数エージェント)の着手にあたり、
protocol-reliability open-question(issue #4 由来。2 項目を本 ADR へ昇格し
元ファイルは削除)の 2 項目(seq/イベント ID、permission_request の相関 ID
とタイムアウト既定)と、
ラッパー認証([ADR-0002](0002-local-wrapper-websocket-topology.md))・
ユーザアクセス制御 stub([ADR-0005](0005-access-control-oauth-stub.md))の
具体方式を確定する必要があった(2026-06-11 ユーザ決定)。

## Decision

1. **seq を導入する**: ラッパーはエンベロープ外枠キー `seq`(プロセス
   起動ごと 1 起点の単調増分整数)を全エンベロープに付与する。順序・
   重複の整列キーは `(agent_id, seq)` + `ts`。**サーバの最新状態判定は
   受信順(last-write-wins)を維持**する — ラッパー再起動で seq が
   巻き戻るため、上書き判定には使わない。version は "0" のまま
   (前方互換キー追加)。
2. **permission_request は相関 ID で突合する**: 要求 payload に
   `request_id`(ラッパー生成、セッション内一意)を持たせ、応答
   `permission_decision` が同じ `request_id` を返す。**無応答時の既定は
   SDK と同じく無制限待機**(応答受信まで Promise 保留、
   [ADR-0022](0022-pending-permission-authoritative-source.md) で旧 600 秒
   既定から移行)。有限タイムアウトはラッパー設定で opt-in 可、その場合は
   fail-closed deny。deny 時もセッションは継続する。pending 中の状態の
   真実は `state_change.ext.pending_permission` に持続付与される
   ([ADR-0022](0022-pending-permission-authoritative-source.md))。
3. **ラッパー認証は agent_id 別トークン**: サーバ設定に
   `agent_id:token` の組を列挙(env)。接続時にラッパーが提示し、
   不一致は接続拒否。SQLite は導入しない(2026-06-11 の後送方針)。
4. **ユーザアクセス制御 stub はユーザトークン + role**: サーバ設定に
   `token:role` を列挙(env)。role は `viewer`(閲覧のみ)/
   `operator`(指示・承認可)の 2 段階。ADR-0005 の「メール
   ホワイトリスト」は OAuth 導入時に紐付ける(トークンが当面の識別子)。

## Consequences

### Positive

- 監査ログ・リプレイへの布石(seq)を持ちつつ、表示経路の単純さ
  (受信順 last-write-wins)は変わらない。
- 承認フローが request_id 突合で正しく相関する(無応答時の挙動は
  [ADR-0022](0022-pending-permission-authoritative-source.md) で SDK
  デフォルト = 無制限待機へ移行済み)。
- 双方向(リモートのツール実行を意味する)の入口に実効的な歯止め
  (operator role)が入る。

### Negative

- トークン管理(wrapper 台数分 + ユーザ数分)が env 設定に増える。
- OAuth 移行時にユーザトークン → アカウントの紐付け直しが要る。

### Neutral

- RBAC の本実装(ADR-0005 本線)は引き続き将来。
- seq の消費者(重複排除・監査)は将来フェーズで実装する。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| seq なし(last-write-wins のみ) | 将来の監査・リプレイで困る(ユーザ判断で導入) |
| permission タイムアウトなし | 離席時にエージェントが無期限停止 |
| 共有 wrapper トークン 1 本 | 漏洩時全台交換、ADR-0002 の含意(ラッパーごと)を緩める |
| メール自己申告 whitelist | 検証不能で双方向の歯止めにならない |
