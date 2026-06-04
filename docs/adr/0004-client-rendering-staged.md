---
title: 描画は静的差分から、将来アニメ/3D を選択制
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [architecture]
related_adrs: [3]
---

# ADR-0004 — 描画は静的差分から、将来アニメ/3D を選択制

## Status

Accepted

## Context

クライアントのキャラ描画技術をどこまで作り込むかが問題だった。Live2D 的な
アニメや 3D は表現力が高いが、コストが大きく OSS 代替の調査も未了。プロトタイプ
段階では実装速度を優先したい。

## Decision

- プロトタイプは**静的な表情差分の切り替え**で実装する。
- 将来、Live2D 的 2D アニメーションの **OSS 代替**や **3D モデルキャラ**の実装
  可能性を調査・検討し、技術的に可能なら**ペルソナごとに「静的差分/アニメ/3D」を
  選択可能**にする。

## Consequences

### Positive

- 早期に実装可能。表情差分素材は手持ちの ComfyUI で量産できる。

### Negative

- 将来の描画種別追加に備え、`persona` に描画種別を持たせる必要がある
  ([ADR-0003](0003-persona-identity-persistence.md))。

### Neutral

- 描画種別の選択はペルソナ単位なので、段階的に拡張できる。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 最初から Live2D/3D | コスト過大、OSS 代替・3D 手段の調査が未了 |
| 静的差分のみで固定 | 将来の表現拡張余地を塞ぐ |
