---
title: ペルソナ同一性の永続化
status: accepted
date: 2026-06-04
opened: 2026-06-04
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [4, 8, 24, 26, 29]
---

# ADR-0003 — ペルソナ同一性の永続化

## Status

Accepted

## Context

複数エージェントを並行運用しても、再起動をまたいでキャラの同一性・機嫌を維持
したい(マスト要件)。実行時生成の揮発 ID では再起動で同一性が失われ、愛着が
育たない。

## Decision

- `agent_id` は**設定で固定する安定 ID**(実行時生成の揮発 ID は使わない)。
- `persona`(id / 表示名 / 立ち絵セット)はラッパー初期設定で指定。
- **どのホスト/プロセスのエージェントがどのペルソナを担当するかはユーザが指定**。
- サーバ/クライアントは `agent_id`(+ `persona.id`)をキーに表示・機嫌を持続。

## Consequences

### Positive

- 再起動・複数運用をまたいで永続的な同一性と愛着。
- 識別が容易で、どの担当がどのキャラか一目で分かる。

### Negative

- ペルソナ定義のスキーマ・立ち絵セット参照方式の管理が必要。
- 描画種別(静的差分/アニメ/3D)は
  [ADR-0004](0004-client-rendering-staged.md) と連動。

### Neutral

- ペルソナはラッパー側設定なので、サーバは agent 非依存のまま。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 実行時生成 ID | 再起動で同一性喪失、機嫌の持続ができない |
| サーバ側で動的割り当て | ユーザが担当を指定できず、運用が直感に反する |
