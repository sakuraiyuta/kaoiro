---
title: Phase 13 — wrapper のマルチパッケージ構造 materialise
description: ADR-0017 の 3 層 pnpm workspace 化を実施し @kaoiro/wrapper を @kaoiro/claude-code にリネーム。既存 Claude 動作は完全維持。
status: planned
phase: 13
depends_on: [phase-12-runner-persona-trust-mode]
last_updated: 2026-07-10
---

# Phase 13 — wrapper のマルチパッケージ構造 materialise

## Goal

[ADR-0017](../adr/0017-wrapper-multientity-packages.md) が Accepted (延期) で保留していた「wrapper を `core` + `agent-common` + `claude-code` + `codex` の 3 層 pnpm ワークスペース化」を、[ADR-0032](../adr/0032-codex-adapter.md) F1 に基づき materialise する。本 phase は物理境界の移動だけを行い、既存 Claude 動作を完全維持する (Codex 実装は次 phase で扱う)。

## Acceptance Criteria

- [ ] `wrapper/pnpm-workspace.yaml` を新設し、`wrapper/core`、`wrapper/agent-common`、`wrapper/claude-code` の 3 パッケージへ分割 (`wrapper/codex` は本 phase では空の scaffold だけ用意)。
- [ ] 現 `@kaoiro/wrapper` は `@kaoiro/claude-code` にリネーム。既存の `wrapper/src/*` を分類・移送。
- [ ] `wrapper/agent-common` に `EngineAdapter` interface を定義 (現 `wrapper/src/adapter.ts` の内容を interface に昇格)。
- [ ] `wrapper/core` に transport / envelope 外枠 / persona / config / CLI 枠 (engine 非依存部分) を移送。
- [ ] 既存テスト (wrapper 全 263) が 100% パス (test 配置も新パッケージ境界に合わせて分割)。
- [ ] runner (`runner/src/spawn.ts`) の `require.resolve("@kaoiro/wrapper/dist/cli.js")` を `@kaoiro/claude-code/dist/cli.js` に更新、既存 spawn 経路の実挙動不変。
- [ ] dashboard / server / protocol package の変更ゼロ (完全外部から見て挙動不変)。
- [ ] `wrapper/README.md` を新パッケージ構造 (3 層 + codex scaffold) の説明に更新。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 13-1 | `wrapper/pnpm-workspace.yaml` 新設と 4 パッケージ scaffold (`core` / `agent-common` / `claude-code` / `codex`) | ⏳ | `codex` は本 phase では空 |
| 13-2 | `wrapper/core` へ transport / envelope 外枠 / persona / config / CLI 枠を移送 | ⏳ | 現 `wrapper/src/transport.ts` / `wrapper/src/persona.ts` / `wrapper/src/cli.ts` の engine 非依存部分 |
| 13-3 | `wrapper/agent-common` へ 状態機械 / permission broker / question broker / instruction 変換 / 共通イベント型 を移送 | ⏳ | 現 `wrapper/src/state.ts` / `wrapper/src/permission.ts` / `wrapper/src/question.ts` |
| 13-4 | `wrapper/agent-common` に `EngineAdapter` interface を定義 | ⏳ | 現 `wrapper/src/adapter.ts` の内容を宣言的 interface に昇格 |
| 13-5 | `wrapper/agent-common` に共通 Tool 記述層 (JSON Schema + handler pair) の骨格を用意 | ⏳ | phase-14 で inter-agent tools を移送する土台 |
| 13-6 | `wrapper/claude-code` に Claude 固有実装 (`host.ts` の `query()` 配線、Claude 権限 mode 単軸 → 二軸 mapping table のプレースホルダ、CwdChanged hook、native AskUserQuestion 分岐、inter-agent tools の Claude 側配線) を配置 | ⏳ | 現 `wrapper/src/host.ts` / `wrapper/src/inter_agent.ts` を移送 |
| 13-7 | `wrapper/codex` package.json を scaffold (実装は空、`EngineAdapter` interface を satisfies する未実装 stub のみ) | ⏳ | phase-14 で実装 |
| 13-8 | 既存 wrapper テスト 263 を新パッケージ境界に沿って分割・全通過 | ⏳ | 主要テスト分割: `state.test.ts` / `permission.test.ts` は `agent-common`、`host.test.ts` は `claude-code` |
| 13-9 | `runner/src/spawn.ts` の `require.resolve("@kaoiro/wrapper/dist/cli.js")` を `@kaoiro/claude-code/dist/cli.js` に更新、既存 spawn 経路の実挙動不変 | ⏳ | dev mode の `KAOIRO_WRAPPER_DEV=1` パスも同時更新 |
| 13-10 | `wrapper/README.md` を新パッケージ構造の説明に更新 | ⏳ | 4 パッケージの責務と依存グラフ図 |
| 13-11 | ADR-0017 の Status を「Accepted (materialise: phase-13)」に更新、追記した package 境界の詳細を注記 | ⏳ | phase-14 の scope に触れずに materialise を宣言 |

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
