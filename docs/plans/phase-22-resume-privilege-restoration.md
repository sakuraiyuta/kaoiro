---
title: Phase 22 — resume 時の privilege 三軸再適用 (P0)
description: SessionPointers.snapshot を SSOT に格上げし、Codex sandbox/network_access と Claude permission_mode を restore/switch/reset 経路で復元する。runner-central pure helper が engine 関連 field を authoritative に上書きし、fresh spawn/crash-restart/rollback は no-apply を維持。
status: implemented
phase: 22
depends_on: [15, 17, 21]
last_updated: 2026-07-16
---

# Phase 22 — resume 時の privilege 三軸再適用 (P0)

## Goal

[ADR-0014 F1 追補](../adr/0014-session-resume-and-restore.md) の
「resume 時の privilege 三軸再適用」を実装する。dogfood.sh 再起動後の
Codex agent resume で `danger-full-access` / `network_access=true` が
`workspace-write` / `false` に降格していた事故を含む gap を解消する。
`SessionPointers.snapshot` を drift 表示専用から**実効設定復元の SSOT**
に格上げし、restore / switch_session / reset_session の全 resume 経路で
runner-central pure helper が `ParsedSpawn` を snapshot 由来値に上書きする。

## Scope

**P0 apply 対象**:

- Codex: `sandbox` / `network_access`
- Claude: `permission_mode`

**P0 sanitize 対象** (drift 用に wrapper へ passthrough される known 7 field):

- `model` / `model_source` / `effort` / `effort_source` / `permission_mode`
  / `sandbox` / `network_access`

**P1 punt**: `model` / `effort` / `*_source` の runner apply。cli.ts の
`modelSource` / `effortSource` 派生と絡むため phase を分離。

## Design decisions (藤 D1-D5, R1-R2)

- **D1 helper 形**: mode enum を設けず、単一 pure helper
  `applyResumeSnapshot(parsed, snapshot, engine)`。fresh spawn /
  crash restart / rollback では **apply しない** (呼び出し側が snapshot を
  渡さない)。将来 explicit override UI を追加する際は priority API を
  拡張する (今回は作らない)。
- **D2 absent semantics**: snapshot object 自体が absent なら no-op (旧
  server 互換、`entry.parsed` 維持)。snapshot present + 当該 engine 関連
  field absent/invalid なら **engine default へ安全側降格** (Codex:
  `workspace-write` / `false`、Claude: `default`)。**旧 danger 値保持
  禁止**。**explicit `false` 保持** (truthy 判定禁止)。
- **D3 crash-restart race**: P0 は `entry.parsed` 継続。resume_drift の
  可視化は保証しない (runner の resumeSnapshot も stale なら drift 空に
  なり得る)。Claude permission_mode は after_join PermissionModes push が
  補正、Codex privilege は mid-session immutable のため今回対象上は
  問題なし。model / effort race は P1。
- **D4 drift semantics**: engine filter で apply しない field も
  sanitized `resume_snapshot` には保持し、engine-neutral な drift 計算を
  維持。Claude sandbox は permission_mode 写像として意味があるため drift
  対象から除外しない。malformed / unknown は drop + stderr warn、operator
  envelope 通知は scope 外。
- **D5 field scope**: known 7 field だけ sanitized。P0 apply は Codex
  sandbox/network、Claude permission_mode のみ。
- **R1 canonical key normalization (藤 1 次 review 差戻し確定)**: server
  sanitize は入力 map の enumeration 順に依存せず、known field を
  fixed 順で走査。atom / string 両方の key が同一 field に来る場合は
  **string key を優先** (wire canonical)、なければ atom key を読む。
  両方存在で値が異なれば `Logger.warning` で片方採択を明示。出力 key は
  **常に canonical string** — Phoenix JSON relay で `sandbox: ...` と
  `"sandbox" => ...` が潰れて勝者不定になる穴を塞ぐ。priority は
  string-first unconditional (string 側 invalid でも field 全体 drop、
  atom fallback しない) — deterministic pin。
- **R2 whole-malformed shape の閉じ方 (藤 1 次 review 差戻し確定)**:
  `validateResolvedSnapshot(raw)` が null を返す present-but-non-object
  shape に対し、旧 privileged 値を絶対に継承しない。
  - **switch_session**: `#fail(agentId, "error")` で fail-loud reject。
    F4 lock (`#activeSessions`) の delete/add 手前で validation する
    順序に変更、reject 時に lock を変化させない。
  - **reset_session**: 既存 `SessionResetErrorReason` closed vocab
    (`agent_busy` `unsupported_session_reset` `session_reset_pending`
    `runner_unavailable` `spawn_failed` `rollback_failed` `timeout`) に
    schema-level malformed 相当が無いため、**safe-default relaunch** で
    降格 (`nextSnapshot = {}` → applyResumeSnapshot が engine default
    降格) + stderr warn。旧 `entry.parsed` の privileged 値は継承されない。
    藤 R2 の「API 上困難なら safe-default relaunch」許容範囲内から採択。
    語義追加 (`invalid_snapshot` reason 等) が将来必要になれば別 phase。

## Acceptance Criteria

- [x] `protocol/src/index.ts` の `ResetSessionCommand` に
      `resume_snapshot?: ResolvedSnapshotExt` を optional 追加。
      `SwitchSessionMessage` は既に relay 中なので変更不要。
- [x] `server/lib/kaoiro_server/session_pointers.ex` の
      `record_snapshot/2` に closed-enum + boolean sanitizer を追加。
      known 7 field のみ保持、malformed field は drop + `Logger.warning`、
      非 map snapshot は no-op (defensive drop)。**R1: canonical string
      key に normalize** — fixed 順走査 + string 優先 + atom fallback、
      値異なる dup は warn、priority は string-first unconditional。
- [x] `server/lib/kaoiro_server_web/channels/agents_channel.ex` の
      `handle_in("session_reset")` broadcast に
      `|> maybe_put_resume_snapshot(agent_id)` を追加。既存 helper
      (build_restore_payload / switch_session と同じ) を再利用。
- [x] `runner/src/resume_snapshot.ts` を新設し
      `validateResolvedSnapshot(raw)` と `applyResumeSnapshot(parsed,
      snapshot, engine)` の pure helper を追加。
      `validateResolvedSnapshot` は closed-enum / boolean / non-empty-string
      guard、非 object は null。`applyResumeSnapshot` は snapshot=null
      で no-op、engine 別に P0 field を SSOT 上書き、absent/invalid は
      engine default 降格。
- [x] `runner/src/supervisor.ts` の `parseSpawn` の resume_snapshot 経路を
      `validateResolvedSnapshot` 経由に置換。非 object shape は spawn
      全体を fail-loud reject 継続 (既存動作維持)。
- [x] `runner/src/supervisor.ts` の `handleSpawn` の resume 分岐で
      `applyResumeSnapshot(parsed, parsed.resumeSnapshot, parsed.engine)`
      を fire。fresh spawn 分岐は apply しない。
- [x] `runner/src/supervisor.ts` の `handleSwitchSession` の
      `#completeSwitchSession` で payload.resume_snapshot を validate + apply
      し `entry.parsed` を更新。payload に snapshot 無ければ既存
      `entry.parsed.resumeSnapshot` にフォールバック。**R2: whole-malformed
      shape は F4 lock 手前で `#fail(agentId, "error")` fail-loud reject**
      (旧 privileged 値を継承しない)。
- [x] `runner/src/supervisor.ts` の `handleResetSession` で
      payload.resume_snapshot を validate + apply し `entry.parsed` を
      更新してから resumeSessionId strip + child.kill。#relaunchForReset
      は無変更で `entry.parsed` を consume。rollback は reset 時に
      適用済みの `entry.parsed` を保持。**R2: whole-malformed shape は
      safe-default relaunch** (`nextSnapshot = {}` → engine default 降格)
      + stderr warn (旧 privileged 値を継承しない)。
- [x] `runner/src/supervisor.ts` の `resolveWrapperConfig` は既存の
      passthrough を維持。invariant を明示するコメントを追加 (upstream
      で sanitize 済みが保証)。
- [x] `runner/test/supervisor.test.ts` に統合 test を追加
      (initial restore の Codex / Claude apply、fresh spawn 不 apply、
      switch_session apply、reset_session apply、rollback / crash-restart
      の entry.parsed 継承、`network_access=false` explicit 保持、empty
      snapshot での engine default 降格、**R2 whole-malformed switch
      fail-loud / reset safe-default、individual field malformed の
      integration pin**)。関連 runner suite pass。
- [x] `wrapper/codex/test/host.test.ts` に regression pin を追加
      (danger-full-access → ThreadOptions、workspace-write + network=true、
      network_access=false explicit、resume_drift 空)。関連 codex suite pass。
- [x] `wrapper/claude-code/test/host.test.ts` に regression pin を追加
      (permission_mode=bypassPermissions で allowDangerouslySkipPermissions、
      resume_drift 空)。関連 claude-code suite pass。
- [x] `server/test/kaoiro_server/session_pointers_test.exs` に write-side
      sanitize test を追加 (**R1: canonical string key normalize / atom
      + string dup priority / invalid-string 優先 drop / valid string +
      invalid atom priority**)。関連 server suite pass。既存の atom-key
      期待は canonical string key 期待に更新済。
- [x] `server/test/kaoiro_server_web/channels/agents_channel_test.exs` に
      reset broadcast の snapshot 同梱 test を追加 (snapshot 有無で
      `resume_snapshot` 有無が切り替わる)。
- [x] docs: ADR-0014 F1 追補 に「resume 時の privilege 三軸再適用」節を
      追加、ADR-0033 F3 / ADR-0036 F2 は reference で ADR-0014 へ集約。
      `docs/specs/protocol.md` の `reset_session` schema に
      `resume_snapshot?` を追記。
- [x] typecheck (protocol / runner / wrapper 4 pkg workspace) clean、
      `mix format --check-formatted` 対象 file clean、
      svelte-check 0 errors 0 warnings、`git diff --check` clean。
- [x] end-to-end 手動検証 (dogfood): restart → Codex agent が
      danger-full-access + network=true で復元、Claude agent が
      bypassPermissions で復元、`ext.effective` と `ext.resume_snapshot`
      が一致し `ext.resume_drift` が空。マスターによる実機確認で合格。

## Tasks

| id | subject | status | note |
|---|---|---|---|
| 22-1 | protocol: `ResetSessionCommand.resume_snapshot?` | ✅ | types-only |
| 22-2 | server: SessionPointers.record_snapshot sanitizer | ✅ | Logger.warning per drop |
| 22-3 | server: reset_session broadcast に snapshot 同梱 | ✅ | 既存 `maybe_put_resume_snapshot` 再利用 |
| 22-4 | runner: `resume_snapshot.ts` (pure helper) | ✅ | 新規ファイル、pure helper table test |
| 22-5 | runner: parseSpawn の resume_snapshot 経路を sanitize 経由に | ✅ | fail-loud reject 継続 |
| 22-6 | runner: handleSpawn の resume 分岐で apply | ✅ | fresh 分岐は unchanged |
| 22-7 | runner: handleSwitchSession で apply | ✅ | payload snapshot 有無で fallback |
| 22-8 | runner: handleResetSession で apply | ✅ | pendingReset 前に entry.parsed 更新 |
| 22-9 | runner: resolveWrapperConfig invariant コメント | ✅ | passthrough は無変更 |
| 22-10 | runner: 統合 test | ✅ | 5 経路 + safety pin |
| 22-11 | wrapper regression pin (Codex + Claude) | ✅ | ThreadOptions / SDK options / drift 空 |
| 22-12 | docs: ADR-0014 F1 追補 + ADR-0033/0036 参照 + protocol.md | ✅ | ADR 集約 |
| 22-R1 | server: SessionPointers sanitizer を canonical string key へ normalize | ✅ | 藤 1 次 review must-fix。fixed 順走査 + string 優先 + atom fallback、priority test 4 件追加、既存 atom-key 期待を canonical string に更新 |
| 22-R2 | runner: switch/reset の whole-malformed snapshot 対応 | ✅ | 藤 1 次 review must-fix。switch は `#fail(error)` + F4 lock 手前 validate、reset は safe-default relaunch + stderr warn、旧 privileged 値継承なし。integration test 4 件追加 |
| 22-13 | dogfood 手動検証 | ✅ | マスターによる実機確認で合格 |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done.

## Risks

- **privilege persistence の semantics 波及**: 従来は restart 後
  engine default に降格していた挙動を「最後に実効だった値」で復元する
  ように変える。ADR-0036 F2 が /new・/clear で既に採用している契約を
  restore / switch / reset の全経路に波及させるだけで、新規の
  privilege escalation は導入しない。ただし「一度でも danger を許可
  した agent は再起動後も danger のまま」となる。operator UI は既存の
  権限バッジで常時表示済みで、追加 UI 変更は不要。
- **malformed snapshot escalation**: 二重 validation (server write + runner
  read) で塞ぐ。closed-enum に該当しない値は drop + warn。
- **compromised authenticated wrapper の偽 stamp**: closed-enum validation
  は valid enum の偽装まで防げない。既存の「wrapper effective snapshot を
  server が信頼する」設計選択を継承。上位対策は wrapper 実行ホストの
  完全性 (specs/threat-model.md T1)。
- **legacy DETS record (snapshot = nil)**: apply が no-op になり engine
  default で spawn する。resume_drift は空 (両側 unset)。1 リリース
  窓で自然に埋まる。
- **crash-restart race**: crash 直前に mid-session set_permission_mode が
  あり entry.parsed に届く前に crash した場合、次 restart は 1 世代前で
  復元。resume_drift は runner の resumeSnapshot も stale なので保証
  なし。既存の crash 意味論 (直前トランザクションはロス) と整合。
- **atom / string key duplicate の勝者不定 (R1 で解消済み)**: Phoenix
  JSON relay は atom key と string key を同一 output key に潰す一方で
  勝者は enumeration 順依存で非決定的だった。R1 で **canonical string
  key へ fixed 順 normalize + string 優先 priority** に変更し、
  deterministic に。invalid string は field drop で fallback しないため
  優先ルールは常に一方向。
- **whole-malformed snapshot の旧 privileged 値継承 (R2 で解消済み)**:
  validate=null 時に旧 entry.parsed の privileged 値を継承すると、
  攻撃者制御・バグ payload で操作前の danger 値が復元される穴があった。
  R2 で switch は fail-loud、reset は safe-default relaunch (empty
  snapshot → engine default) に修正、旧値継承の経路を絶つ。
- **`ResetSessionCommand` schema 変更の後方互換**: `resume_snapshot?` は
  optional なので旧 runner は無視するだけ。破壊なし。
- **`SessionResetErrorReason` に schema-level malformed reason なし**:
  reset の whole-malformed 対応で `spawn_failed` 流用は語義がずれ、
  silent-drop は timeout 誘発で藤 D3/D2 と矛盾する。safe-default
  relaunch で降格し stderr warn する (藤 R2 明示許容)。将来 `invalid_snapshot`
  等の reason 追加が必要になれば protocol type + server lock 処理 +
  runner sendResetResult の 3 箇所改修を別 phase として起票。
- **P1 model / effort 分離**: restore 直後は engine default (Codex account
  default) に落ちる可能性。UI に「アカウント既定」ラベルが一時的に出る
  ケースを operator に説明する必要 (P1 で解消)。
