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

- [x] SDK のメッセージ列から idle/thinking/tool_running/waiting_permission/
      waiting_input/done/error を導出できる(実走行で確認)
- [~] 権限待ちを `PreToolUse`/`canUseTool` で保留として捉えられる(配線・
      ユニット検証済。ヘッドレスでの ask 経路実駆動は follow-up)
- [x] ペルソナ・安定 ID をラッパー初期設定から読む
- [x] 状態が実動作に追従(テキスト/色の最小表示で確認)

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1-1 | Agent SDK の細部を公式 docs で確定 | ✅ | [agent-sdk-events](../specs/agent-sdk-events.md) に確定 |
| 1-2 | アダプタ(SDK メッセージ → 共通エンベロープ) | ✅ | `wrapper/src/adapter.ts`(`sdkMessageToEvents`)。実 SDK 型 → `AdapterEvent`。ユニットテスト済 |
| 1-3 | 状態機械の実装 | ✅ | `wrapper/src/state.ts`(`deriveStates`/`reduceStates`)。ユニットテスト済 |
| 1-4 | ペルソナ・安定 ID の設定読み込み | ✅ | `wrapper/src/persona.ts`(`loadConfig`/`parseConfig`)。ユニットテスト済 |
| 1-5 | SDK ホスト配線 + 実走行確認 | 🟡 | `wrapper/src/host.ts`(`query`/streaming/`interrupt`/`canUseTool`)+ `cli.ts`。実走行で状態が実動作に追従するのを確認。`waiting_permission` の実駆動のみ未達(下記) |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- **`waiting_permission` の実駆動**: ヘッドレス SDK では `canUseTool` の ask
  経路が自動起動せず、ツール許可は `allowedTools` で解決される(検証メモ:
  [agent-sdk-events](../specs/agent-sdk-events.md))。配線・ユニット検証は済。
  ask 経路の起動条件は要調査(my-trouble-shooter 候補)か、Phase 2/3 の承認 UI
  実装時に確定。

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
