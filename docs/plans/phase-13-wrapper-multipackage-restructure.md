---
title: Phase 13 — wrapper のマルチパッケージ構造 materialise
description: ADR-0017 の 3 層 pnpm workspace 化を実施し @kaoiro/wrapper を @kaoiro/claude-code にリネーム。既存 Claude 動作は完全維持。
status: done
phase: 13
depends_on: [phase-12-runner-persona-trust-mode]
last_updated: 2026-07-10
---

# Phase 13 — wrapper のマルチパッケージ構造 materialise

## Goal

[ADR-0017](../adr/0017-wrapper-multientity-packages.md) が Accepted (延期) で保留していた「wrapper を `core` + `agent-common` + `claude-code` + `codex` の 3 層 pnpm ワークスペース化」を、[ADR-0032](../adr/0032-codex-adapter.md) F1 に基づき materialise する。本 phase は物理境界の移動だけを行い、既存 Claude 動作を完全維持する (Codex 実装は次 phase で扱う)。

## Acceptance Criteria

- [x] `wrapper/core`、`wrapper/agent-common`、`wrapper/claude-code` の 3 パッケージへ分割 (`wrapper/codex` は本 phase では stub のみの scaffold)。workspace は repo root の `pnpm-workspace.yaml` に 4 パッケージを追加する形で実現 (pnpm workspace はネスト不可のため、計画時の「wrapper/pnpm-workspace.yaml 新設」から変更。`wrapper/package.json` は非メンバの fan-out shim として残置)。
- [x] 現 `@kaoiro/wrapper` は `@kaoiro/claude-code` にリネーム。既存の `wrapper/src/*` を分類・移送。
- [x] `wrapper/agent-common` に `EngineAdapter` interface を定義 (`AgentHost` の操作面を interface に昇格、`AgentHost implements EngineAdapter` で静的に担保)。
- [x] `wrapper/core` に transport / persona / config / CLI 引数解析 (engine 非依存部分) を移送。cli.ts 本体は AgentHost への配線 = engine 固有のため `claude-code` 側に残置 (engine 中立 CLI 枠の抽出は phase-14 の codex CLI 実装時に判断)。
- [x] 既存テスト (wrapper 全 263) が 100% パス (core 49 / agent-common 52 / claude-code 162 に分割)。
- [x] runner (`runner/src/spawn.ts`) の `require.resolve` を `@kaoiro/claude-code` に更新 (dist / dev tsx の両経路)、既存 spawn 経路の実挙動不変。runner 全 79 テストもパス。
- [x] dashboard / server / protocol package の変更ゼロ (完全外部から見て挙動不変)。
- [x] `wrapper/README.md` を新パッケージ構造 (3 層 + codex scaffold) の説明に更新。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 13-1 | 4 パッケージ scaffold (`core` / `agent-common` / `claude-code` / `codex`) | ✅ | pnpm workspace はネスト不可のため repo root の `pnpm-workspace.yaml` にメンバ追加 (計画時の「wrapper/pnpm-workspace.yaml 新設」から変更)。`wrapper/package.json` は fan-out shim 化 |
| 13-2 | `wrapper/core` へ transport / persona / config / CLI 引数解析を移送 | ✅ | 承認/質問の wire 型 (`PermissionDecisionMessage` / `QuestionResponseMessage`) も transport 側へ移設し core→agent-common の逆依存を解消。cli.ts 本体は engine 固有配線のため claude-code 残置 |
| 13-3 | `wrapper/agent-common` へ 状態機械 / permission broker / question broker / 共通イベント型 を移送 | ✅ | `PermissionDecision` / `QuestionDecision` を host.ts から broker 側へ移設 |
| 13-4 | `wrapper/agent-common` に `EngineAdapter` interface を定義 | ✅ | `engine.ts`。`AgentHost implements EngineAdapter` で静的担保 |
| 13-5 | `wrapper/agent-common` に共通 Tool 記述層 (JSON Schema + handler pair) の骨格を用意 | ✅ | `tooling.ts` (`ToolDescriptor` / `ToolResult`)。phase-14 で inter-agent tools を移送する土台 |
| 13-6 | `wrapper/claude-code` に Claude 固有実装を配置 | ✅ | host / adapter / upload / history / inter_agent / cli を移送。二軸 mapping table は `permission_axes.ts` に ADR-0033 F2 の値まで実装済み (envelope への配線は phase-14) |
| 13-7 | `wrapper/codex` package.json を scaffold | ✅ | `CodexHost implements EngineAdapter` の未実装 stub のみ |
| 13-8 | 既存 wrapper テスト 263 を新パッケージ境界に沿って分割・全通過 | ✅ | core 49 / agent-common 52 / claude-code 162 |
| 13-9 | `runner/src/spawn.ts` の解決先を `@kaoiro/claude-code` に更新 | ✅ | dist / dev (`KAOIRO_WRAPPER_DEV=1` tsx) 両経路 + `runner/package.json` の workspace 依存。runner 79 テストパス |
| 13-10 | `wrapper/README.md` を新パッケージ構造の説明に更新 | ✅ | 4 パッケージの責務と依存グラフ (Mermaid) |
| 13-11 | ADR-0017 の Status を materialised に更新、package 境界の詳細を注記 | ✅ | root workspace 化の逸脱も記録 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

なし (本 phase は境界移動のみ、実装追加はしない)。

## Open Questions Blocking This Phase

なし。本 phase は境界移動のみで、Q1-Q6 は全て phase-14 側の gate。

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md)、[architecture](../specs/architecture.md)
- 関連 ADR: [ADR-0017](../adr/0017-wrapper-multientity-packages.md) (materialise 対象)、[ADR-0023](../adr/0023-host-runner-architecture.md) D3 (`@kaoiro/wrapper` → `@kaoiro/claude-code` リネームを本 phase で実行)、[ADR-0032](../adr/0032-codex-adapter.md) F1 (本 phase の由来)
- Previous phase: [phase-12-runner-persona-trust-mode](phase-12-runner-persona-trust-mode.md)
- Next phase: [phase-14-codex-adapter](phase-14-codex-adapter.md)
