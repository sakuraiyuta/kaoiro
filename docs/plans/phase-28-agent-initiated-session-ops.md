---
title: Phase 28 — コンテキスト疲労の自己認識と自発 session 操作 (issue #168)
description: エージェントが自身の context 使用量を認識し、/compact・/new・/clear 相当の回復操作を自発できるようにする。本 plan は Phase A (可視化) と spike を実装粒度に落とす。Phase B (自発 compact) / C (自発 new・clear) は spike と Phase A の結果を受けて追補する。
status: in-progress
phase: 28
depends_on: [21, 27]
last_updated: 2026-07-28
---

# Phase 28 — コンテキスト疲労の自己認識と自発 session 操作

## Goal

[issue #168](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/168)
を実装する。設計判断はマスター決裁済み
([#168 issuecomment-2287](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/168#issuecomment-2287))。
本 plan はその決定を実装可能な粒度に落としたもので、決定そのものは
変更しない。

## 確定済み前提 (変更禁止)

| # | 決定 | 出典 |
|---|---|---|
| P1 | SDK に `compact()` control API は無い。発動は prompt 文字列 `/compact` (slash command 解釈)。完了検知は `SDKCompactBoundaryMessage` | #168 comment-2287 (1) |
| P2 | permission は二軸写像を採らず、初期形は「compact = 軽 / new・clear = 重、全て permission_broker 都度承認」 | 同 (2) |
| P3 | 疲労判定はハイブリッド (wrapper 機械判定で閾値超過時のみ通知 → agent 判断)。常時 context 表示は不採用 (context anxiety)。閾値は Phase A 後の実測で決定 | 同 (3) |
| P4 | 自発 new/clear は deferred reset (turn 境界発火)。ADR-0036 F6 の自動 interrupt / queue 却下は維持 | 同 (4) |
| P5 | 永続 director 役は定義しない。都度 operator 指示 + permission_broker 都度承認 | 同 (5) |
| P6 | handoff summary は機構化しない。compact は要約内蔵、new/clear は事前に agent 自身が外部化する運用指針 | 同 (6) |

## Track 構成

| Track | 内容 | 担当 | 状態 |
|---|---|---|---|
| S | spike: Claude wrapper 経路 (SDK streaming input) で `/compact` が slash command として解釈されるか実測 | もも | 完了 (解釈される — 下記「Track S 実測結果」) |
| A1 | compact 可視化: `compact_boundary` / `status(compacting, compact_result)` / `conversation_reset` を wrapper で処理し operator に見せる | あお | 完了 (6941f3e + 1c57045 + ae2c3b5、レビュー通過) |
| A2 | whoami に `context` を追加 (自己認識の最小実装) | あお | 完了 (同上) |
| R | 設計レビュー (本 plan + 決定記録) / A1+A2 diff レビュー | ふじ | 完了 (must-fix 1 件 MF1 検出→ae2c3b5 で修正確認、push 可判定) |
| B | 自発 compact (閾値通知 + agent 判断 + 発動経路) | 未割当 | Phase A 後に詳細化 |
| C | 自発 new/clear (ADR-0036 F1/F6 改訂 + 新 control event + deferred reset) | 未割当 | Phase B 後に詳細化 |

## Track S — /compact spike (もも)

ADR-0036 Context の「CLI native slash command parser を経由しない」は
Codex 側実測のみで、SDK 公式ガイドは `query({prompt: "/compact"})` が
slash command として実行されると明記している (矛盾)。Claude 側を実測する。

- 手順: scratch スクリプト (リポジトリ外 or 未 track 領域) で
  `@anthropic-ai/claude-agent-sdk` の `query()` を streaming input mode で
  起動し、通常メッセージ数往復で context を積んでから `/compact` を送る。
- 観測点: `SDKCompactBoundaryMessage` (`type:"system"`,
  `subtype:"compact_boundary"`) が届くか。`compact_metadata.trigger` /
  `pre_tokens` の実値。`SDKStatusMessage` の `compacting` /
  `compact_result` の有無。`/compact` が普通の user turn として model に
  渡ってしまわないか (応答内容で判別)。
- 追加観測 (余力があれば): `getContextUsage()` を compact 前後で呼び、
  used_tokens が減るか。
- 成果物: 実測ログ + 判定 (解釈される / されない / 条件付き) を私へ報告。
  コードは commit しない。

## Track A1 — compact 可視化 (あお)

現状 `wrapper/claude-code/src/adapter.ts:91-93` は system 系 message を
`init` しか処理せず、`:321` 付近の status 読み取りも permissionMode /
fast_mode 用のみ。compaction が起きても kaoiro には何も出ない。

- `SDKCompactBoundaryMessage` (`subtype:"compact_boundary"`,
  `compact_metadata.trigger/pre_tokens`) を受けたら operator に見える形で
  log event を emit する (既存の log emit パターンに従う。wire 変更が
  必要なら `docs/specs/protocol.md` も更新)。
- **決定 (2026-07-28, あお の提起で確定)**: `LogKind` が閉じた 4 値の
  ため、`protocol/src/index.ts` と dashboard に log kind `"system"` を
  追加する (C 案)。既存 kind の流用 (assistant/tool_result への偽装) は
  Phase B で同経路を使う際に意味論の誤りが増幅するため不採用。server は
  kind を検証せず素通しのため変更不要。commit は (i) protocol/dashboard
  の語彙追加、(ii) wrapper の可視化実装 + A2、の 2 本に分割する。
- log event には boundary metadata の実値 (pre_tokens / post_tokens) を
  載せる。compact 成否・削減量の正は boundary metadata (Track S 実測:
  直後の `getContextUsage()` は減少を反映しない)。
- **log 規約 (ふじ suggestion 採用)**: success は `compact_boundary` を
  正として 1 行 (`trigger`, `pre_tokens`, 任意で `post_tokens` /
  `duration_ms`)。`compact_result:'success'` で別の成功行を出して二重
  表示しない。failure は `compact_error` を既存 log 上限で clip。
  `conversation_reset` は `new_conversation_id` を operator-only log に
  含める。内部 `preserved_*` 等の未知 metadata は載せない。
- `SDKStatusMessage` の `compact_result: 'failed'` + `compact_error` は
  エラーとして log する。`SDKStatus = 'compacting'` の state 反映は
  任意 (state 語彙の追加が要るなら今回は見送り、log のみで可)。
- compact_boundary 受信後に `#refreshContextUsage()` を kick し、
  `ext.context` の meter が compact 後の実値へ更新されるようにする
  (既存 guard — inflight / generation / dedup — の流儀に従う)。
- `SDKConversationResetMessage` (`type:'conversation_reset'`) も同様に
  log へ (発生条件はまれだが drop しない)。

## Track A2 — whoami に context を追加 (あお)

現状 `WhoamiSnapshot` (`wrapper/agent-common/src/inter_agent.ts:40-55`)
に `context` が無く、agent は自分の context を見られない (peer のは
`list_agents` で見えるという非対称)。

- `WhoamiSnapshot` に `context?: {used_tokens, max_tokens,
  used_percentage}` を追加 (wire 3 field は ADR-0040 D4 のまま)。
- claude-code host の snapshot 生成 (`claude-code/src/host.ts:487-497`
  付近) で保持中の `#context` を載せる。null なら omit
  (absent = unknown の語彙を維持)。
- codex host は載せない (supports_context_usage=false、omit のまま)。
- `WHOAMI_DESCRIPTION` (tool 説明) に context field の説明を追記。
  常時参照を促す文言にはしない (P3: context anxiety 回避。「委任判断や
  operator への報告で必要なときに見る」程度)。
- **(ふじ suggestion 採用)** 返す値は last successful snapshot であり
  whoami 自体は refresh しない旨を description と spec に明記する
  ("cached last successful measurement; whoami itself does not refresh")。
  false precision の防止。on-demand refresh は追加しない。
- `docs/specs/protocol-inter-agent.md` の whoami 節を更新。

## Track A 共通の完了条件

- `cd wrapper && pnpm test && pnpm typecheck` green (既存 suite に
  合わせてテスト追加)。
- **(ふじ must-fix, 2026-07-28)** C 案で protocol/dashboard に触れるため
  `protocol`: `pnpm typecheck`、`dashboard`: `pnpm check && pnpm test`
  も green にする (system kind の render test 追加を含む)。
- 変更は上記 scope に限定 (閾値通知・MCP tool 追加・server 変更は
  Phase B/C。scope creep 禁止)。
- commit は日本語 conventional 形式、path 指定 add。push は
  レビュー (Track R) 通過後にクロエが指示。

## Track R — レビュー (ふじ)

- 前段: 本 plan と #168 comment-2287 の決定記録を読み、設計上の穴
  (特に P3 の anxiety 回避と A2 の開示範囲、A1 の log 粒度) を指摘。
- 後段: A1+A2 の diff レビュー (小径。must-fix / suggestion を区別して
  クロエへ報告)。

## Track S 実測結果 (もも、2026-07-28)

環境: SDK 0.3.220 / Claude Code CLI 2.1.220、streaming input mode
(`persistSession:false`, model haiku, tools 空)。通常 3 turn 後に
文字列 `/compact` を同 stream へ送信。スクリプトは repo 外 (未 commit)。

- **`/compact` は slash command として解釈される** (streaming input でも)。
  model への通常 user turn として渡った痕跡なし。
- イベント順序: `system/status {status:'compacting'}` →
  `system/status {status:null, compact_result:'success'}` →
  `system/compact_boundary` → 空文字の `result (success)`。
- `compact_metadata` 実値: `{trigger:'manual', pre_tokens:22315,
  post_tokens:882, cumulative_dropped_tokens:21433, duration_ms:13692}`
  (SDK 型定義より field が多い)。manual compact で所要 ~13.7 秒。
- **caveat**: compact 直後の `getContextUsage()` は totalTokens
  23,247/200,000 を返し減少を反映しなかった (boundary は post_tokens
  882 を報告)。**compact 成否・削減量の根拠は boundary metadata を正**
  とし、`getContextUsage()` 直後値に依存しない — A1 の refresh kick は
  meter の eventual な更新用と位置づける。
- `compact_result:'failed'` / `compact_error` は未再現 (失敗系は実装時に
  型定義準拠で防御)。
- 帰結: ADR-0036 Context の「CLI native slash command parser を経由
  しない」は Codex 限定の記述へ要修正 (Phase B 着手時に ADR 追補)。

## Phase B — 自発 compact (詳細化 2026-07-28、クロエ裁定)

設計方針: **wrapper + docs に閉じる** (server / protocol wire 変更なし)。

| Track | 内容 | 担当 |
|---|---|---|
| B1 | 閾値通知: `#context` 更新時に wrapper が機械判定し、既定 70% 超過で agent へ通知を 1 回注入 | あお |
| B2 | MCP tool `request_compact`: permission_broker 都度承認 → 承認後 wrapper が instruction queue へ `/compact` を投入 | あお |
| B3 | ADR-0036 Context の「CLI native slash command parser を経由しない」を Codex 限定へ追補 (Track S 実測を根拠に) | もも |
| BR | B1+B2 の diff レビュー | ふじ (quota 窓明け 8/3 以降) |

### B1 — 閾値通知

- 判定点: `#context` が更新される箇所 (refresh 成功時)。既定閾値 70%
  (`used_percentage >= 70`)。設定で上書き可能なら configurable に、
  config 配線が重ければ定数 + TODO で可。
- 注入は **epoch 毎に 1 回** (dedup。`#invalidateContextEpoch` で解除)。
  毎 turn の再注入や常時表示は禁止 (P3: context anxiety 回避)。
- 通知文言は「context が N% に達した。回復するなら request_compact を
  使える。作業の切りが良いところで判断せよ」程度の中立なもの。
  切迫を煽らない。
- 注入経路は既存 instruction queue (`host.send`) を使い、operator
  instruction と衝突しない直列化を維持。

### B2 — request_compact tool

- wrapper-local MCP tool (`inter_agent.ts` の 3 tool と同居)。入力なし
  (または任意の reason 文字列)。
- フロー: tool call → permission_broker で operator に承認要求
  (ADR-0028 D4 のパターン、P2 準拠) → 承認なら `/compact` を instruction
  queue へ投入 (queue が turn 境界を自然に保証、ADR-0036 F6 と非衝突)
  → tool result は「予約受理」を返す (compact 完了は boundary log で観測)。
- 拒否なら tool result にその旨。timeout は permission_broker の既存
  規約 (未設定なら無期限待機) に従う。
- 85% 自動 fallback は kaoiro 側では実装しない。SDK native の
  autoCompact を最終防衛線とする (P2 の全承認原則と矛盾させない)。
- codex wrapper には tool を出さない (compact 経路なし、engine 側
  auto-compaction 前提)。
- `docs/specs/protocol-inter-agent.md` に tool 仕様を追記 (B2 内で実施。
  B3 の ADR とはファイル非重複)。

### B 共通の完了条件

- wrapper test/typecheck green (B1 の dedup、B2 の承認/拒否/投入をテスト)。
- manual compact ~13.7 秒 (Track S 実測) — 発動中は既存の
  `status:compacting` log (Phase A) で観測可能なため、追加の state 語彙は
  導入しない。
- push はレビュー通過後 (BR は 8/3 以降のため、それまで unpushed 保持)。

## Phase C の概要 (後続詳細化)
- C: wrapper→server 新 control event + 新 MCP tool + deferred reset
  (turn 境界発火)。ADR-0036 F1 (operator-only) / F6 (busy 拒否) の改訂
  を伴う。permission は全承認から開始 (P2)。
