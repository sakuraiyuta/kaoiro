---
title: 権限二軸拡張の envelope schema 詳細と Claude 4 mode 写像 table
description: state_change.ext.pending_permission の sandbox/approval フィールド形状、Claude 4 mode → 二軸の完全写像、既存 permission_mode の deprecation プラン。phase-14 全体をブロック。
status: open
urgency: high
blocks: [phase-14-codex-adapter]
opened: 2026-07-10
decided: null
---

## 背景

[ADR-0033](../adr/0033-permission-model-dual-axis.md) で権限モデル共通抽象を sandbox × approval の二軸に拡張することを決定。実装フェーズに入る前に、次の 3 点を確定させる必要がある:

1. `state_change.ext.pending_permission` に追加する `sandbox` / `approval` フィールドの列挙値 (Codex の sandbox_mode / approval_policy そのまま踏襲するのか、kaoiro 側で別語彙に写像するのか)
2. Claude Agent SDK の `permissionMode` 4 値 (`default` / `acceptEdits` / `bypassPermissions` / `plan`) を二軸へ写像する完全 table
3. 既存 `ext.permission_mode` フィールドの deprecation プラン (dashboard / 他 client への周知手順、互換窓の長さ)

背景の詳細は [protocol](../specs/protocol.md) `ext` 節、[ADR-0022](../adr/0022-pending-permission-authoritative-source.md) F1、[ADR-0033](../adr/0033-permission-model-dual-axis.md) F1。

## 選択肢

### sandbox / approval フィールドの列挙値

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| S-A | Codex 語彙そのまま (`read-only` / `workspace-write` / `danger-full-access`, `untrusted` / `on-request` / `granular` / `never`) | Codex SDK と 1:1、写像レイヤなし | kaoiro 独自の意味論を持ち込みにくい (将来別 engine 追加時に再考) |
| S-B | kaoiro 別語彙 (`read` / `write` / `full`, `always` / `on-write` / `on-shell` / `never` 等) | 抽象度が engine 中立、UI ラベルもすっきり | Codex 語彙との写像 table が必要、operator が知る意味論が二重化 |

### Claude 4 mode → 二軸写像

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| C-A | `default` → workspace-write × on-request、`acceptEdits` → workspace-write × granular (edit only auto)、`bypassPermissions` → danger-full-access × never、`plan` → read-only × on-request | 意図の近似が素直 | acceptEdits の「edit only auto」を granular で表現するのは Codex 側の granular 意味論との整合を要検証 |
| C-B | `default` → workspace-write × on-request、`acceptEdits` → workspace-write × on-request-except-edits (別途フィールド追加)、`bypassPermissions` → danger-full-access × never、`plan` → read-only × on-request | 忠実 | フィールド追加で schema が肥大 |

### permission_mode deprecation

| 案 | 内容 | メリット | デメリット |
|----|------|----------|-----------|
| D-A | 1 リリース窓で並置 → 削除 (ADR-0031 の personas フィールド流儀) | 実績のあるパターン | dashboard 実装は両フィールドを扱う期間が発生 |
| D-B | 即座に削除、二軸のみ | 実装ワンショット | 外部 dashboard クライアントがあれば破壊的 |

## 影響

phase-14 全体をブロックする。envelope schema と Claude 側写像は wrapper / server / dashboard が同じ意味論で動く前提であり、実装開始前に確定する必要がある。

## 判断材料

- Codex SDK 0.144.1 の sandbox_mode / approval_policy の実挙動 (granular の粒度、on-request と granular の差)
- Claude Agent SDK の acceptEdits の実挙動 (edit のみ auto-approve か、shell も含むか)
- 現状 dashboard の `ext.permission_mode` 依存箇所 (grep で列挙)
- 外部 dashboard クライアントの存否 (現状 kaoiro 内蔵のみか)

## 暫定方針

phase-14 開始時に S-A (Codex 語彙そのまま) + C-A (素直な写像) + D-A (1 リリース窓) を仮採用し、実装過程で不整合が出た時点で C-B / D-B に振り替える。詳細写像 table は [ADR-0033](../adr/0033-permission-model-dual-axis.md) の追補として本 open-question 解決時に本文に取り込む。

## 解決時のアクション

- [ ] 決定内容を [ADR-0033](../adr/0033-permission-model-dual-axis.md) の Decision F1 に追記 (envelope schema 完全形と Claude 4 mode 写像 table)
- [ ] [protocol](../specs/protocol.md) `ext.pending_permission` の説明を二軸拡張後の形に更新
- [ ] 本 open-question を close (削除)
