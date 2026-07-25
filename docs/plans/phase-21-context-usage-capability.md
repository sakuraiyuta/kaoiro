---
title: Phase 21 — context 使用量表示の capability 化と Codex 側 estimated 撤回
description: ext.session_capabilities.supports_context_usage を導入し UI を capability-only gating に切替。Claude 側は init/model-switch trigger + guards を追加、Codex 側は capability=false stamp と dead helper 撤去。
status: completed
phase: 21
depends_on: [20]
last_updated: 2026-07-16
---

# Phase 21 — context 使用量表示の capability 化と Codex 側 estimated 撤回

## Goal

[ADR-0040](../adr/0040-context-usage-capability.md) を実装する。既存の
`ext.context` inline shape は据え置きつつ、`ext.session_capabilities.supports_context_usage`
で 3-state (absent / false / true) の UI gating を確立する。Claude は
capability=true + init/model-switch trigger 追加、Codex は capability=false
stamp + dead code 撤去。旧固定文言「初回応答後に取得」を撤回する。

## Acceptance Criteria

- [x] `protocol/src/index.ts` の `SessionCapabilitiesExt` に
      `supports_context_usage?: boolean` を optional 追加。既存 5 field
      と同じ open schema 拡張。tri-state 契約 (absent / false / true) を
      JSDoc に明記。
- [x] `docs/specs/protocol.md` L134-145 session_capabilities section に
      `supports_context_usage` の 3-state 契約 (rolling upgrade 期の
      absent と explicit false の区別、Claude=true / Codex=false の理由) を追記。
- [x] `wrapper/claude-code/src/host.ts`:
  - `initialStatusExt()` に `supports_context_usage: true` を追加。
  - `#contextInflight` / `#contextRefreshPending` / `#contextGeneration`
      フィールド追加。
  - `#refreshContextUsage()` を rewrite: inflight guard + generation
      guard + dedup + close guard + finally re-kick。
  - `#refreshContextUsageForInit()` 追加: init + 100ms backoff で 1 回
      retry、close/generation を跨がない bounded retry。
  - `#applyInitMeta` 直後で `#refreshContextUsageForInit()` を fire。
  - `setModel` 成功後で `#contextGeneration++` + `#context=null` +
      `#emitState` + async re-fetch。
- [x] `wrapper/claude-code/test/host.test.ts` 更新:
  - 既存 `initialStatusExt` / capabilities matcher に
      `supports_context_usage: true` を追加。
  - 新規: init 直後 refresh、init bounded retry、dedup、setModel 世代管理
      の 4 テスト追加 (計 197 test 全 pass)。
- [x] `wrapper/codex/src/host.ts` の `initialStatusExtFromCatalog` に
      `supports_context_usage: false` を追加。
- [x] `wrapper/codex/src/adapter.ts` の dead `threadEventToUsage` を削除。
      `wrapper/codex/src/index.ts` の export と
      `wrapper/codex/test/adapter.test.ts` の該当テストも削除。
- [x] `wrapper/codex/test/host.test.ts` 更新: capability matcher に
      `supports_context_usage: false` 追加 + 「Codex は `ext.context` を
      絶対 stamp しない」の全 envelope 検査を追加 (計 80 test 全 pass)。
- [x] `docs/specs/codex-sdk-events.md` L48 (`usage` 説明) と L84
      (`turn.completed` 状態導出) から「usage (tokens) を ext に反映」を
      撤回、`ext.session_capabilities.supports_context_usage=false` を
      advertise する旨に切替。
- [x] `docs/specs/plugin-model.md` L32-37 に `ext.context` の Codex 扱い
      (adapter 直接付与、ADR-0040 参照) を追記。
- [x] `dashboard/src/lib/protocol.ts`:
  - `SessionCapabilities` に `supports_context_usage?: boolean` 追加、
      JSDoc に 3-state UI 契約を明記。
  - `sessionCapabilitiesFrom` parser で boolean のみ保存、malformed は
      drop (fail-closed absent 相当)。
- [x] `dashboard/src/lib/AgentDetail.svelte`:
  - ctx 行を capability-driven 3-state 分岐に書き換え
      (true+value/true+null/false)。
  - `undefined` は行そのものを非表示 (rolling upgrade 対応)。
  - 旧固定文言「初回応答後に取得」を撤回、`true+null` は「取得中」に。
- [x] `dashboard/test/protocol.test.ts` に tri-state 保存 + malformed
      drop の parser test を追加。
- [x] `dashboard/test/contextUsageDisplay.integration.test.ts` を新設
      (5 test): AgentDetail mount で 4 状態 (true+null / true+value /
      false / absent) を検査、engine 名分岐禁止の consistency も検証。
- [x] `dashboard/test/modelSwitch.integration.test.ts` の fresh-idle
      テスト fixture を `supports_context_usage: true` に更新、旧固定文言
      「初回応答後に取得」除去を assert (計 191 test 全 pass)。
- [x] Elixir 側の `wrapper_channel.ex` / `agents_channel.ex` は変更なし
      (ext は opaque; 既存 viewer 秘匿 test は shape 変更不感で non-regression)。

## Progress

| Task | 状態 | 内容 |
|---|---|---|
| 21-1 | ✅ | protocol.ts に capability field 追加 + docs/specs/protocol.md 同期 (commit e2f63a7) |
| 21-2 | ✅ | Claude wrapper: capability stamp + 3 trigger (init [initial+retry] / result / model-switch) + 5 guards (inflight / pending re-run / generation / dedup / close) + 4 test (commit 9bf4581) |
| 21-3 | ✅ | Codex wrapper: capability=false stamp + dead helper 撤去 + spec docs 同期 (commit 2e66794) |
| 21-4 | ✅ | UI: engine-neutral 3-state gating + 6 test (commit 0604ff5) |
| 21-5 | ✅ | ADR-0040 + phase-21 plan (commit fd6dd60) |
| 21-6 | ✅ | 藤 turn-5 review 反映: R1 (partial model switch failure 時の stale context 除去) + R2 (dedup 厳密化 test) + R3 (init retry throw ベース test) + plan doc 表現修正 |

## Post-implementation

Claude 側 init 直後の `getContextUsage()` 挙動は d.ts 実測ベースの合理的
推定であり、期待される `totalTokens > 0` の返り値は実機 dogfood で
別途検証する余地がある (ADR-0040 D6)。Codex 側 upstream の
`token_count` / compaction telemetry が確定した場合は本 phase の設計を
ベースに ADR-0040 を supersede する余地を残す。

## References

- [ADR-0040](../adr/0040-context-usage-capability.md) — 本 phase の設計判断
- [ADR-0034](../adr/0034-session-capabilities-advertisement.md) F3 — capability-only 判定原則
- 元 conversation: `fb40967b` (実装 orchestration)、`f4834340` (kickoff review)
