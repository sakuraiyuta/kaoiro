---
title: 権限モデルの共通抽象を sandbox × approval の二軸へ拡張
status: accepted
date: 2026-07-10
opened: 2026-07-10
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model]
related_adrs: [22, 32]
---

# ADR-0033 — 権限モデル共通抽象を sandbox × approval の二軸へ拡張

## Status

Accepted (実装は [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md))。詳細な envelope schema と写像 table は [open-questions/permission-dual-axis-envelope-schema](../open-questions/permission-dual-axis-envelope-schema.md) で確定させ、UI 語彙は [open-questions/permission-dual-axis-ui-vocabulary](../open-questions/permission-dual-axis-ui-vocabulary.md) で確定させる。

## Context

現状 wrapper / server / dashboard の権限モデル抽象は Claude Agent SDK の `permissionMode` (default/acceptEdits/bypassPermissions/plan/dontAsk/auto) を直接踏襲した単軸で、[protocol](../specs/protocol.md) の `ext.permission_mode` に露出、`ext.pending_permission` の authoritative source は [ADR-0022](0022-pending-permission-authoritative-source.md) で `state_change.ext` に確立された。

[ADR-0032](0032-codex-adapter.md) で Codex CLI アダプタを追加するにあたり、Codex の権限モデルが二軸である事実に共通抽象を合わせる必要がある:

- **sandbox_mode**: `read-only` | `workspace-write` | `danger-full-access` — file system への書き込み可否と範囲。
- **approval_policy**: `untrusted` | `on-request` | `granular` | `never` — 各操作 (shell / edit / net) について都度承認を求めるかの方針。

Claude は 4 mode の単軸で「shell も勝手にやってよいか」と「file edit を勝手にやってよいか」を区別できないため、二軸で表現するほうが表現力が広い。単軸プリセット (`default / accept-edits / yolo` 等) に潰すと Codex 二軸の表現力を失うため、共通抽象自体を二軸へ拡張する。

## Decision

### F1 — envelope schema の二軸拡張

`state_change.ext.pending_permission` を二軸表現へ拡張する。既存フィールドを維持しつつ以下を追加:

```json
{
  "type": "state_change",
  "state": "waiting_permission",
  "ext": {
    "pending_permission": {
      "request_id": "abc-123",
      "tool_name": "Bash",
      "input": { "command": "ls" },
      "ts": "2026-07-10T05:30:00Z",
      "sandbox": "workspace-write",
      "approval": "on-request"
    }
  }
}
```

`sandbox` / `approval` フィールドの列挙値、既存 `ext.permission_mode` フィールドの扱い (deprecation プランを含む)、Claude 4 mode → 二軸への完全写像 table は [open-questions/permission-dual-axis-envelope-schema](../open-questions/permission-dual-axis-envelope-schema.md) で確定させる (phase-14 の gate)。

### F2 — Claude 4 mode の二軸写像は wrapper/claude-code に閉じる

Claude Agent SDK の `permissionMode` 4 値 → 二軸への写像は `wrapper/claude-code` アダプタ内に写像 table として持つ。SDK 出力を wrapper で正規化してから envelope へ載せることで、server と dashboard は engine 語彙を意識せず二軸だけ扱えばよい。

### F3 — Codex は二軸を直接使う

`wrapper/codex` アダプタは Codex SDK の `sandbox_mode` / `approval_policy` をそのまま envelope に投影する。

### F4 — dashboard UI も二軸を表示

LaunchDialog および AgentDetail の権限 UI を「sandbox セレクト × approval セレクト」の二軸表現に更新する。両軸の operator 向けラベル、初期値 preset (「default / dev-friendly / yolo」のような時短ショートカット案) の命名は [open-questions/permission-dual-axis-ui-vocabulary](../open-questions/permission-dual-axis-ui-vocabulary.md) で確定させる。

### F5 — ADR-0022 との関係

[ADR-0022](0022-pending-permission-authoritative-source.md) の「`state_change.ext.pending_permission` が authoritative source」原則は本 ADR で維持する。本 ADR はその payload 形状に `sandbox` / `approval` を追加する追補で、ADR-0022 を supersede しない。

## Consequences

### Positive

- Codex 二軸の表現力を失わず、Claude / Codex の権限概念を単一の envelope schema で表現できる。
- dashboard の権限 UI が engine 分岐なしに一本化 (二軸表示だけを実装すればよい)。
- 「shell だけ勝手にやってよい / file edit だけ勝手にやってよい」といった細かい operator 意図を Claude 側でも表現できる (Claude native 側は 4 mode の粒度なので写像で丸まるが、少なくとも envelope 上は分離される)。

### Negative

- 既存 `ext.permission_mode` フィールドの deprecation プランが要る (dashboard 依存箇所、Q2 で確定)。
- Claude 4 mode → 二軸 mapping table の意味論確定にレビューが要る (Q2)。
- UI 語彙の operator 認知負荷 (二軸表示は単軸より複雑) — preset ショートカットで緩和する (Q3)。

### Neutral

- `permission_request` envelope の役割 (ADR-0022 F2 で初出通知に降格済) は本 ADR で変わらない。二軸フィールドは envelope 内にも同期する。
- viewer 配信は ADR-0021 の allow-list で自動カバー (ext は viewer 完全除去)。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| 行為プリセット共通抽象 (`default / accept-edits / auto-shell / plan-only / yolo`) を単軸で維持 | Codex 二軸の表現力を単軸に潰し、意味論マッピング table が結局 open-question の巣になる。preset 命名合意コストも大 |
| engine 別語彙をそのまま UI に露出 (Claude 4 mode 側と Codex 二軸を並置) | dashboard の permission 表示が engine ごとに違う集合になり、envelope schema / server validation が engine 分岐だらけ |
| Codex 側を単軸に丸めて既存 `permissionMode` schema を据置き | Codex 二軸の表現力を失い、operator が「file edit だけ勝手にやってよい」が Codex 側で表現できなくなる |

## Related

- 追補元: [ADR-0022](0022-pending-permission-authoritative-source.md) (authoritative source 原則を維持しつつ payload 拡張)。
- 由来: [ADR-0032](0032-codex-adapter.md) F2 (Codex adapter 追加に伴う権限抽象の拡張)。
- 実装: [phase-14-codex-adapter](../plans/phase-14-codex-adapter.md)。
- Open questions: [Q2 permission-dual-axis-envelope-schema](../open-questions/permission-dual-axis-envelope-schema.md)、[Q3 permission-dual-axis-ui-vocabulary](../open-questions/permission-dual-axis-ui-vocabulary.md)。
- 関連 specs: [protocol](../specs/protocol.md) (`ext.pending_permission` 追補)、[plugin-model](../specs/plugin-model.md)。
