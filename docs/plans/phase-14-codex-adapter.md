---
title: Phase 14 — Codex アダプタ実装
description: wrapper/codex に @openai/codex-sdk 対応の EngineAdapter を実装。権限二軸 envelope 拡張、engine セレクト UI、runner launcher の engine 解決、共通 Tool 記述層への inter-agent tool 移送を含む。
status: done
phase: 14
depends_on: [phase-13-wrapper-multipackage-restructure]
last_updated: 2026-07-11
---

# Phase 14 — Codex アダプタ実装

## Goal

[ADR-0032](../adr/0032-codex-adapter.md) F2-F9 の実装 phase。`@openai/codex-sdk` 0.144.1 を wrap する `wrapper/codex` アダプタを完成させ、runner launcher の engine 解決、dashboard の engine セレクト、権限二軸 envelope 拡張、共通 Tool 記述層への inter-agent tool 移送、AskUserQuestion 自前 tool、resume の engine 分離、model/effort の engine 別 UI を通しで実装する。fuji / kuroe / ao / momo の代表 persona × 主要機能で Codex adapter が稼働する状態を目標とする。

## Acceptance Criteria

(2026-07-10 改訂: 旧 Q2/Q3/Q5/Q6 は実 SDK 検証 + spec-elicitation で解決済み。決定は [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md) / [codex-sdk-events](../specs/codex-sdk-events.md) に反映済みで、本 criteria はそれを前提とする。)

- [x] `wrapper/codex` が `EngineAdapter` interface を実装し、`thread.runStreamed()` / `codex.resumeThread(id)` を通しで駆動できる (毎ターン `codex exec` spawn の process モデル)。
- [x] [ADR-0033](../adr/0033-permission-model-dual-axis.md) F1 の agent-level `ext.permission = {sandbox, approval}` が envelope に載る。Claude 6 mode → 二軸 mapping table (F2) が `wrapper/claude-code` に実装され、`ext.permission_mode` は 1 リリース窓並置で後方互換。
- [x] dashboard の権限表示 (AgentCard / AgentDetail) が `ext.permission` 由来の二軸バッジになり、操作 UI は engine-native (Claude = mode セレクト、Codex = sandbox セレクト + network toggle、二軸換算ラベル併記。ADR-0033 F4)。
- [x] 共通 Tool 記述層に inter-agent tools (`mcp__kaoiro__send_to_agent` / `list_agents` / `whoami`) が移送され、Claude (in-process MCP) / Codex (同梱 MCP bridge、ADR-0032 F5) 両方から呼び出せる。
- [x] Codex 側の AskUserQuestion 相当 (`ask_user_question`、MCP bridge 経由) が動作し、operator へ質問が届き `waiting_question` が成立する。Claude native 側の挙動に影響なし。
- [x] `SpawnRequest` / `SpawnMessage` に `engine` フィールドが追加され、runner launcher が `engine → wrapper パッケージ (@kaoiro/claude-code | @kaoiro/codex)` を解決する。
- [x] LaunchDialog の engine セレクトが有効化 (host の `capabilities` が 2 種以上のときのみ表示)。engine 選択 → model リスト → optional effort の三段選択が動作 (Codex は model カタログ空 = アカウント既定 model 使用、2026-07-11 実機検証、[ADR-0032](../adr/0032-codex-adapter.md) F4bc)。
- [x] capabilities フィールドの値が `claude-code` / `codex` にリネーム完了。旧値 `claude` は 1 リリース窓のサイレント正規化 + deprecation warn (ADR-0032 F4a)。
- [x] engine 別 session 列挙が動作: Claude adapter は既存 JSONL 列挙、Codex adapter は `~/.codex/sessions/**/rollout-*.jsonl` の `session_meta.cwd` 照合 (ADR-0032 F8)。
- [x] persona が Codex adapter 上でも動作し、口調・態度が Claude 版と同等に再現される (旧 Q1 解決、2026-07-11 実機検証)。代表として対照的な 2 persona を live 確認: kuroe (「マスター」呼び・秘書口調) / ao (一人称「わたし」・常体・簡潔)。注入は `developer_instructions` で全 persona 共通経路のため fuji / momo も同機序。built-in `personality` config の干渉なし。
- [x] Codex adapter が起動する時点の cwd を `ext.cwd` に反映する (追跡は best-effort、[Q4](../open-questions/codex-cwd-extraction.md) は low で継続)。
- [x] server / dashboard 側の regression テストが全通過。wrapper 全テストが通過。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 14-1 | `wrapper/codex` に `@openai/codex-sdk` 依存追加、`EngineAdapter` interface を実装するアダプタ本体を実装 | ✅ | runStreamed のイベント → 共通 AdapterEvent へ変換。毎ターン exec spawn の process モデル ([codex-sdk-events](../specs/codex-sdk-events.md)) |
| 14-2 | ThreadEvent → 共通 AdapterEvent の写像を実ターンで検証し `codex-sdk-events.md` を accepted へ昇格 | ✅ | spec は 2026-07-10 に実型ベースへ更新済み。認証後の実ターン確認が残 |
| 14-3 | ADR-0033 F1 の `ext.permission = {sandbox, approval}` を `@kaoiro/protocol` に追加 | ✅ | `permission_mode` は 1 リリース窓並置 (D-A) |
| 14-4 | Claude 6 mode → 二軸 mapping table を `wrapper/claude-code` に実装 (ADR-0033 F2 の表) | ✅ | phase-13 で作った mapping table プレースホルダに実装を入れる |
| 14-5 | Codex adapter の spawn 時 sandbox + `approval: "never"` 固定を `ext.permission` に投影 | ✅ | ADR-0033 F3。waiting_permission は Codex で発生しない |
| 14-6 | 共通 Tool 記述層 (JSON Schema + handler pair) を完成、inter-agent tools を移送 | ✅ | 現 `wrapper/src/inter_agent.ts` を `wrapper/agent-common` へ移し、Claude / Codex 両方が同じ handler を使う |
| 14-6b | `@kaoiro/codex` 同梱の stdio MCP bridge 実装 (unix socket で wrapper に接続、`mcp_servers.kaoiro` config override で登録) | ✅ | ADR-0032 F5 改訂版。ターンごとに codex が bridge を spawn する前提 |
| 14-7 | Codex 側の `ask_user_question` を MCP bridge 経由で提供、question_request envelope への正規化 | ✅ | Claude native 側の挙動に影響なし。waiting_question 成立を確認 |
| 14-8 | `SpawnRequest` / `SpawnMessage` に `engine` フィールド追加、`@kaoiro/protocol` の型更新 | ✅ | server 側 `capabilities` 照合で検証 |
| 14-9 | runner launcher (`runner/src/spawn.ts`) を `engine → wrapper パッケージ` 解決に変更 | ✅ | `KAOIRO_WRAPPER_DEV=1` パスも engine 分岐 |
| 14-10 | dashboard の LaunchDialog に engine セレクト追加 (capabilities が 2 種以上のときのみ) | ✅ | 引き続き 1 種のときは現行 UX 維持 |
| 14-11 | dashboard の LaunchDialog を engine → model → optional effort の三段選択に再構成 | ✅ | model / effort リストは engine adapter が返す。Codex は curated 静的カタログ (ADR-0032 F4bc) |
| 14-12 | dashboard の権限 UI を更新: 表示は `ext.permission` 二軸バッジ、操作は engine-native セレクト + 二軸換算ラベル併記 (ADR-0033 F4) | ✅ | preset 層は採らない (2026-07-10 決定) |
| 14-13 | capabilities フィールド値のリネーム (`claude` → `claude-code`)、旧値 1 リリース窓正規化 + warn 実装 | ✅ | ADR-0032 F4a。次リリースで厳格 reject へ |
| 14-14 | Codex 側の session 列挙・resume 実装 (`~/.codex/sessions/**/rollout-*.jsonl` の `session_meta.cwd` 照合) | ✅ | ADR-0032 F8 で方式確定済み |
| 14-15 | Q1 検証: persona × Codex adapter での口調・態度再現テスト | ✅ | 2026-07-11 実機検証。代表 2 persona (kuroe / ao) を live 確認、注入は全 persona 共通経路。旧 open-question は close |
| 14-16 | Codex 側 cwd 起動時反映 (追跡は best-effort、Q4 は継続) | ✅ | 起動 cwd を `ext.cwd` に載せる最小実装 (thread.started に cwd が無いため wrapper が自前 stamp) |
| 14-17 | plugin-model.md / architecture.md / personas.md への追補 (F3 明記など、docs/plans に紐付く仕様変更を反映) | ✅ | protocol.md / codex-sdk-events.md は 2026-07-10 反映済み。残りは phase 完了直前にまとめて |
| 14-18 | wrapper / server / dashboard / runner の全テスト通過確認 | ✅ | regression が phase-13 と本 phase の 2 段階で健全性維持 |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Followups (in-phase but unfinished)

- [Q4 codex-cwd-extraction](../open-questions/codex-cwd-extraction.md) — cwd 変化追跡は best-effort として起動時反映のみで phase-14 完了とし、動的追跡は low urgency で継続。
- [codex-exec-approval-upstream](../open-questions/codex-exec-approval-upstream.md) — Codex の対話的承認は upstream の `exec_permission_approvals` stable 化待ち。本 phase は起動時固定二軸で完了とする。

## Open Questions Blocking This Phase

なし (全て close)。旧 Q1 (personality 注入実効性) は 2026-07-11 実機検証で close、旧 Q2 (envelope schema) / Q3 (UI 語彙) / Q5 (model カタログ) / Q6 (互換窓) は 2026-07-10 の実 SDK 検証 + spec-elicitation で解決し close 済み (決定は [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md) に追補)。低優先の継続追跡は上記 Followups の Q4 / codex-exec-approval-upstream のみ。

## See Also

- Specs covered: [plugin-model](../specs/plugin-model.md)、[protocol](../specs/protocol.md)、[personas](../specs/personas.md)、[architecture](../specs/architecture.md)、[codex-sdk-events](../specs/codex-sdk-events.md) (新設)
- 関連 ADR: [ADR-0032](../adr/0032-codex-adapter.md) (本 phase の主 ADR)、[ADR-0033](../adr/0033-permission-model-dual-axis.md) (権限二軸)、[ADR-0027](../adr/0027-askuserquestion-envelope.md) (question envelope)、[ADR-0014](../adr/0014-session-resume-and-restore.md) (resume 分離)、[ADR-0031](../adr/0031-runner-persona-trust-mode.md) (互換窓のパターン)
- Previous phase: [phase-13-wrapper-multipackage-restructure](phase-13-wrapper-multipackage-restructure.md)
