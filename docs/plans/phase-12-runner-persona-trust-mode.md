---
title: Phase 12 — runner の persona 受け入れは allowlist/blacklist の 2 モード選択
description: ADR-0031 実装 phase。runner.config.json に allowed_personas / blocked_personas を導入して既定を accept-all に。判定は server 側 (AgentsChannel / HostRegistry) で完結、既存 personas フィールドは 1 リリース互換窓。
status: done
phase: 12
depends_on: [phase-10-persona-server-sot]
last_updated: 2026-07-07
---

# Phase 12 — runner の persona 受け入れは 2 モード選択

## Goal

[ADR-0031](../adr/0031-runner-persona-trust-mode.md) に基づき、runner の
`personas[]` allowlist に固定されていた「そのホストで起動できる persona」
の宣言を、**allowlist / blacklist / accept-all の 3 状態**を持てるように
する。デフォルト accept-all によって、pack 追加のたびに
`runner.config.json` を触る papercut(fuji 追加 2 回で再発)を構造的に
消滅させる。

判定は server 側で完結(`PersonaAssets` の集合と policy から `AgentsChannel`
が spawn 可否を判定)、runner は「policy を宣言する」だけの役割になる。
既存 `personas: [...]` フィールドは 1 リリース互換窓を設けて deprecation
警告つきで allowlist 互換動作させ、次期 major で撤去する。

`default` persona は特別扱いを撤去し、他 id と同格に blocklist/allowlist
に列挙可能とする(spawnable が空になるのは canary/準備中 host として
合法状態、dashboard は空 picker を明示)。

## Acceptance Criteria

- [x] `runner.config.json` から `personas` を省くと accept-all として動作
- [x] `allowed_personas: ["ao"]` で ao だけ起動可能(他 pack ingest 済でも)
- [x] `blocked_personas: ["fuji"]` で fuji のみ起動不可(他は全て可)
- [x] `blocked_personas: ["default"]` で default が spawn picker から除外
- [x] `allowed_personas` と `blocked_personas` の両方書かれた config は
  fail-loud で reject(runner 起動時 / server register 時の両方で)
- [x] 既存 `personas: [{id,...}]` のみを持つ config は allowlist 互換で
  動き、runner stderr と server Logger に deprecation 警告が出る
- [x] `allowed_personas` と `personas` の両方書かれた config は fail-loud
- [x] server 側で新 pack ingest → 稼働中 blacklist モード runner は再登録
  不要でその pack を spawn 可能になる(判定 server 完結の効用)
- [x] `HostRegistry.inject_default/1` の特別扱いは撤去済
- [x] `scripts/dev.sh` の生成テンプレートが accept-all(persona フィールド
  無しまたは `blocked_personas: []`)
- [x] mix test / pnpm test / pnpm typecheck 全通過(server 296 / runner 79 /
  wrapper 263 / dashboard 71)
- [x] `/my-code-review-cycle` 1 round 収束(must-fix 0、advisory 1: status
  drift = 本 plan の check off で解消)

## Tasks

### Stage phase-0(protocol / server 集約 SoT の下地)

| # | Task | Status | Notes |
|---|------|--------|-------|
| A-1 | protocol `RunnerRegister` に `allowed_personas?`/`blocked_personas?` を追加、`personas?` optional 化(legacy) | ✅ | wire は id 文字列配列 |
| A-2 | `PersonaAssets.all_personas/0` 新設(pack + reserved default を含む id/name/sprite_set map の list) | ✅ | HostRegistry と AgentsChannel が参照 |
| A-3 | `HostRegistry` を `:policy` 保持型に再構築、`inject_default/1` 撤去、`snapshot/1` などに personas_pool を渡す型に変更 | ✅ | entry から `:personas` フィールド撤去 |
| A-4 | `RunnerChannel.parse_register/1` を 2 モード対応 + 排他チェック + 旧 personas 互換(Logger.warning) | ✅ | 両モード同時 or new+legacy は `invalid_register` |
| A-5 | `AgentsChannel.resolve_persona/2` の呼び出し側で personas_pool を渡すよう配線 | ✅ | 判定は基本 get_public で完結、interface 温存 |
| A-6 | `HostRegistry` / `RunnerChannel` / `PersonaAssets` / `AgentsChannel` test 更新 | ✅ | pool 引数化 + 3 モードのマトリクス |

### Stage phase-1(runner 側)

| # | Task | Status | Notes |
|---|------|--------|-------|
| B-1 | `runner/src/config.ts` に `allowed_personas`/`blocked_personas` を追加、`personas` optional 化、排他検証 | ✅ | 旧 personas は stderr に deprecation |
| B-2 | `buildRegister` を新 wire に対応 | ✅ | 3 状態のいずれかを送る |
| B-3 | `runner/src/cli.ts` から `scheduleAllowlistCheck` / `fetchAndReport` / 関連定数を撤去 | ✅ | 判定 server 完結のため不要 |
| B-4 | `runner/test/config.test.ts` 更新(3 モード + 排他 + 互換) | ✅ | |

### Stage phase-2(cutover)

| # | Task | Status | Notes |
|---|------|--------|-------|
| C-1 | `scripts/dev.sh` の生成テンプレを accept-all(`blocked_personas: []` ヒントのみ)へ | ✅ | 既存 config は上書きしない挙動を維持 |
| C-2 | `docs/specs/personas.md` を 2 モード対応で書き換え | ✅ | default 通常扱い / spawnable 空許容も明記 |
| C-3 | ADR-0031 を `status: accepted` に昇格、last_updated 更新 | ✅ | 実装完了と `/my-code-review-cycle` clean を確認後 |
| C-4 | 実装 commit → docs commit → push | ✅ | 日本語 commit、境界ごとに分ける |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

### 追加実装(想定外の副次修正)

実装 dogfooding 中に 2 件の bug を検出し本 phase 内で修正:

- `HostRegistry.public_entry/2` が `:policy`(`{atom, MapSet}` タプル)を
  operator 向け snapshot に残していて、Jason.encode が
  `Protocol.UndefinedError` で crash し `hosts` push 全滅。`Map.drop([:runner_pid, :policy])`
  で解消 + Jason encode 可能性を assert する回帰テストを追加。**本 ADR-0031
  実装で新規に混入したバグ**。
- `wrapper/src/cli.ts onSetPermissionMode` が `host` 構築前に呼ばれる race
  で `TypeError: Cannot read properties of undefined (reading
  'setPermissionMode')`。**pre-existing だが ADR-0030 restore 経路の
  頻繁な after_join push で確実に発現するようになった**もの。
  `pendingPermissionMode` buffer に退避し、host 構築直後に適用する形へ
  修正(host.ts の「run() 前 setPermissionMode が initial mode を上書きする」
  設計と整合)。

## Open Questions Blocking This Phase

なし([ADR-0031](../adr/0031-runner-persona-trust-mode.md) で解決)。

## Out of Scope

以下は本 phase の対象外([ADR-0031](../adr/0031-runner-persona-trust-mode.md)
Non-Goals):

- per-token persona ACL(server → runner 方向の信頼)
- id の versioning / ワイルドカード / 名前空間
- common footer 側の lever
- 動的なモード切替
- spawnable ゼロ host に対する明示的アラート

## See Also

- ADR: [0031](../adr/0031-runner-persona-trust-mode.md)、
  [0029](../adr/0029-persona-server-sot-and-pack-distribution.md)、
  [0023](../adr/0023-host-runner-architecture.md)
- Previous: [phase-10-persona-server-sot](phase-10-persona-server-sot.md)
