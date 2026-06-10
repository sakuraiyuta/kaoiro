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
| 共通イベント・エンベロープ | 1 イベントを包む共通 JSON。共通メタデータ(宛名)で `payload`(中身)を包む封筒のメタファ。定義と階層は [protocol](protocol.md)「用語と階層」 |
| 外枠(フレームキー) | エンベロープ直下の固定キー集合(v0 固定)。[protocol](protocol.md) |
| payload | エンベロープ内の `type` ごとのイベント本体。Channels フレームの payload スロットとは別物([protocol](protocol.md)) |
| ext | フィルタが付加する拡張領域([protocol](protocol.md)) |
| Channels フレーム | トランスポート層の `[join_ref, ref, topic, event, payload]`。payload スロットにエンベロープ全体を格納([protocol](protocol.md)、[ADR-0009](../adr/0009-client-transport.md)) |
| ペルソナ(Persona) | エージェントに割り当てる固定の人格・立ち絵。安定 ID で永続([ADR-0003](../adr/0003-persona-identity-persistence.md)) |
| 状態(State) | idle/thinking/tool_running/waiting_permission/waiting_input/done/error/disconnected |

## See Also

- 関連 specs: [overview](overview.md), [architecture](architecture.md),
  [protocol](protocol.md)
