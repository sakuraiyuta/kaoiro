---
title: Phase 14 — Codex アダプタ実装
description: wrapper/codex に @openai/codex-sdk 対応の EngineAdapter を実装。権限二軸 envelope 拡張、engine セレクト UI、runner launcher の engine 解決、共通 Tool 記述層への inter-agent tool 移送を含む。
status: planned
phase: 14
depends_on: [phase-13-wrapper-multipackage-restructure]
last_updated: 2026-07-10
---

# Phase 14 — Codex アダプタ実装

## Goal

[ADR-0032](../adr/0032-codex-adapter.md) F2-F9 の実装 phase。`@openai/codex-sdk` 0.144.1 を wrap する `wrapper/codex` アダプタを完成させ、runner launcher の engine 解決、dashboard の engine セレクト、権限二軸 envelope 拡張、共通 Tool 記述層への inter-agent tool 移送、AskUserQuestion 自前 tool、resume の engine 分離、model/effort の engine 別 UI を通しで実装する。fuji / kuroe / ao / momo の代表 persona × 主要機能で Codex adapter が稼働する状態を目標とする。

## Acceptance Criteria

- [ ] `wrapper/codex` が `EngineAdapter` interface を実装し、`thread.run()` / `thread.runStreamed()` / `codex.resumeThread(id)` を通しで駆動できる。
- [ ] [ADR-0033](../adr/0033-permission-model-dual-axis.md) に基づく `state_change.ext.pending_permission` の二軸拡張 (`sandbox` / `approval` フィールド) が envelope に載る。Claude 4 mode → 二軸 mapping table が `wrapper/claude-code` に実装され、既存 Claude 挙動と後方互換 ([Q2](../open-questions/permission-dual-axis-envelope-schema.md) 解決)。
- [ ] LaunchDialog / AgentDetail の権限 UI が二軸表示になり、preset ショートカット ([Q3](../open-questions/permission-dual-axis-ui-vocabulary.md) 解決) が動作。
- [ ] 共通 Tool 記述層に inter-agent tools (`mcp__kaoiro__send_to_agent` / `list_agents` / `whoami`) が移送され、Claude / Codex 両方から呼び出せる (どちらの engine 上でも同じ振る舞い)。
- [ ] Codex 側の AskUserQuestion 相当 (`ask_user_question` 自前 tool) が動作し、operator へ質問が届く。Claude native 側の挙動に影響なし。
- [ ] `SpawnRequest` / `SpawnMessage` に `engine` フィールドが追加され、runner launcher が `engine → wrapper パッケージ (@kaoiro/claude-code | @kaoiro/codex)` を解決する。
- [ ] LaunchDialog の engine セレクトが有効化 (host の `capabilities` が 2 種以上のときのみ表示)。engine 選択 → model リスト → optional effort の三段選択が動作 ([Q5](../open-questions/codex-model-effort-catalog.md) 解決)。
- [ ] capabilities フィールドの値が `claude-code` / `codex` にリネーム完了。旧値 `claude` の互換窓ポリシー ([Q6](../open-questions/capabilities-legacy-value-window.md) 解決) が確定・実装。
- [ ] engine 別 session 列挙が動作: Claude adapter は既存 JSONL 列挙、Codex adapter は Codex thread 列挙 (実装方式は phase 内で確定)。
- [ ] fuji / kuroe / ao / momo の 4 persona 全てが Codex adapter 上でも動作し、口調・態度が Claude 版と同等に再現される ([Q1](../open-questions/codex-personality-injection-efficacy.md) 解決)。
- [ ] Codex adapter が起動する時点の cwd を `ext.cwd` に反映する (追跡は best-effort、[Q4](../open-questions/codex-cwd-extraction.md) は low で継続)。
- [ ] server / dashboard 側の regression テストが全通過。wrapper 全テストが通過。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 14-1 | `wrapper/codex` に `@openai/codex-sdk` 依存追加、`EngineAdapter` interface を実装するアダプタ本体を実装 | ⏳ | thread.run / runStreamed のイベント → 共通 AdapterEvent へ変換 |
| 14-2 | `codex-sdk-events.md` spec を参照し ThreadEvent → 共通 AdapterEvent の写像を確定 | ⏳ | spec を書きながら実装 |
| 14-3 | ADR-0033 に基づく envelope schema 拡張 (`state_change.ext.pending_permission.sandbox` / `.approval`) を `@kaoiro/protocol` に追加、Q2 解決 | ⏳ | 既存 `permission_mode` フィールドの deprecation プラン確定 |
| 14-4 | Claude 4 mode → 二軸 mapping table を `wrapper/claude-code` に実装 (`default` / `acceptEdits` / `bypassPermissions` / `plan` それぞれの sandbox / approval 対応) | ⏳ | phase-13 で作った mapping table プレースホルダに実装を入れる |
| 14-5 | Codex adapter の sandbox_mode / approval_policy を envelope に投影 | ⏳ | Codex 側は写像不要、二軸を直接載せる |
| 14-6 | 共通 Tool 記述層 (JSON Schema + handler pair) を完成、inter-agent tools を移送 | ⏳ | 現 `wrapper/src/inter_agent.ts` を `wrapper/agent-common` へ移し、Claude / Codex 両方が同じ handler を使う |
| 14-7 | Codex 側の `ask_user_question` 自前 tool を共通 Tool 記述層で提供、question_request envelope への正規化 | ⏳ | Claude native 側の挙動に影響なし |
| 14-8 | `SpawnRequest` / `SpawnMessage` に `engine` フィールド追加、`@kaoiro/protocol` の型更新 | ⏳ | server 側 `capabilities` 照合で検証 |
| 14-9 | runner launcher (`runner/src/spawn.ts`) を `engine → wrapper パッケージ` 解決に変更 | ⏳ | `KAOIRO_WRAPPER_DEV=1` パスも engine 分岐 |
| 14-10 | dashboard の LaunchDialog に engine セレクト追加 (capabilities が 2 種以上のときのみ) | ⏳ | 引き続き 1 種のときは現行 UX 維持 |
| 14-11 | dashboard の LaunchDialog を engine → model → optional effort の三段選択に再構成 | ⏳ | model / effort リストは engine adapter が返す |
| 14-12 | dashboard の権限 UI (LaunchDialog / AgentDetail) を二軸表示に更新、preset ショートカット (Q3) 実装 | ⏳ | Q3 の UI 語彙確定を先行 |
| 14-13 | capabilities フィールド値のリネーム (`claude` → `claude-code`)、旧値の互換窓ポリシー (Q6) 実装 | ⏳ | ADR-0031 の persona legacy 窓との足並みは Q6 で決定 |
| 14-14 | Codex 側の session 列挙・resume 実装 (`~/.codex/threads/` 列挙 or Codex API 経由、実装方式を確定) | ⏳ | 実装方式は task 内で確定 (ADR にはしない、実装コメントで記録) |
| 14-15 | Q1 検証: 4 persona × Codex adapter での口調・態度再現テスト | ⏳ | fuji / kuroe / ao / momo で実挙動を確認 |
| 14-16 | Codex 側 cwd 起動時反映 (追跡は best-effort、Q4 は継続) | ⏳ | 起動 cwd を `ext.cwd` に載せる最小実装 |
| 14-17 | protocol.md / plugin-model.md / architecture.md / personas.md への追補 (F3 明記など、docs/plans に紐付く仕様変更を反映) | ⏳ | phase 完了直前にまとめて |
| 14-18 | wrapper / server / dashboard / runner の全テスト通過確認 | ⏳ | regression が phase-13 と本 phase の 2 段階で健全性維持 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- [Q4 codex-cwd-extraction](../open-questions/codex-cwd-extraction.md) — cwd 変化追跡は best-effort として起動時反映のみで phase-14 完了とし、動的追跡は low urgency で継続。
- Codex 自身を MCP server 化するアプローチは本 phase では採らない (ADR-0032 F5)。将来必要になった時点で別 ADR。

## Open Questions Blocking This Phase

- [Q1 codex-personality-injection-efficacy](../open-questions/codex-personality-injection-efficacy.md) — phase-14 完了判定に含む (代表 persona × Codex 動作確認)
- [Q2 permission-dual-axis-envelope-schema](../open-questions/permission-dual-axis-envelope-schema.md) — phase-14 全体をブロック (envelope schema を先に確定)
- [Q3 permission-dual-axis-ui-vocabulary](../open-questions/permission-dual-axis-ui-vocabulary.md) — dashboard 部分のブロック
- [Q5 codex-model-effort-catalog](../open-questions/codex-model-effort-catalog.md) — dashboard 三段選択のブロック
- [Q6 capabilities-legacy-value-window](../open-questions/capabilities-legacy-value-window.md) — 実装コスト小、決めれば即実装可

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md)、[protocol](../specs/protocol.md)、[personas](../specs/personas.md)、[architecture](../specs/architecture.md)、[codex-sdk-events](../specs/codex-sdk-events.md) (新設)
- 関連 ADR: [ADR-0032](../adr/0032-codex-adapter.md) (本 phase の主 ADR)、[ADR-0033](../adr/0033-permission-model-dual-axis.md) (権限二軸)、[ADR-0027](../adr/0027-askuserquestion-envelope.md) (question envelope)、[ADR-0014](../adr/0014-session-resume-and-restore.md) (resume 分離)、[ADR-0031](../adr/0031-runner-persona-trust-mode.md) (互換窓のパターン)
- Previous phase: [phase-13-wrapper-multipackage-restructure](phase-13-wrapper-multipackage-restructure.md)
