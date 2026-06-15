---
title: プラグインモデル
description: エージェント別アダプタと付加処理フィルタの2拡張点、および両者を差し込む共通イベント境界。
status: accepted
related: [architecture, protocol]
---
<!-- markdownlint-disable MD033 -->

# プラグインモデル

## Purpose

2種類の拡張点(アダプタ/フィルタ)と、両者を差し込む共通イベント境界を定義
する。全体構成は [architecture](architecture.md)。

## Definition

### 2種類の拡張点 — 分けて設計する

| 拡張点 | 役割 | 性質 |
|---|---|---|
| **アダプタ(エージェント別)** | 起動・制御、ネイティブ出力 → 共通イベント翻訳・状態導出、指示の逆変換 | プロセスのライフサイクルとプロトコル変換を持つ専用 IF。Claude Code 版は Agent SDK 実装([ADR-0001](../adr/0001-agent-sdk-integration.md)) |
| **フィルタ(付加処理)** | 正規化済み共通イベントに property を足す(感情・コスト・危険検知) | agent-agnostic、順序付きパイプライン |

- 「将来 Codex 等に対応」は**アダプタ**として差し込む。
- フィルタは共通イベントだけを相手にするので、どのエージェントでも同じフィルタ列を
  使い回せる。
- この分離が「コア=エージェント非依存」を成立させる肝。
- 付加プロパティの実例: `ext.cost`(累計コスト USD、#8、result に付与)と
  `ext.model` / `ext.context` / `ext.rate_limits`(Claude Code 固有メトリクス、
  #16、state_change に付与)。いずれもフィルタ列が未実装のため現状は Claude Code
  アダプタが直接付与する(SDK が公開した時のみの best-effort)。`model`/`context`/
  `rate_limits` は cc 固有のため、汎用フィルタではなくアダプタ側に置くのが妥当。
  汎用化できる `cost` 等はフィルタ機構の導入時に agent-agnostic なフィルタへ移す。

### 共通イベント境界

アダプタとフィルタを差し込む境界そのものが、共通イベント・エンベロープ
([protocol](protocol.md))。

```
[Agent native] --(Adapter: SDK→共通)--> [共通イベント v0]
  --(Filter chain)--> [Server(状態保持)] --> [Client]
```

## Constraints

- MUST: フィルタは `payload` / `ext` だけを触り、外枠(`version`,`agent_id`,
  `ts`,`type`,`state`)に依存しすぎない。

## See Also

- 関連 specs: [architecture](architecture.md), [protocol](protocol.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md)
