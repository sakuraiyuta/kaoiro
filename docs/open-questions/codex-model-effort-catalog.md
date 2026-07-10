---
title: Codex の初期 supportedModels / effortOptions カタログ
description: wrapper/codex の supportedModels() 返却リストと effortOptions() 形式。gpt-5.1-codex ほかの実在モデル ID、Codex SDK の動的取得可否、reasoning_effort の kaoiro 側 UI 表現を確定する。
status: open
urgency: medium
blocks: [phase-14-codex-adapter]
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0032](../adr/0032-codex-adapter.md) F4bc で `EngineCapability` interface に `supportedModels()` / `effortOptions?()` を定め、LaunchDialog は「engine → model → optional effort」の三段選択で構成することを決定。Codex 側の実装に入る前に、初期公開する model カタログと effort オプション形式を確定する必要がある。

背景の詳細は [ADR-0032](../adr/0032-codex-adapter.md) F4bc、[protocol](../specs/protocol.md) `ext.models` (Claude 側は SDK 動的取得で `ext.models` に前出しする既存機構がある)。

## 選択肢

### supportedModels() 実装方式

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| A | Codex SDK が返す動的リスト (init メッセージ / App Server の thread/start 応答から抽出) | model の追加・廃止に自動追従 | SDK の応答仕様確認が要 |
| B | wrapper/codex に静的リスト (`gpt-5.1-codex` 等をハードコード) | 実装最短 | model 追加のたびに wrapper 更新が要 |
| C | server 側の config で管理 (env or persona-packs 内 optional) | operator が制御可能 | 責務分離が薄まる (server と wrapper の役割重複) |

### effortOptions() 形式

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| E-A | `[{value: "low" \| "medium" \| "high"}, ...]` (reasoning_effort 相当そのまま) | Codex SDK と 1:1 | effort 非対応モデルの扱いを分岐が必要 |
| E-B | Claude の Fast mode と同じ ext.models の `effort_levels` に載せる | 既存 protocol と統一 | Codex 側は reasoning_effort、Claude 側は Fast mode で意味論が違うのを型で吸収する必要 |
| E-C | effortOptions() を optional (Codex 実装なし) にし、reasoning_effort は engine 独自の envelope フィールドに逃す | 分岐最小 | UI で effort を出す仕組みが engine 別に分岐 |

## 影響

phase-14 の dashboard 三段選択 (engine → model → optional effort) をブロックする。model リストが確定しないと LaunchDialog は engine 選択後の描画に進めない。

## 判断材料

- Codex SDK 0.144.1 の init メッセージ / App Server 応答が model リストを含むか (実 SDK 応答を確認)
- Codex CLI の `--model` フラグで受け付ける model ID の実集合 (`gpt-5.1-codex`、`gpt-5.1-codex-mini` 相当があるか)
- reasoning_effort の対応モデルと非対応モデル (Codex CLI ドキュメント / SDK 実装)
- Claude 側 `ext.models` / `ext.fast_mode` の schema (既存 protocol.md との整合)

## 暫定方針

phase-14 開始時に案 B (静的リスト) + E-B (`ext.models.effort_levels` に統合) で仮実装し、Codex SDK の動的取得が可能と判明した時点で案 A に切り替え。effort の意味論差 (reasoning_effort vs Fast mode) は wrapper/agent-common の共通型で「engine 内での相対深度」として吸収し、UI ラベルは engine 別に engine adapter が返す。

## 解決時のアクション

- [ ] 決定内容を [ADR-0032](../adr/0032-codex-adapter.md) F4bc に追記 (初期 model カタログ、effortOptions 形式、`ext.models` の意味論)
- [ ] [protocol](../specs/protocol.md) の `ext.models` / `ext.effort` 説明を engine 別 UI 表現前提に更新
- [ ] 本 open-question を close (削除)
