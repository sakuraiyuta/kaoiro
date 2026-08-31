---
title: context-window 使用量表示を capability driven にし Codex の estimated 投影は行わない
status: accepted
date: 2026-07-16
opened: 2026-07-16
supersedes: []
superseded_by: null
related_specs: [protocol, plugin-model, agent-sdk-events, codex-sdk-events]
related_adrs: [21, 22, 32, 34, 35, 37, 39]
---

# ADR-0040 — context-window 使用量表示を capability driven にし Codex の estimated 投影は行わない

## Status

Accepted (2026-07-16、マスター決裁 → 藤 orchestration)。実装は
[phase-21-context-usage-capability](../plans/phase-21-context-usage-capability.md)。

## Context

`ext.context` (`{used_tokens, max_tokens, used_percentage}`) は #16 で
Claude Code adapter が `Query.getContextUsage()` から derive して stamp して
きた。`AgentDetail.svelte` の `ctx` 行は SDK 応答到達までのプレースホルダに
「初回応答後に取得」を固定表示していた。

以下の破綻が藤 review (2026-07-16、conversation `f4834340`) で確定した:

1. **Codex agent で永久 spinner**: Codex adapter は `ext.context` を stamp
   する経路を持たない (`docs/specs/codex-sdk-events.md` L84 に「wrapper が
   反映」と書かれていたが実装は dead `threadEventToUsage` のみで host から
   一度も呼ばれていなかった)。UI 側は engine 名分岐なしに「初回応答後に
   取得」を出しつづけ、operator を騙し続けていた。
2. **`turn.completed.usage.input_tokens` を estimated として代替する案は
   semantic 破綻**: (a) per-turn 入力のみで context 累積ではない、
   (b) compaction 直後に減るため「使用率が下がった」誤情報を出す、
   (c) reasoning / output tokens を含まない、(d) `max_tokens` の対応
   経路が存在しない (静的 catalog にも `context_window` field なし)。
3. **Claude 側の trigger 貧弱さ**: 従来は `SDKResultMessage` 到達時にのみ
   fire-and-forget で `getContextUsage()` を呼び、init 直後 / model 切替
   直後には呼ばれなかった。init 後の meter は初回 result まで空のまま。
4. **UI が engine 名を見ないという contract が確立していない**: ADR-0034 F3
   の「機能可用性は capability field で判定、engine 名で判定するな」を
   context 表示だけ守っていなかった。

対応の方向はマスター決裁で決まり、以降のレビューで骨格 + 詳細が確定した。
本 ADR はその決定を記録する。

## Decision

### D1. Capability-only gating (engine 名分岐禁止)

`ext.session_capabilities.supports_context_usage: boolean` を optional で
追加し、UI はこの field 単独で以下を判定する:

- **absent** (旧 wrapper) → ctx 行を非表示 (rolling upgrade 中の誤誘導を
  防ぐ; absent と `false` を混同しない)
- **explicit `false`** (adapter が非対応を宣言) → 「未対応」表示
- **explicit `true`** + `ext.context` 未到着 → 「取得中」placeholder
- **explicit `true`** + `ext.context` 到着 → 既存 meter

UI コードから engine 名 (`ext.engine`) を context 表示判定に使わない
(ADR-0034 F3 遵守)。

### D2. Claude adapter は capability=true + trigger 拡張

- `initialStatusExt()` で `supports_context_usage: true` を stamp。
- `#refreshContextUsage()` の trigger:
  - **init 直後**: 新設 `#refreshContextUsageForInit()` で initial + 1 retry
    (100ms backoff)。transient race で init 時取得を諦めず、result 到達まで
    meter を空にしない。close / generation を跨がない bounded retry。
  - **result 毎**: 既存 fire-and-forget を維持。
  - **model 切替成功後**: `#contextGeneration` bump + `#context = null` +
    async re-fetch。異 model 間で `max_tokens` が変わるため stale snapshot
    を認めない。
- Guards:
  - **inflight guard** (`#contextInflight`): 並行 trigger を coalesce。
  - **pending re-run** (`#contextRefreshPending`): guard で drop した caller
    が `finally` で自動再 kick。次の natural trigger まで stall しない。
  - **generation guard** (`#contextGeneration`): model 切替中の in-flight
    refresh は captured generation mismatch で結果破棄。fresh generation の
    refresh が `finally` で自動再 kick される。
  - **dedup**: 前回と同値なら `emitState` を呼ばず余分な state_change を
    出さない。
  - **close guard**: `close()` 後は再 kick しない。
- Authoritative stamp は既存 `#statusExt` の毎 state_change lazy stamp を
  維持 (rate_limits / cost の規約は触らない、藤 review S7 の判断結果)。

### D3. Codex adapter は capability=false + estimated 投影しない

- `initialStatusExtFromCatalog` で `supports_context_usage: false` を stamp。
- `ext.context` は絶対に stamp しない。
- `turn.completed.usage.input_tokens` を estimated context として代替する
  案は M-A に基づき採用しない (semantics 破綻、上記 Context §2)。
- 実装されないまま残っていた `threadEventToUsage` helper と export、
  `test/adapter.test.ts` の該当テストは削除 (dead code)。
- 将来 upstream Codex の compaction telemetry (`token_count` event 等) が
  確定した場合は本 ADR を supersede して exact 経路を検討する余地を残す。
  現状 grep 0 件で未対応。

### D4. Wire schema と後方互換

- `SessionCapabilitiesExt.supports_context_usage?: boolean` を optional 追加
  (protocol/src/index.ts)。既存 5 field と同じ open-schema 拡張。
- `ext.context` の既存 3-field wire shape (`used_tokens` / `max_tokens` /
  `used_percentage`) は**変更なし**。後方互換保持。
- Elixir 側 (`wrapper_channel.ex` の frame 検査 / `agents_channel.ex` の
  viewer 秘匿) は ext を opaque に扱うため変更ゼロ。既存 viewer 秘匿 test
  (`agents_channel_test.exs:1041-1085`) は shape 変更不感で non-regression。

### D5. Spec docs 同期

- `docs/specs/protocol.md` L134-145 の session_capabilities section に
  `supports_context_usage` を追加。
- `docs/specs/plugin-model.md` L32-37 に Codex の explicit false stamp と
  ADR-0040 参照を追記。
- `docs/specs/codex-sdk-events.md` L48 (`usage` field 説明) と L84
  (`turn.completed` → 状態導出) から「usage (tokens) を ext に反映」を
  撤回し、capability advertise に切替。

### D6. spike 済 / 未検証項目の切り分け

`getContextUsage()` について d.ts 実測で確定済 (`sdk.d.ts:2378, 2985-`):

- signature: `Query.getContextUsage(): Promise<SDKControlGetContextUsageResponse>`
- response shape: `totalTokens / maxTokens / rawMaxTokens / percentage /
  model / categories[]` etc
- control_request 経由、SDK の `initialize` control_response 到達後から
  成功する transport

**「init 直後 (turn 0) に呼ぶと `totalTokens > 0` が返る」は期待であって
実測ではない**。system_prompt + tools + MCP + memory_files が既に context
を消費するため合理的に非ゼロが返るはずだが、d.ts / sdk source からは断言
できない。実機 dogfood での再検証は phase-21 完了後に別途行う。失敗時の
挙動は best-effort として握り潰し、UI は「取得中」のまま滞留する
(M-A、藤 review turn-3)。

## Consequences

### 好影響

- Codex agent の ctx 行が「未対応」で正しく表示され、operator を騙さない。
- rolling upgrade 期の旧 wrapper でも誤情報を出さない (絶対 hide)。
- Claude 側の init trigger + bounded retry で「初回 result 到達まで空」と
  いう UX 破綻を修正。
- capability-only gating が確立し、engine 追加時に UI 修正が不要になる。

### コスト

- Claude adapter の trigger 追加で SDK control_request が増える (init 直後
  1〜2 回 + model 切替毎 1 回)。inflight guard + dedup で無駄な発火は防ぐ。
- 旧 wrapper 稼働中は ctx 行が消える → operator に一時的な UX 差異。ただし
  rolling upgrade 完了で自動解消。
- Codex の future compaction telemetry 対応は本 ADR を再訪する追加コスト。

### 未対応の余地 (out of scope)

- Codex 側 rollout の `token_count` イベント (upstream 追加時) を exact
  projection に載せる経路。現状 spec 未確定のため見送り。
- context 使用量の手動 refresh 経路 (現状 fire-and-forget のみ)。UI に
  refresh ボタンを追加する要求は phase-21 スコープ外 (藤 review S10)。
- envelope contract test / JSON schema 導入。scope 拡大のため見送り
  (藤 review O11)。

## References

- 元 conversation: `f4834340` (kuroe ↔ 藤 kickoff)、`fb40967b` (実装 orch)
- ADR-0022: pending-permission authoritative source (毎 state_change stamp
  pattern の先例)
- ADR-0034 F3: 機能可用性の判定に engine 名を使わない原則
- ADR-0037 F6: bounded retry + persistent state flag pattern の先例
- Wire spec: [protocol](../specs/protocol.md) L134-145
- Plugin routing: [plugin-model](../specs/plugin-model.md) L32-37
- Codex event 契約: [codex-sdk-events](../specs/codex-sdk-events.md) L48, 84
- Implementation plan: [phase-21-context-usage-capability](../plans/phase-21-context-usage-capability.md)
