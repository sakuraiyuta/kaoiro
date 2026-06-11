---
title: disconnected エージェントの手動削除 — UI と仕様
description: 切断後に残留する disconnected エージェントを手動削除する UI・API の仕様設計。手動方針は決定済み。
status: open
urgency: low
blocks: []
opened: 2026-06-11
decided: null
---

## 背景

サーバはエージェント状態をメモリのみで保持し、wrapper 切断後も最後の
状態(`disconnected`)が残り続ける(2026-06-11 の実運用検証で顕在化 —
e2e のテストエージェントが offline のまま残留し、コンテナ再起動でしか
消えない)。掃除は**手動削除の方針で決定済み**(2026-06-11 ユーザ決定。
TTL 自動削除は採らない)。残る論点は具体的な UI・仕様。

## 選択肢(論点)

| 論点 | 案 |
|------|-----|
| 操作の場所 | (a) ダッシュボードの disconnected カードに削除ボタン / (b) HTTP API のみ(curl 運用) |
| 認可 | operator のみ(viewer 不可)— 指示・承認([protocol](../specs/protocol.md))と同等が自然 |
| プロトコル | client → server の新イベント `remove_agent` `{agent_id}`。削除の周知は snapshot 再 push か新イベント `agent_removed` か |
| 誤削除防止 | `disconnected` 状態のときのみ受理(接続中エージェントは拒否)が安全 |

## 影響

未決の間、残留エージェントはコンテナ再起動でしか消えず、検証・運用時に
ダッシュボードへ表示ノイズが溜まる(実害はノイズのみ)。

## 暫定方針

手動削除は決定済み。UI・仕様の詳細は着手時に確定(低優先)。

## 解決時のアクション

- [ ] 削除イベントと認可を [protocol](../specs/protocol.md) へ追補
- [ ] server / ダッシュボードの実装
- [ ] このファイルを削除
