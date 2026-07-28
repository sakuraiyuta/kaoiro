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
  **ただし `post_tokens` は SDK 型上 optional (`post_tokens?: number`) で
  あり、常に載る保証はない。表示は「前 N → 後 M」を前提にせず、存在する
  field だけを条件付きで組み立てる** (欠落時は `前 N tokens` のみを出す
  degrade)。2026-07-28 の実機受け入れでは in-process の
  `SDKCompactBoundaryMessage` に `post_tokens` が載り、dashboard に
  `前 293221 tokens → 後 9187 tokens` として表示された。欠落ケース自体は
  未観測 (下記「実機受け入れ結果」の artifact 差異も参照)。
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
  **所要は文脈量依存で、この 13.7 秒は ~22k tokens という小さい文脈での
  値である** (下記「実機受け入れ結果」では ~293k tokens で 168.8 秒)。
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
| B1 | 閾値通知: `#context` 更新時に wrapper が機械判定し、既定 70% 超過で agent へ通知を 1 回注入 | あお (完了: f772277、未 push) |
| B2 | MCP tool `request_compact`: permission_broker 都度承認 → 承認後 wrapper が instruction queue へ `/compact` を投入 | あお (完了: 7748a2f、未 push) |
| B3 | ADR-0036 Context の「CLI native slash command parser を経由しない」を Codex 限定へ追補 (Track S 実測を根拠に) | もも (完了: 879db29、未 push) |
| BR | B1-B3 の diff レビュー | ふじ (完了: must-fix 3 群 + suggestion 2 件 → 下記「BR 指摘と修正」) |

実装時の確定判断 (2026-07-28、クロエ承認):

- descriptor は `claude-code/src/request_compact.ts` に配置 (inter_agent.ts
  同居だと codex の stdio bridge に露出するため。Claude 限定を条件分岐で
  なく構造で担保)。
- tool の `reason` は承認ダイアログ / tool result のみに使い、投入
  テキストへは連結しない (固定リテラル `/compact` のみ。model からの
  入力ストリーム injection を遮断。テストで pin)。
- 承認は canUseTool 経路 (`READ_ONLY_TOOLS` 非登録) で既存
  permission_broker に乗せる。broker を直接叩く新経路は作らない。
- 閾値は定数 + TODO (config 化は `WrapperConfig` = protocol wire に
  触れるため見送り)。
- 既知の限界: 「承認→実行 / 拒否→不実行」の分岐自体は SDK が
  canUseTool を呼ぶことに依存し unit test で踏めない (send_to_agent と
  同じ既存制約)。実機受け入れで確認する。

### BR 指摘と修正 (ふじ、2026-07-28。判定: push 不可 → 全採用で修正)

- **MF1 — 境界直後の stale 値による誤通知**。`#invalidateContextEpoch()`
  直後の refresh は圧縮前の値を返し得る (Track S 実測)。その値が新 epoch の
  閾値判定に流れ、compact した直後に 2 通目を出せた。既存テストが**この
  誤動作の方を pin していた**ため、テストごと書き換えた。
  対処: 下記 MF1-R で再設計 (初回対処の「直前 epoch の最終 reading を
  baseline に使う」案は不成立だった)。
- **MF2 — B1 通知が直列化を迂回**。operator / inter-agent / B2 は cli.ts の
  instruction chain に乗るが、B1 だけ `host.send` を直接叩いていた。
  対処: `AgentHostOptions.enqueueInjection` を追加し cli.ts の単一 chain
  (`enqueueInstruction`) を注入。chain が届いた時点で epoch を再確認して
  drop、re-arm は**同 generation の失敗のみ** (旧 epoch の遅延 reject が
  新 epoch の budget を巻き戻さない)。
- **MF3 — 実測と矛盾する文言**。`request_compact` の description /
  tool result から「~十数秒」「before/after token counts」の約束を撤去し、
  「文脈量により数分に達し得る」「完了は boundary log で観測」へ。
  `protocol-inter-agent.md` の「実測 ~13.7 秒」も文脈量依存の表現へ直し、
  ADR-0036 への broken link を修正した。
- **S1** — `READ_ONLY_TOOLS` を `read_only_tools.ts` へ分離し (cli.ts は
  import 時に `main()` が走るためテストから読めない)、
  `REQUEST_COMPACT_TOOL_FQN` が含まれないことを直接 pin。承認ゲートの
  実体は「auto-allow 既定に載っていないこと」そのものなので、不在自体を
  テストで固定する。
- **S2** — 実機受け入れ節の「whoami 値のみで」を、B1 も whoami と同じ
  cached context measurement を読む旨の記述へ修正。

#### MF1-R — baseline gate の再設計 (ふじ 再レビュー、2026-07-28)

初回対処の「直前 epoch の最終 `used_tokens` を baseline とし、それを下回る
reading で確定」は safety / liveness の**どちらも満たしていなかった**。
ふじ が示した反例 2 列:

1. **null baseline の誤通知** — 直前 epoch に成功 reading が無ければ
   baseline は null になり確定扱いになるが、境界直後の fresh call が
   pre-boundary の stale high を返す可能性は消えていない。gate が無い。
2. **飛び越しによる永久 mute** — 観測は離散なので、境界後の reading が
   一度も baseline を下回らない列 (大きな turn / attachment が挟まる、
   reset 後の初期 context が baseline 以上) は普通に成立する。
   「再び上回るには一度下回る必要がある」という初回の主張は誤り。
   その epoch の正当な通知が永久に出なくなる。

再設計 (`#contextEpochGate`)。**大小比較だけを確定条件にしない**:

- 基準は cached reading ではなく **boundary metadata**。`post_tokens` が
  あればそれ (新 epoch の正確な総量なので `<=` で確定)、無ければ
  `pre_tokens - 1` (pre 以上は stale と区別できないため)。どちらも無い
  event (`conversation_reset` 等) では null。
- 上記を満たさなくても、その epoch で `CONTEXT_EPOCH_SETTLE_READINGS`
  (= 3) 回目の reading に達したら確定する。これが liveness の担保で、
  反例 2 を塞ぐ。3 は Track S の「境界直後の stale reading は 1 回」に
  1 turn 分の余裕を足した値。誤通知は「1 turn 遅れで 1 回」に上界され、
  承認ダイアログ 1 回で済む側へ倒している。
- gate は `#invalidateContextEpoch()` でのみ張られる。確定後に再び
  mute されることはない。

mutation 確認: 初回案の semantics へ戻すと反例 2 本が落ち、metadata
fast path を潰すと post_tokens テストが落ちる。

### B1 — 閾値通知

- 判定点: `#context` が更新される箇所 (refresh 成功時)。既定閾値 70%
  (`used_percentage >= 70`)。設定で上書き可能なら configurable に、
  config 配線が重ければ定数 + TODO で可。
- 注入は **epoch 毎に 1 回** (dedup。`#invalidateContextEpoch` で解除)。
  毎 turn の再注入や常時表示は禁止 (P3: context anxiety 回避)。
- 通知文言は「context が N% に達した。回復するなら request_compact を
  使える。作業の切りが良いところで判断せよ」程度の中立なもの。
  切迫を煽らない。
- 注入経路は既存 instruction queue を使い、operator instruction と衝突
  しない直列化を維持。**BR MF2 で cli.ts の単一 chain
  (`enqueueInjection`) 経由へ是正**。
- **BR MF1 / MF1-R**: epoch 境界直後の未確定 reading では判定しない。確定は
  boundary metadata (`post_tokens`、無ければ `pre_tokens`) を基準にした
  判定か、境界後 3 回目の reading に達したことのいずれか。大小比較だけを
  条件にすると永久 mute が起こり得る。

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
- manual compact の所要は文脈量依存 (実測: 13.7 秒 @ ~22k tokens /
  168.8 秒 @ ~293k tokens)。実運用の文脈規模では数分に達し得る。発動中は
  既存の `status:compacting` log (Phase A) で観測可能なため、追加の state
  語彙は導入しない。`request_compact` の tool description も所要秒数を
  約束していない (「次のターン境界で走る」のみ) — この表現を維持する。
- push は BR 通過後。2026-07-28 の BR は **push 不可**判定 (must-fix 3 群)。
  修正差分の再レビューを通すまで unpushed 保持。

## 実機受け入れ結果 (あお、2026-07-28)

B2 の「承認→実行 / 拒否→不実行」分岐は unit test で踏めない (上記「既知の
限界」) ため、あお 自身の本番 session で end-to-end を実施した。

- **B2 全区間成立**: `mcp__kaoiro__request_compact` 呼び出し → canUseTool →
  permission_broker → operator (マスター) 承認 → handler が instruction
  queue へ `/compact` 投入 → 予約受理を tool result で返却 → 次のターン
  境界で compact 実行 → 完了。`reason` は tool result に echo されたが投入
  テキストには連結されていない (設計どおり)。
- **context の実測**: whoami で compact 前 269,858 / 1,000,000 (27%)、
  compact 後 **52,887 / 1,000,000 (5%)**。cached snapshot は旧値のままでは
  なく更新されていた = **MF1 の epoch 無効化 + refresh kick が実機で機能**。
- **A1 の表示 (マスターが dashboard 目視・スクリーンショット確認)**:
  `手動コンテキスト圧縮が完了しました（前 293221 tokens → 後 9187 tokens）
  168.8 秒` の 1 行。meter の 27%→5% 更新も同時に確認。
- **B1 は非発火** (27% < 閾値 70%)。期待どおり。
- **所要 168.8 秒** (~293k tokens)。Track S の 13.7 秒 (~22k tokens) の
  12 倍で、所要が文脈量依存であることの根拠 (P-b)。
- **artifact による metadata 表現差**: in-process の SDK message には
  `post_tokens` が載っていた一方、CLI の session jsonl (ディスク上の別
  artifact) の同 event には `postTokens` が無く `preTokens` /
  `durationMs` のみだった。field 名も snake_case / camelCase で異なる。
  観測事実のみ記す — jsonl は resume 用に CLI が別途書き出す永続表現で、
  SDK が consumer へ渡す in-process message とは生成経路が別、というのが
  当たりだが確証はない。**wrapper が読むべきは in-process message であり
  jsonl ではない** (Phase C で reset 系 event を扱う際も同じ)。
- **whoami の lag が定量化された**: whoami の compact 前値 269,858 に対し
  boundary の `pre_tokens` は 293,221 で 23,363 の乖離。A2 の "cached last
  successful measurement; whoami itself does not refresh" が実測で裏付け
  られた。B1 の閾値判定も whoami と同じ cached context measurement を
  読むため、同じだけ過小評価し得る。70% という閾値には十分な余裕があり
  実害はない。

## Phase C — 自発 new/clear (詳細化 2026-07-28、クロエ裁定)

設計方針: B2 (`request_compact`) と同型の tool 経路 + 新 wrapper→server
event。reset の実行系 (kill + relaunch) は ADR-0036 F2 の既存機構に
完全に乗り、runner / 実行 flow は変更しない。

| Track | 内容 | 担当 |
|---|---|---|
| C1 | 改訂 ADR 起草 (ADR-0036 F1/F6 を改訂する新 ADR) | もも (完了: ADR-0043, 5b24a6f) |
| C2 | wrapper: `request_session_reset` tool + turn 境界での server への要求送信 | あお (完了: 未 push) |
| C3 | server: `session_reset_request` 受理経路 + origin 追加 + threat-model / protocol.md 更新 | もも (完了: 416c2da、mix test 671 passed) |
| CR | C2+C3 の diff レビュー | ふじ |

### 設計決定 (C1 の ADR に落とす内容)

- **F1 改訂**: session_reset の起点に「agent 自身 (self-initiated)」を
  追加する。発動は MCP tool 経由であり、「wrapper が user text を再
  parse しない」原則は維持 (text parse は導入しない)。reserved command
  防御 (`/new` `/clear` の instruction reject) も維持。
- **他 agent 起点の経路は設けない** (P5)。operator が都度 director を
  指名し、指示された agent が自分の tool で要求 → operator 承認、で
  成立するため専用機構は不要。
- **F6 追補**: 自発 reset は turn 境界発火 (deferred)。tool call 時は
  「予約受理」を返し、当該 turn の完了後に wrapper が server へ要求を
  送る。operator 発 reset の busy 拒否・自動 interrupt 却下・queue
  却下は全て維持。
- **permission**: `request_session_reset` は P2 の「重」— permission_broker
  都度承認 (canUseTool 経路、B2 と同型)。承認は tool call 時、実行は
  turn 境界 — この時間差は P4 (deferred) の織り込み済み挙動とする。
- **handoff**: P6 のとおり機構化しない。tool description に「実行前に
  WORKLOG 等へ引き継ぎを外部化してから呼ぶ」ことを明記する。

### C2 — wrapper (あお)

- `request_session_reset` tool: 入力 `mode: "new" | "clear"` + 任意
  `reason`。B2 と同じ構造 (claude-code 限定配置 / canUseTool 承認 /
  reason は server への要求 payload にのみ載せ、どこにも連結しない)。
- 承認後は「予約」を保持し、**当該 turn の result 処理後** (wrapper が
  自分の turn 境界を確定できた時点) に新 event
  `session_reset_request {mode, reason?}` を WrapperChannel へ送る。
- server から reject (agent_busy / cooldown 等) が返った場合は 1 回だけ
  短い delay 後に再送、それでも駄目なら次 turn で agent に失敗を通知
  (log にも出す)。
- 観測は in-process SDK message / server reply のみ (session jsonl 禁止
  — 実機受け入れで確定した原則)。
- codex には露出しない。

実装時の確定判断 (2026-07-28):

- 予約の保持と turn 境界での送信は `SessionResetCoordinator` に切り出し、
  cli.ts の `onTurnEnd` から呼ぶ。cli.ts は import 時に `main()` が走り
  テストできないため、判断ロジックを外に置く (S1 と同じ理由)。
- `buildKaoiroMcpServer` / `kaoiroToolDescriptors` の第 2 引数を
  「Claude 限定 tool の配列 (`{descriptor, inputShape}`)」へ変更した。
  B2 の形 (optional な単一 descriptor) は 2 本目で破綻し、Zod shape を
  この file に書き足し続けることになるため。shape は各 tool の file が
  持つ。
- 再送は 1 回、delay 2.5 秒 (`SESSION_RESET_RETRY_DELAY_MS`)。server の
  dispatch cooldown が 2 秒で、turn 境界直後に最も起きやすい `agent_busy`
  はこれで解ける。再送も失敗したら agent へ通知し log する。
- server の error reason は closed vocabulary (ADR-0036 F7) だが、
  wrapper 側は未知の値を echo せず `unknown_error` に潰す。reason は
  operator log と agent への注入 turn に載るため。

### C3 — server (もも)

- `WrapperChannel.handle_in("session_reset_request")` を新設し、
  capability 検証 + `SessionResets.check_and_acquire` の既存 gate
  (pending lock / state / cooldown) を通して既存の runner push 経路へ
  合流させる。**実行系は一切変更しない**。
- `SessionResets` に origin (`:operator` / `:agent_self`) を追加し、
  `session_reset_started` broadcast に載せる (dashboard 表示は最小限、
  なくても可 — 判断は実装時に軽い方へ)。
- `docs/specs/threat-model.md` の 6 段防御と `docs/specs/protocol.md` の
  「operator のみ」記述を改訂 ADR に整合させる。
- viewer への情報境界 (ADR-0021) は現行のまま。

### C 共通の完了条件

- wrapper: test/typecheck green。server: `mix test` green +
  `mix format` 済み。
- reserved command 防御・operator 経路の既存テストが全て green のまま
  (回帰なし) であること。
- push は CR 通過後。実機受け入れ (マスター) を最終 gate とする。
- C: wrapper→server 新 control event + 新 MCP tool + deferred reset
  (turn 境界発火)。ADR-0036 F1 (operator-only) / F6 (busy 拒否) の改訂
  を伴う。permission は全承認から開始 (P2)。
