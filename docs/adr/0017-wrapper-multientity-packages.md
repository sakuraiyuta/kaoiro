---
title: wrapper のマルチエンティティ・パッケージ構造(3層 pnpm ワークスペース)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [plugin-model, architecture]
related_adrs: [1, 18]
---

# ADR-0017 — wrapper のマルチエンティティ・パッケージ構造

## Status

Accepted(着手は主要機能が出揃ってから — 延期)

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

**着手タイミングは主要機能が出揃ってから**(低優先・延期)。

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
