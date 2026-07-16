---
title: Phase 24 — runner config で codex auth mode を明示宣言
description: Phase 23 dogfood 再々々々検証 (23-9) を阻む「runner 環境 PATH に codex binary が無いと `detectCodexAuthMode` が失敗して catalog 空 → 両 button 非表示」回帰を、runner config に `codex.auth_mode?: 'chatgpt' | 'apikey'` を明示宣言する経路を追加して解消。priority explicit config > doctor detection > "unknown"、chatgpt_plan からの暗黙推定は禁止。旧 config 互換維持 (未指定なら現行 doctor fallback)。
status: implemented-pending-dogfood
phase: 24
depends_on: [23]
last_updated: 2026-07-16
---

# Phase 24 — runner config で codex auth mode を明示宣言

## Goal

Phase 23 の dogfood 再々々々検証 (23-9) を阻んでいた「runner 環境 PATH に
`codex` binary が無いと `detectCodexAuthMode` が ENOENT で失敗して catalog
が空になり、両 button (model / effort switch) が非表示になる」直接原因を
解消する。runner config に `codex.auth_mode?: 'chatgpt' | 'apikey'` を
明示宣言する経路を追加、priority を `explicit config > doctor detection >
"unknown"` に統一する。

[ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md#auth-mode-決定の-priority-phase-24-追補2026-07-16)
に auth mode 決定の priority を追記、Phase 23 [phase-23 plan](phase-23-resume-model-effort-restoration.md)
の Risks / 23-9 note に本回帰事例と Phase 24 依存を記録する。

## Scope

**追加**:
- `runner/src/config.ts::CodexConfig` に `auth_mode?: 'chatgpt' | 'apikey'`
  optional field + `parseRunnerConfig` の closed-enum validation
- `runner/src/codex-auth.ts` に injectable policy resolver
  `resolveCodexAuthMode(input)` (async、priority policy は pure、default
  `detect` binding は doctor I/O)。CLI startup と hot reload の priority
  policy を helper 内に集約
- `runner/src/cli.ts::main` の startup と `applyReload` の分岐を helper
  呼び出しに置換
- `runner/runner.config.example.json` に `codex.auth_mode` 例を追記

**scope 外**:
- `scripts/dogfood.sh` の初回 auto-generate 変更 (API-key dev host を
  誤宣言するリスクがあるため。tracked 変更は example のみ)
- untracked `runner/runner.config.json` の更新 (藤 review 合格後、
  マスター環境専用として別途 auth_mode=chatgpt を追加、commit 対象外)
- Phase 23 の effort/model 復元系実装 (E-G は完全 closure 済、touch なし)

## Design decisions (藤 dogfood 診断 + 修正版方針)

- **D1 priority policy**: `explicit config > doctor detection > "unknown"`。
  explicit set 時は `detectCodexAuthMode` を絶対に invoke しない (runner
  環境 PATH に codex binary 無しでも動作する不変条件)。
- **D2 closed enum**: `auth_mode` の許容値は `"chatgpt"` / `"apikey"` の
  2 値のみ。他値は `parseRunnerConfig` で fail-fast reject (`ConfigError`)。
- **D3 chatgpt_plan からの暗黙推定禁止**: API-key runner でも `chatgpt_plan`
  を config に残置しているケース (auth 切替の途中経過) を誤判定するため、
  `auth_mode` 決定に `chatgpt_plan` を根拠として使わない。
- **D4 旧 config 互換**: `auth_mode` は追加 optional。既存 config が持たない
  場合は現行の doctor detection にフォールバック、失敗すれば `"unknown"`。
  破壊なし。
- **D5 hot reload の 5 遷移**: helper が全遷移を pin する (詳細は
  `resolveCodexAuthMode` の docstring)。
  1. next disabled → `"unknown"` (prev mode 破棄、doctor 非呼出)
  2. next explicit → verbatim 採用 (doctor 非呼出)
  3. prev explicit → next absent → doctor 再走
  4. prev off → next on (absent) → doctor 走る
  5. prev on (absent) → next on (absent) → prev mode 維持 (doctor 非呼出)
- **D6 CLI 分岐を薄く**: CLI 側の startup + `applyReload` は helper を
  呼ぶだけ。分岐の pin は helper の unit test で完結する (藤指示 4:
  「CLI main の分岐を直接 test 困難なら、async pure/injectable resolver
  を codex-auth.ts 等へ抽出し startup/reload policy を unit test」)。
- **D7 doctor output / credential 非 relay 継続**: `detectCodexAuthMode`
  の内部で `runCodexDoctor` の stdout / stderr は `parseCodexAuthMode` の
  `stored auth mode` field 抽出以外に relay しない。`resolveCodexAuthMode`
  も doctor の出力を保持しない (Phase-24 で変更なし)。
- **D8 security posture**: `auth_mode` は catalog 決定用の宣言 metadata の
  みで、runner は credential (OAuth token / API key 等、Codex 側の
  credential store / environment) を付与も変更もしない — その意味で
  escalation にならない。誤宣言時は catalog が実 entitlement からずれ、
  unsupported な model / effort の explicit request が SDK 側で loud
  fail → 既存 switch_error rollback (`turn_failed`) に到達しうる。auth
  実体の invalid credentials エラーになるかどうかは runtime の
  credential store / SDK 実装依存で、config だけからは断定しない。
- **D9 dogfood.sh 変更なし**: 初回 auto-generate に `"codex":{"auth_mode":
  "chatgpt"}` を無条件で追加すると API-key dev host を誤宣言するリスク。
  tracked 変更は `runner.config.example.json` に留め、operator が env 別
  に編集する運用を維持。

## Acceptance Criteria

- [x] `runner/src/config.ts::CodexConfig` に `auth_mode?: "chatgpt" | "apikey"`
      optional 追加、`parseRunnerConfig` で closed-enum validation
- [x] `runner/src/codex-auth.ts` に injectable policy resolver
      `resolveCodexAuthMode(input)` を export、`AuthModeResolveInput`
      interface で startup と hot reload 両経路を統一 (priority policy は
      pure、default `detect` binding は doctor I/O)
- [x] `runner/src/cli.ts::main` の startup (`await detectCodexAuthMode()`
      から `await resolveCodexAuthMode({...})` へ) と `applyReload` (旧
      3 分岐 if から helper 呼び出しへ) の書き換え
- [x] `runner/runner.config.example.json` に `codex.auth_mode` 例を追加
      (tracked)
- [x] `runner/test/codex-auth.test.ts` に `resolveCodexAuthMode` の
      startup + hot reload 全遷移 pin (Codex disabled / explicit chatgpt /
      explicit apikey / absent + doctor / plan からの推定禁止 / hot reload
      5 遷移、関連 suite pass)
- [x] `runner/test/config.test.ts` に `codex.auth_mode` の closed enum
      受入 (`chatgpt` / `apikey`) + 未知値 fail-fast + 旧 config 互換
      (absent) の 3 pin
- [x] `runner/test/supervisor.test.ts` の既存 codex_auth_mode wrapper
      relay pin は Phase-24 で挙動変化なし (既存 test 継続 pass)
- [x] docs: ADR-0035 に「auth mode 決定の priority (Phase-24 追補)」節
      追加、phase-23 plan Risks / 23-9 note に本回帰事例と Phase 24 依存
      を記録
- [x] typecheck (protocol / core / agent-common / codex / claude-code /
      runner) 全 clean、既存 Phase 23 修正 (D+E+F+G+R4-R6) は無変更維持
- [ ] end-to-end 手動検証 (dogfood): マスター環境の untracked
      `runner/runner.config.json` に `"codex": {"auth_mode": "chatgpt"}`
      を追加後、dogfood.sh restart で Codex agent の両 button (model +
      effort switch) が表示されることを目視確認。Phase 23 の 23-9
      dogfood もあわせて実施 (D+E+F+G+R4-R6+Phase 24 の全体検証)。

## Tasks

| id | subject | status | note |
|---|---|---|---|
| 24-1 | protocol/config: `RunnerConfig.CodexConfig` に `auth_mode?` closed-enum 追加 | ✅ | 旧 config 互換のため optional |
| 24-2 | `codex-auth.ts` に injectable policy resolver `resolveCodexAuthMode` を抽出 + cli.ts 側で使用 | ✅ | 順序は pure function、default `detect` binding は doctor I/O。CLI 分岐を薄く、pin は helper unit test で完結 |
| 24-3 | runner test: config schema + resolver startup / hot reload 全遷移 + wrapper relay 再確認 + empty catalog 回帰解消 | ✅ | 関連 suite pass |
| 24-4 | `runner.config.example.json` に `auth_mode` 例を追記 (`scripts/dogfood.sh` 変更なし) | ✅ | dev host 誤宣言リスク回避 |
| 24-5 | docs: 新規 phase-24 plan + ADR-0035 auth mode 決定節 + phase-23 plan Risks/23-9 追記 | ✅ | protocol.md には無理に追記しない |
| 24-6 | 全 pkg typecheck / test / diff --check | ✅ | Phase 23 コード無変更確認 |
| 24-7 | dogfood 手動検証 | ⏳ | マスター実機確認 pending (untracked config 更新後) |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done.

## Risks

- **explicit 誤宣言による UX 悪化**: operator が `apikey` を宣言して
  chatgpt-only model (SOL 等) を選ぶと SDK reject → 既存 `switch_error
  rollback` (`turn_failed` reason、host.ts `#finishTurn`) で回収される。
  Phase 23 E-G の tier 4 (concrete miss fail-closed) 経路でも一部の invalid
  pair は事前に button 非表示になる。button 表示上「選べる」形になる残存
  シナリオは operator が「試して確認」の UX を経験する形で許容。
- **doctor 経路の deprecate は取らない**: PATH に codex binary がある環境
  では引き続き自動検出が便利なため、doctor detection は fallback として
  維持。ただし explicit 宣言が推奨形式であることを ADR-0035 に明記。
- **hot reload 5 遷移の semantics**: helper に集約したので CLI 側の
  regression 面は狭い。resolver unit test で全遷移が pin されている。
  ただし、integration test で「実 file 書き換え → watcher → applyReload」
  経路までは pin していない (config-watcher.test.ts は watch loop 自体の
  test)。ここは既存 hot reload path の regression 面として保留、必要が
  出れば別 patch で integration test 追加。
- **scripts/dogfood.sh 自動生成の default 値**: API-key dev host を誤宣言
  するリスクを避けるため、初回 auto-generate では `auth_mode` を含めない
  方針 (藤指示)。operator が env 別に手動編集する運用を維持。tracked
  変更は `runner.config.example.json` に留める。
- **untracked `runner/runner.config.json`**: マスター環境専用として
  藤 review 合格後に `auth_mode=chatgpt` を追加、commit 対象外
  (user-local 設定、credential ではないが env-local metadata として扱う)。
- **security trust boundary**: `auth_mode` は catalog 決定用の宣言 metadata
  のみで credential は含まない。ADR-0035 の既存の trust boundary
  (「credential 本体は codex CLI 側で管理、runner config には載せない」)
  を継承。誤宣言による escalation リスクなし。
