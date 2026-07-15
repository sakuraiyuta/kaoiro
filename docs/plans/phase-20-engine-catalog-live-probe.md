---
title: Phase 20 — LaunchDialog engine catalog live probe (Option E)
description: LaunchDialog の Claude モデル catalog を短命 SDK probe + runner memory cache で live 化。probe CLI を wrapper/claude-code に切り出し、runner が cache/dedup/TTL/orchestration を担う。server は薄い relay のみ。
status: completed
phase: 20
depends_on: [18]
last_updated: 2026-07-15
---

# Phase 20 — LaunchDialog engine catalog live probe (Option E)

## Goal

[ADR-0039](../adr/0039-engine-catalog-live-probe.md) を実装する。LaunchDialog
の Claude モデル catalog を `default` 1 エントリ固定から live 実測ベースへ切り
替え、Anthropic の新モデル (Sonnet 5 等) を手動更新なしで表示できるようにする。

短命 SDK probe を wrapper/claude-code の専用 CLI (`kaoiro-claude-probe`) と
して切り出し、runner が child process として起動する。runner は memory-only
の last-known-good cache と dedup mutex を持ち、既存 `RunnerLink.updateRegister()`
経由で refresh を hosts broadcast に流す。server side は薄い relay のみ
(新規 GenServer なし)。

責務分離: runner が catalog SoT、server は engine-agnostic relay、wrapper は
SDK 直依存を閉じた probe CLI 提供、client は自動/手動 refresh と default
fallback 描画。

## Acceptance Criteria

- [x] Empirical spike で prompt 未送信の init→supportedModels→close 成立 +
      副作用ゼロ (session file 差分 0 / tmpdir 汚染 0 / child process 残留 0)
      を実測 (phase-20-1、SDK 0.3.208)。
- [x] `protocol/src/index.ts` に `RefreshEngineCatalog` /
      `EngineCatalogResult` / `EngineCatalogFailReason` 追加。
- [x] `wrapper/claude-code/src/probe.ts` を新設し `bin: kaoiro-claude-probe`
      として公開 (package.json exports + bin)。probe は init.models を第一
      取得源、undefined/空時のみ `supportedModels()` fallback。副作用最小
      Options (cwd 隔離 / mcpServers/tools/hooks/agents/additionalDirectories
      を空)、OAuth/keychain は保持 (`--bare` は禁止)。
- [x] `runner/src/claude_probe.ts` が child process 経由で probe CLI を実行
      (SDK 直依存を runner に持ち込まない)。timeout / abort / stdout parse /
      classifyError を実装。
- [x] `runner/src/claude_catalog_cache.ts` が memory-only cache + TTL (1h)
      + last-known-good + dedup mutex を持つ。probe 失敗時は cache を保持。
- [x] `runner/src/engine_catalog_refresh.ts` が payload validation +
      unsupported_engine gating + probe orchestration + updateRegister +
      catalog_result 送信を担う。engine=codex は unsupported_engine で即
      失敗を返す (probe 呼ばず)。
- [x] `runner/src/transport.ts` に `onRefreshEngineCatalog` callback と
      `sendCatalogResult` method を追加。
- [x] `runner/src/cli.ts` で cache instance + handler を wire、config
      hot-reload 時に cache の last-known-good を updateRegister に反映。
- [x] `runner/src/config.ts` の `buildRegister` に第 3 引数
      `claudeCatalogOverride?` を追加 (後方互換維持、指定時 claude-code
      entry の models を override)。
- [x] `server/lib/kaoiro_server_web/channels/agents_channel.ex` に
      `handle_in("refresh_engine_catalog", ...)` を追加 (operator-only、
      `relay_to_runner_guarded` パターン)。`intercept` と `handle_out` に
      `catalog_result` を追加し operator-only 配信を保証。
- [x] `server/lib/kaoiro_server_web/channels/runner_channel.ex` に
      `handle_in("catalog_result", ...)` を追加 (`forward_to_operators`
      パターン、host_id stamp)。
- [x] `server/assets/src/lib/protocol.ts` に `refreshEngineCatalog` /
      `onCatalogResult` / `EngineCatalogResult` を追加。`parseCatalogResult`
      で defensive parse。
- [x] `server/assets/src/lib/LaunchDialog.svelte` に engine=claude-code
      選択時の auto refresh (force=false)、Claude 限定の手動 refresh button
      (force=true)、error 表示、default fallback 維持。
- [x] Unit tests: `runner/test/claude_catalog_cache.test.ts` (TTL / force /
      dedup / failure preserves)、`runner/test/engine_catalog_refresh.test.ts`
      (success / failure / unsupported_engine / malformed drop / cache-fresh
      skip)、`runner/test/config.test.ts` に buildRegister override 追加。
- [x] Integration tests: `server/test/kaoiro_server_web/channels/agents_channel_test.exs`
      に refresh_engine_catalog relay + operator-only intercept、
      `runner_channel_test.exs` に catalog_result forward。
- [x] `ADR-0037` の Context / Alternatives を「原理的に不可能」→「register-only
      前提での不可能。ADR-0039 の短命 probe (query 生成) で緩和」に訂正。
- [x] 変更関連の typecheck / test / format pass (commit は藤レビュー後)。

## Tasks

| # | 対象 | 状態 |
|---|------|------|
| 20-1 | Empirical spike (SDK 0.3.208 で probe 副作用検証) | ✅ |
| 20-2 | protocol event 定義 (RefreshEngineCatalog / EngineCatalogResult) | ✅ |
| 20-3 | wrapper/claude-code probe CLI 切り出し + bin エントリ | ✅ |
| 20-4 | runner probe client + cache + orchestrator + transport | ✅ |
| 20-5 | server relay (agents_channel + runner_channel + intercept/handle_out) | ✅ |
| 20-6 | client (protocol.ts + LaunchDialog auto/manual refresh) | ✅ |
| 20-7 | unit + integration tests | ✅ |
| 20-8 | docs (ADR-0039 / phase-20 plan / ADR-0037 訂正) | ✅ |
| 20-9 | 両 repo verify + 藤レビュー | ✅ |
| 20-10 | ADR-0039 F9 v1: WrapperConfig 経由 initial catalog 輸送 (A のみ) | ✅ |
| 20-11 | ADR-0039 F9 v2: B 相当の wrapper 内短命 probe + refresh_models_result 相関 + probe launcher 集約 + row shape defensive (藤 review turn-5→7) | ✅ |

## Notes

- 実装は kaoiro peer delegation で kuroe が実施、fuji がレビュー・commit/push
  を担う (2026-07-15)。commit / push / branch / installer 実行はレビュー後。
- 個人情報 (account.email 等) は docs/test fixture/log/commit artifact に残さ
  ない (fuji turn-5 指示、redact 徹底)。spike 記録は「OAuth 認証成功」までに
  留める。
- SDK 0.3.208 の `Options` に `settingsSources` は見つからず、user settings
  は probe subprocess でも常にロードされる (ADR-0039 F4 注記)。副作用最小化
  は cwd 隔離 + `mcpServers: {}` / `tools: []` 等で対応。
- Multi-account host での probe/wrapper account mismatch リスクは ADR-0039
  Consequences に明記 (単一 account 前提)。
- Codex 側 catalog は据え置き (ADR-0035 F1 保持)。live probe は Claude のみ。
- 検証記録 (最終): runner 171 pass (probe test +2 = 空/全 row 不正)、wrapper
  build ok (probe.js 生成)、client 176 pass (integration test 15: LaunchDialog
  7 + pending store 6 + unmount async no-crash 1 + in-place hosts refresh
  no-refire 1)、client svelte-check 337 files/0 errors、server mix test 409/410
  (唯一 fail は既知 #115 DETS 非分離、本変更と非回帰)。
- 藤 (kaoiro peer) の独立 real probe 実行 (redact 済み記録): PASS / exit 0 /
  elapsed ~1.59s / 6 models / `~/.claude/projects` ファイル数差分 0 / 個人情報
  出力なし / probe 残留プロセスなし。ADR-0039 F4 の副作用最小 Options 構成が
  operator の実環境でも実測どおりに機能することを追認。
