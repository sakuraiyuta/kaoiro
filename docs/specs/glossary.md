---
title: 用語集
description: kaoiro のドメイン用語(ラッパー/サーバ/クライアント/アダプタ/フィルタ/ペルソナ/状態名)。
status: accepted
related: [overview, architecture, protocol]
---

# 用語集

## Purpose

kaoiro のドメイン用語を統一する。

## Definition

| 用語 | 意味 |
|---|---|
| ラッパー(Wrapper) | エージェント1個を起動・観測し共通イベントへ翻訳する TS プロセス。Agent SDK をホストする |
| サーバ(Server) | 複数ラッパーを集約し状態を保持・配信する Elixir/Phoenix |
| クライアント(Client) | 状態をキャラ+表情で可視化するフロントエンド。実装は別プロジェクト。本体同梱はリファレンス簡易ダッシュボードのみ([ADR-0007](../adr/0007-client-separation-reference-dashboard.md)) |
| アダプタ(Adapter) | エージェント別の起動・翻訳・状態導出プラグイン([plugin-model](plugin-model.md)) |
| フィルタ(Filter) | 共通イベントに property を足す付加処理プラグイン |
| 共通イベント・エンベロープ | ラッパー/サーバ/クライアント間の共通メッセージ形式([protocol](protocol.md)) |
| ペルソナ(Persona) | エージェントに割り当てる固定の人格・立ち絵。安定 ID で永続([ADR-0003](../adr/0003-persona-identity-persistence.md)) |
| 状態(State) | idle/thinking/tool_running/waiting_permission/waiting_input/done/error/disconnected |

## See Also

- 関連 specs: [overview](overview.md), [architecture](architecture.md),
  [protocol](protocol.md)
