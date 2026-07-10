---
title: wrapper のマルチエンティティ・パッケージ構造(3層 pnpm ワークスペース)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [plugin-model, architecture]
related_adrs: [1, 18, 28, 32]
---

# ADR-0017 — wrapper のマルチエンティティ・パッケージ構造

## Status

Accepted (materialise: [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md), 2026-07-10 着手決定)。着手条件「主要機能が出揃ってから」は phase-12 完了時点で満たされ、[ADR-0032](0032-codex-adapter.md) F1 で Codex adapter 追加と合わせて materialise することが決まった。

## Context

現状 wrapper は単一パッケージ `@kaoiro/wrapper`。将来 Claude Code 以外
(Codex、さらに DB・ホストリソースモニタ等の**非 AI エンティティ**)を足したい。
最終目標は「多様なエンティティを遠隔管理し状態をキャラクターとして可視化」する
こと。[plugin-model](../specs/plugin-model.md) は既にアダプタ(エージェント別)/
フィルタ(agent 非依存)を分離しており、`wrapper/src/adapter.ts` でアダプタ抽象も
コード上存在する。本 ADR はこれを物理パッケージ構造へ落とす。

## Decision

`@kaoiro/wrapper` を **pnpm ワークスペースの複数パッケージ**へ再編し、**3層**に
分ける:

- `wrapper/core` — **エンティティ非依存**: transport / エンベロープ外枠+version /
  同一性・persona / 接続・状態報告ライフサイクル / config / CLI 枠。
- AI エージェント共通層(例 `wrapper/agent-common`)— 状態機械・permission・
  streaming 指示。claude-code/codex が共有。
- 具体アダプタ — `wrapper/claude-code`・`wrapper/codex`、将来
  `wrapper/<非 AI エンティティ>`(DB・ホストメトリクス等)。

アダプタはコアを `workspace:` 依存で取り込む。状態機械・permission・instruction は
AI 固有でありコアに混ぜない(非 AI エンティティが AI 概念を背負わないため)。

**着手タイミングは主要機能が出揃ってから**(2026-07-10 に着手条件充足を確認、[ADR-0032](0032-codex-adapter.md) F1 で phase-13 実施を決定)。

### 具体パッケージ境界 (2026-07-10 追記、[ADR-0032](0032-codex-adapter.md) F1)

materialise 時点の package 境界と responsibility:

- **`wrapper/core` (`@kaoiro/wrapper-core`)** — エンティティ非依存: transport / エンベロープ外枠+version / 同一性・persona / 接続・状態報告ライフサイクル / config / CLI 枠 (engine 非依存部分)。
- **`wrapper/agent-common` (`@kaoiro/agent-common`)** — AI エージェント共通層: 状態機械、`EngineAdapter` interface、共通 Tool 記述層 ([ADR-0032](0032-codex-adapter.md) F5)、permission broker、instruction 変換、共通イベント型。Claude / Codex が共有。
- **`wrapper/claude-code` (`@kaoiro/claude-code`)** — Claude Code CLI 具体アダプタ (現 `@kaoiro/wrapper` のリネーム、[ADR-0023](0023-host-runner-architecture.md) D3)。
- **`wrapper/codex` (`@kaoiro/codex`)** — Codex CLI 具体アダプタ (phase-14 で実装)。

## Consequences

### Positive

- 新エンティティ種別をアダプタ追加で足せる受け皿ができる。
- コア=エンティティ非依存が物理境界として担保され、広い狙い(非 AI 管理)へ拡張可。

### Negative

- ビルド/配布([ADR-0018](0018-runner-distribution.md))・import 経路の再編が要る。

### Neutral

- `wrapper/pnpm-workspace.yaml` が既にあり下地はある。
- サーバは元々「中身を解釈せず保持・配信」でエンティティ非依存に近い。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 単一パッケージのままフォルダ再編のみ | アダプタの独立ビルド・配布(ADR-0018)がしづらい |
| 2層(core + アダプタ)で AI 状態機械を core に置く | DB・モニタ等が AI 概念(状態機械/permission/instruction)を背負う |
| 今すぐ着手 | 低優先。主要機能を優先 |

## Related

- spec: [plugin-model](../specs/plugin-model.md)。
- 関連 ADR: [0001](0001-agent-sdk-integration.md)、配布は
  [0018](0018-runner-distribution.md)。
- 未解決: コア線引きの詳細・非 AI エンティティの状態語彙・パッケージ命名
  (実装時)。広い狙い(エンティティ全般の管理・可視化)は将来 vision /
  spec-elicitation で別途。
- 由来: my-idea-brief(走り書き「wrapper を claude-code/codex 等に分割」)。
