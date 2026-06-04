---
title: Phase 1 — ラッパー1個 + 状態機械
description: TS ラッパーで Agent SDK をホストし、1 エージェントの状態を導出・検証する。
status: planned
phase: 1
depends_on: [phase-0-project-setup]
last_updated: 2026-06-04
---
<!-- last_updated reflects SDK 仕様確定の反映 -->

# Phase 1 — ラッパー1個 + 状態機械

## Goal

TypeScript ラッパーで Claude Agent SDK をホストし、Claude Code 1 個の状態を
[protocol](../specs/protocol.md) の状態機械へ確実に導出できることを検証する。

## Acceptance Criteria

- [ ] SDK のメッセージ列から idle/thinking/tool_running/waiting_permission/
      waiting_input/done/error を導出できる
- [ ] 権限待ちを `PreToolUse`/`canUseTool` で保留として捉えられる
- [ ] ペルソナ・安定 ID をラッパー初期設定から読む
- [ ] 状態が実動作に追従(テキスト/色の最小表示で確認)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1-1 | Agent SDK の細部を公式 docs で確定 | ✅ | [agent-sdk-events](../specs/agent-sdk-events.md) に確定 |
| 1-2 | アダプタ(SDK メッセージ → 共通エンベロープ) | ⏳ | |
| 1-3 | 状態機械の実装 | ⏳ | |
| 1-4 | ペルソナ・安定 ID の設定読み込み | ⏳ | |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

なし。

## Open Questions Blocking This Phase

- [protocol-precisification](../open-questions/protocol-precisification.md)

## See Also

- Specs: [protocol](../specs/protocol.md),
  [agent-sdk-events](../specs/agent-sdk-events.md),
  [architecture](../specs/architecture.md),
  [plugin-model](../specs/plugin-model.md)
- ADRs: [0001](../adr/0001-agent-sdk-integration.md),
  [0003](../adr/0003-persona-identity-persistence.md)
- Previous: [phase-0-project-setup](phase-0-project-setup.md)
