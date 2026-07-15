---
title: Phase 23 — resume 時の model / effort / *_source 再適用 (P1)
description: Phase 22 で P0 punt した model / effort / *_source を、両 engine で resume 経路 (initial restore / switch_session / reset_session) から復元する。5-case source-aware pair rule で "source が嘘にならない" セマンティクスを維持し、Codex は catalog 互換 reset、Claude は invalid effort pair drop を wrapper 側で担う。
status: implemented-pending-dogfood
phase: 23
depends_on: [15, 17, 21, 22]
last_updated: 2026-07-16
---

# Phase 23 — resume 時の model / effort / *_source 再適用 (P1)

## Goal

[ADR-0014 F1 追補](../adr/0014-session-resume-and-restore.md)
「P1 pair-aware apply for model / effort」を実装する。Phase 22 で P0
scope から分離した `model` / `effort` / `*_source` を、両 engine の
resume 経路 (initial restore / switch_session / reset_session) で
`SessionPointers.snapshot` から再適用する。engine default 降格による
operator の明示的な model / effort 選択の喪失を解消しつつ、
`ext.model_source` / `ext.effort_source` に嘘を stamp しない
(pair semantic を破らない) 5-case pair rule を確定する。

## Scope

**P1 apply 対象**:

- 両 engine (`claude-code` / `codex`) で `model` / `model_source` /
  `effort` / `effort_source`

**Phase 22 P0 (不変)**:

- Codex: `sandbox` / `network_access`
- Claude: `permission_mode`

**scope 外 (future phase)**:

- `SessionResetErrorReason` に schema-level malformed reason
  (`invalid_snapshot` 等) の追加 — Phase 22 R2 と同じく現行の
  safe-default relaunch を維持。
- fresh spawn / crash-restart / rollback の apply — 全経路で apply
  しないのは Phase 22 P0 と同じ semantics。

## Design decisions (藤 P1 議論, 2026-07-16)

- **D1 apply 対象は両 engine で対称**: `applyResumeSnapshot` の
  `APPLY_FIELDS_BY_ENGINE` を engine-symmetric に拡張し model / effort
  ペアを両側で apply する。Codex account default 復元と Claude
  operator 選択 model 復元が同じ経路で実装される。
- **D2 5-case source-aware pair rule**:
  1. **Both absent** → pair 全体 unset (fresh session が engine default
     を継承)。
  2. **value + source=default** → pair 全体 unset (SDK 委任、explicit
     pin しない)。default source を保持しつつ値だけ pin すると source が
     嘘になる。
  3. **value + explicit source (launch / config / env)** → verbatim
     preserve (resume 前の明示的選択を尊重)。
  4. **value only (source absent, legacy)** → value + `source="config"`
     transport provenance (source-tracking 導入前 DETS レコードの救済)。
  5. **source only (value absent)** → pair 全体 unset + stderr warn
     (write-side gate + read-side sanitize の両方が防ぐ意味論違反、到達
     時は wrapper mis-stamping バグを疑う)。
- **D3 cli source priority 刷新**: 両 wrapper の cli.ts で
  `config.model_source` が set のときはそれを最優先で
  `resolvedModelSource` に採用する。次点は `config.model` set →
  `"config"`、env tier default set → `"env"`、いずれも absent →
  `undefined`。effort も同 pattern。resume 由来 Case 3 の source が
  `"config"` に潰れないようにする。
- **D4 Codex catalog compatibility (constructor reset)**: Codex host の
  constructor で **`this.#resumeSnapshot !== null` (resume 経路限定)** かつ
  `this.#model` と `this.#effort` が両方 set かつ catalog に該当 model の
  `effort_levels` が明示されており `this.#effort` を含まない場合、既存の
  setModel 経路と同じ挙動を再利用
  (`#effortResetPending=true`、`#effortResetOnce=true`)。`#finishTurn`
  が turn 成功時に `default_effort` へ落とし `ext.effort_reset=true` を
  one-shot stamp する既存 mechanism をそのまま利用。model 不在 /
  `effort_levels` 不明は SDK 委任 (reset を engage しない) — genuine
  mismatch は SDK 側 error が `#finishTurn` の switch_error rollback で
  捕捉。**fresh spawn 経路 (`#resumeSnapshot === null`) は本 reset の
  対象外**: launch-time の operator 選択を dashboard 経由でない黙示 reset
  で上書きしないよう、従来通り SDK 側 error path に委ねる (R1 参照)。
- **D5 Claude invalid effort pair drop (cli filter)**: Claude cli.ts で
  `config.effort` が `CLAUDE_EFFORT_LEVELS` 外の場合、pair rule の意図を
  wrapper 境界でも守るため **value / source を同時 drop** + stderr warn。
  runner は engine の effort 語彙を知らないので、この filter は wrapper
  側で行う (cross-package 依存の増加を避ける設計選択)。
- **D6 P0 との独立性**: pair-aware apply は Phase 22 P0 の Codex sandbox
  / network_access / Claude permission_mode 再適用と同一の apply 経路上
  で動作。「absent → engine default」の safe fallback semantics も P0 と
  同じ。P0 と P1 は個別に評価され、片方 apply 済みでも他方に drift 表示
  は影響しない (`ext.resume_drift` は field 単位で独立)。
- **R1 (藤 1 次 review 差戻し確定)**: Codex constructor の catalog reset
  は **resume 経路限定** (`this.#resumeSnapshot !== null` guard)。fresh
  spawn では従来通り SDK 側 error / 既存 switch_error rollback に委ねる
  (launch-time の operator 選択を dashboard 経由でない黙示 reset で
  上書きしない)。fresh spawn incompatible effort regression pin を追加。
- **R2 (藤 1 次 review 差戻し確定)**: pure helper 単体では各 handler が
  applyResumeSnapshot 経由で `config.model_source` / `effort_source` を
  wrapper まで carry することを pin できないため、`supervisor.test.ts`
  に **initial restore / live switch / reset_session の integration
  test** を追加 (Codex/Claude 対称、Case 3 preserve / Case 2 default 不
  passthrough / Case 4 legacy `config` stamp / fresh spawn 不 apply)。
  crash/rollback は Phase 22 P0 系 test で `entry.parsed` carry 経路が
  pin 済みで、P1 field も同じ carry を辿るため独立 test は追加せず本
  plan で根拠明記。
- **R3 (藤 1 次 review 差戻し確定)**: 両 wrapper で
  `src/source_resolution.ts` に **pure helper `resolveCodexSources` /
  `resolveClaudeSources` を抽出**し、CLI からその helper を呼び出す
  最小 invasive リファクタ。priority 分岐と Claude invalid effort pair
  drop を `test/source_resolution.test.ts` で unit test 化 (関連 suite
  pass)。既存 host test では host options を直接注入していて CLI の
  priority ロジックを通らなかった穴を塞ぐ。

## Acceptance Criteria

- [x] `protocol/src/index.ts` の `WrapperConfig` に `model_source?:
      ModelSource` / `effort_source?: ModelSource` を optional 追加
      (runner-relayed resume snapshot pair の transport 用)。
- [x] `runner/src/supervisor.ts` の `ParsedSpawn` に `modelSource?` /
      `effortSource?` を追加、`resolveWrapperConfig` で `config.model_source`
      / `config.effort_source` に passthrough。`parseSpawn` は SpawnMessage
      に該当 field が無いため populate しない (apply 経路のみ populate)。
- [x] `runner/src/resume_snapshot.ts` の `applyResumeSnapshot` に
      5-case pair rule (`computePair`) を組み込み、両 engine で
      `model` / `modelSource` / `effort` / `effortSource` を pair 単位で
      apply する。Phase 22 P0 の Codex sandbox / network_access /
      Claude permission_mode 再適用は無変更。
- [x] `wrapper/codex/src/cli.ts` の `resolvedModelSource` /
      `resolvedEffortSource` priority を刷新 (config.model_source > config
      > env > undefined)。既存 startup summary stderr 出力は無変更。
- [x] `wrapper/codex/src/host.ts` の constructor に catalog 互換 reset
      block を追加。**`this.#resumeSnapshot !== null` (resume 経路限定)**
      で `this.#model` と `this.#effort` が両方 set かつ catalog に該当
      model の `effort_levels` が存在し `this.#effort` を含まない場合、
      `#effortPending=null` / `#effortResetPending=true` /
      `#effortResetOnce=true`。既存 setModel 経路と同じ状態遷移を辿る
      ため `#finishTurn` に追加変更は不要。fresh spawn 経路
      (`#resumeSnapshot === null`) は本 reset の対象外で、launch-time
      choice は従来通り SDK 側 error path に委ねる。
- [x] `wrapper/claude-code/src/cli.ts` の `resolvedModelSource` /
      `resolvedEffortSource` priority を刷新。`config.effort` が
      `CLAUDE_EFFORT_LEVELS` 外の場合、`resolvedEffort` / `resolvedEffortSource`
      を両方 undefined に落とし stderr warn を出す (pair drop)。
- [x] `runner/test/resume_snapshot.test.ts` に 5-case pair rule 網羅
      (両 engine の Case 3、Case 1、Case 2、Case 4、Case 5、mixed pair、
      P0 P1 同時 apply)。Phase 22 の既存 P0 test は無変更。
- [x] `wrapper/codex/test/host.test.ts` に P1 catalog reset regression
      pin を追加 (整合時は reset engage しない / mismatch で
      effort_reset one-shot + ThreadOptions から effort skip / model
      不在は SDK 委任で reset engage しない)。関連 codex suite pass。
- [x] `wrapper/claude-code/test/host.test.ts` に P1 pair-aware pin を
      追加 (resume 由来 source=launch が effective に stamp され drift
      が空)。関連 claude-code suite pass。
- [x] docs: ADR-0014 F1 追補 に「P1 pair-aware apply for model / effort」
      節を追加。protocol.md / phase 依存グラフ更新は他 phase から自然発生
      するまで先送り (今回変更対象 field は WrapperConfig transport のみ)。
- [x] typecheck (protocol / runner / wrapper 4 pkg workspace) clean、
      `mix format --check-formatted` は server 変更なしのため対象外、
      `git diff --check` clean。
- [ ] end-to-end 手動検証 (dogfood): restart → 前セッションの
      operator 選択 model / effort が復元、`ext.model_source` /
      `ext.effort_source` が resume 前と一致、Codex catalog 更新シナリオ
      で effort_reset バッジが 1 回だけ出て次 turn 以降 default_effort
      に落ちる。マスター実機確認。

## Tasks

| id | subject | status | note |
|---|---|---|---|
| 23-1 | protocol: `WrapperConfig.model_source?` / `.effort_source?` | ✅ | types-only |
| 23-2 | runner: `applyResumeSnapshot` に 5-case pair rule 組み込み + `ParsedSpawn` 拡張 + `resolveWrapperConfig` passthrough | ✅ | `computePair` helper 追加 |
| 23-3 | runner: pair rule 5-case 網羅 test | ✅ | 両 engine 対称 + mixed pair + P0/P1 同時 |
| 23-4 | wrapper/codex/cli: source priority 刷新 | ✅ | config.model_source 最優先 |
| 23-5 | wrapper/codex/host: constructor catalog 互換 reset | ✅ | 既存 effortReset one-shot に接続 |
| 23-6 | wrapper/claude-code/cli: source priority 刷新 + invalid effort pair drop | ✅ | value/source 同時 drop + stderr warn |
| 23-7 | wrapper regression pin (Codex catalog reset + Claude pair) | ✅ | ThreadOptions gate / effort_reset one-shot / drift 空 |
| 23-8 | docs: ADR-0014 F1 追補「P1 pair-aware apply」 | ✅ | 5-case pair rule + Codex reset + Claude pair drop |
| 23-R1 | Codex host constructor catalog reset を resume 経路に限定 + fresh 非回帰 pin | ✅ | 藤 1 次 review must-fix。`this.#resumeSnapshot !== null` guard、fresh spawn incompatible effort で reset 非発火 regression 追加 |
| 23-R2 | runner supervisor.test.ts に P1 integration test 追加 | ✅ | 藤 1 次 review must-fix。initial restore / switch / reset を Codex/Claude 対称、Case 2/3/4 + fresh 不 apply |
| 23-R3 | CLI source resolution を pure helper 抽出 + unit test | ✅ | 藤 1 次 review must-fix。両 wrapper に `source_resolution.ts` (helper) + `source_resolution.test.ts` (関連 suite pass) |
| 23-D1 | Codex host constructor に resume_snapshot default pair の display hint fallback | ✅ | 藤 dogfood 回帰対策。config/option absent 時のみ (value, source="default") pair を復元、pair 整合 pin (source-only は対象外) |
| 23-D2 | Codex `#threadOptions` の effort gate 対称化 | ✅ | model gate と対称、`effortSource !== "default"` で non-pin |
| 23-D3 | Claude AgentHost constructor に resume_snapshot default pair の hint fallback + effort catalog re-validation | ✅ | 藤 dogfood 回帰対策。CLAUDE_EFFORT_LEVELS 外なら pair drop + stderr warn |
| 23-D4 | Claude run() Options gate: source="default" で model/effort 非 pass | ✅ | 藤 dogfood 回帰対策。operator setModel/setEffort (source="config") は pass 継続 |
| 23-D5 | runner integration assertion: Case 2 で `config.resume_snapshot` pair 保持 | ✅ | Case 2 logic は無変更、既存 supervisor.test.ts に resume_snapshot 保持 assertion 追加 |
| 23-D6 | 両 host regression pin | ✅ | initial idle 時点で hint 復元 / supports_effort_switch=true / SDK Options 非 pin / Case 3 は SDK に pin / Claude invalid effort pair drop、関連 suite pass |
| 23-D7 | docs: ADR-0014 F1 追補 に「launch pin vs display hint 責務分離」小節 + phase-23 plan status 戻し | ✅ | dogfood 回帰事例と修正方針を明文化 |
| 23-R4 | Claude hint fallback で `#persistedModel` は null 維持 | ✅ | 藤 3 次 review must-fix (semantic)。SDK default の historical hint は `persist_alias_unknown` validation 対象外 |
| 23-R5 | ADR/plan の bootstrap default entry 記述訂正 | ✅ | 藤 3 次 review must-fix (factual docs)。`claudeBootstrapCatalog()` の default entry は `FULL_EFFORT` を持つ。button 非表示の実成立条件は runner live catalog に default alias 無しで model=null の場合 |
| 23-R6 | 現実的 catalog fixture で Claude button 回帰を直接証明 | ✅ | 藤 3 次 review must-fix (coverage)。`config.claude_engine_catalog` に default 無し + hint model entry effort_levels 有りで hint 復元 → `session_capabilities.supports_effort_switch=true` + active entry effort_levels 非空を assert、R4 の persist_alias_unknown 非発火も統合 pin |
| 23-9 | dogfood 手動検証 | ⏳ | マスター実機確認 pending (D1-D7 + R4-R6 修正後の再検証) |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done.

## Risks

- **source が嘘になる回避策**: 5-case pair rule の Case 2 (default
  source) と Case 5 (source only) が最も繊細。Case 2 で value を pin
  すると次回 source が「default」なのに explicit choice に見えてしまう
  ため、両側 unset で SDK 委任に落とす。Case 5 は write-side + read-side
  gate 両方の後にも到達しうる wrapper mis-stamping バグを想定した
  defensive drop + warn。
- **Codex catalog 更新による effort mismatch**: constructor reset で
  effort_reset one-shot に接続する。integration test 通過するが実機で
  catalog snapshot と実 SDK 側 catalog が乖離した場合、SDK 側 error は
  既存の switch_error rollback で捕捉される (host.ts `#finishTurn`)。
- **Claude effort catalog の drift**: `CLAUDE_EFFORT_LEVELS` はソース
  コード内の静的定数。上流 SDK 側で新しい effort level が追加された
  場合、cli filter に fall through して value/source が drop される。
  releasing に合わせて `CLAUDE_EFFORT_LEVELS` を更新する運用が必要
  (既存の phase-15 契約と同じ)。
- **legacy DETS record (`model_source` / `effort_source` が
  server-side sanitize で drop)**: pair rule Case 4 (value only) が
  transport provenance として `"config"` を stamp するので Case 5 に
  落ちない。過去 record の救済は wrapper 側で明示的に扱う。
- **P1 apply が operator 選択と衝突するケース**: restore 直前に別 host
  上の同 agent_id が set_model してた場合、SessionPointers の snapshot
  が「反映済み」なら Case 3 で復元、まだ書き込み前なら Phase 22 と
  同じ crash-restart race に該当し 1 世代前で復元。ADR-0014 F1 追補の
  crash-restart race 記述 (「drift 可視化は保証しない」) を継承。
- **手動 dogfood 経路の増加**: Codex + Claude それぞれで
  operator-selected model + effort を持つ agent を用意し、
  dogfood.sh restart 後に resume 復元と ext.model_source /
  ext.effort_source の値を目視確認する。Phase 22 の privilege 三軸と
  同じ手順を model / effort に拡張。
- **launch pin と display hint の責務分離不足 (D1-D7 で解消)**: 初回
  push した Phase 23 実装 (23-1〜23-R3) では Case 2 (source=default) の
  runner apply が config.model / config.effort を unset した副作用として、
  wrapper host の initial `#model` / `#effort` に前回セッション値が届かず、
  Codex `initialStatusExtFromCatalog(catalog, model=null)` で
  `supports_effort_switch=false` が stamp、dashboard 側 effort switch
  ボタンが gate される回帰が dogfood で発覚 (3 症状同時: Codex model
  「確認待ち」/ Codex effort 復元されない / 両 engine effort ボタン非表示、
  2026-07-16)。Claude 側 button 非表示の実成立条件は、runner-transported
  live catalog (`config.claude_engine_catalog`, ADR-0039 F9 追補) が
  default alias を含まない現実的な shape のとき、model=null で
  `models.find(m.value === $currentModel)` も `... === "default"` fallback
  も解けず `effortLevels=[]` になるケース (bootstrap 単体には default entry
  - full effort_levels があるためこの経路では再現しない — dogfood で
  観測された production 契約は runner live catalog 経路)。
  **runner apply の Case 2 unset は launch pin の意味では正しい**ため
  無変更維持、**wrapper host constructor 側で `options.resumeSnapshot`
  の (value, source="default") pair を display hint として consume** する
  形で解消 (D1/D3)。SDK 委任 semantics を壊さないため両 wrapper の SDK
  Options 経路に `source !== "default"` の gate も対称に追加 (D2/D4)。
  Claude 側 `#persistedModel` は明示 spawn/env/Case3 alias の SDK-measured
  catalog 検証用のため hint 復元時は null 維持し、SDK default の historical
  hint が現 catalog に無いだけで `persist_alias_unknown` switch_error を
  出す穴を塞ぐ (藤 3 次 review R4)。詳細は ADR-0014 F1 追補「launch pin
  vs display hint の責務分離」節。
