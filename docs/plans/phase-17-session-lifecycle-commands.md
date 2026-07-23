---
title: Phase 17 — /new・/clear session lifecycle commands
description: /new・/clearをengine promptではなく第一級controlとして扱い、同一agentのfresh session生成、表示projection差、resume可能性、capability、busy拒否を実装する。
status: completed
phase: 17
depends_on: [phase-15-wrapper-ux-parity]
last_updated: 2026-07-13

---

# Phase 17 — /new・/clear session lifecycle commands

## Goal

[ADR-0036](../adr/0036-session-lifecycle-commands.md)を実装し、同じagent/persona/cwdの
ままfresh SDK sessionへ切り替えられるようにする。`/new`・`/clear`は表示logを保持して境界を
示す。旧session fileは保持し、既存
session pickerからresumeできる。

実装着手はphase-15 initial完了後。phase-16とphase-17のどちらを先に実装するかは、
phase-15完了時の状況を見てマスターが決める。相互depends_onは置かない。

## Acceptance Criteria

- [ ] Composerのattachment無しexact `/new`・`/clear`が通常instructionでなく
      `session_reset` control eventになる。引数付き/複数行は誤interceptしない。
- [ ] 旧/外部clientがexact reserved commandを`send_instruction`へ送ってもserverが
      `reserved_session_command`でrejectし、engineへ一度も渡らない。
- [ ] operator-only、live agent、capability、state、pending重複をserverがvalidation
      し、受付とcompletion/failureをrequest IDで相関する。
- [ ] resetは同じagent entryをkill + fresh relaunchし、Claudeはresumeなしquery、
      Codexは`startThread()`を使う。persona/cwd/engineを維持し、model/effort/
      permission/sandbox/network等はphase-15 D8と同じ最後のeffective snapshotを使う。
- [ ] `/new`後も既存表示logが残り、session boundary marker以降へ新sessionのlogが
      追加される。
- [ ] `/clear`完了時にserver AgentStates ringと全client表示が消え、先頭にboundary
      markerが表示される。再接続しても旧表示logが復活しない。
- [ ] どちらのmodeも旧Claude JSONL/Codex rolloutを削除せず、session pickerから
      旧sessionをresumeしてhistory projectionを再構築できる。
- [ ] `SessionPointers`がreset時にsession IDだけをnilへ明示detachしcwd/engineを保持。
      fresh session ID報告後に最新pointerを更新する。pointer stackは追加しない。
- [ ] `supports_session_reset` / `session_reset_modes`をspawn直後からstampし、UIは
      engine名で分岐しない。supports=true時のmodesは必須・非空。未stamp/false、
      true+未指定/空はfail-closedし、stamp testでinvalid組合せを検出する。
- [ ] `idle|waiting_input`以外のresetは`agent_busy`で即時reject。自動interruptも
      queueも行わない。明示interrupt後の再送は成功する。
- [ ] reset pending中のinstruction/model/effort/重複resetをrejectし、stale resultを
      request ID/generationで無視する。旧rolloutの遅延event、pending
      tool/question/permission correlationも新sessionへ混入しない。
- [ ] runner unavailable/spawn failure/timeoutをloud表示し、旧sessionへsilent resume
      しない。fresh relaunch失敗時は旧sessionへ明示的にatomic rollbackし、UI history、
      boundary、pointerを変更しない。rollbackも失敗した場合だけdisconnectedになる。
- [ ] Codexのfresh `startThread()`でrollout/thread IDがいつ確定するかを実測する。
      lazy確定時はfresh wrapper接続後のboundaryで`to_session_id=null`を許し、最初の
      ID報告でpointer/markerを同じrequest IDへ確定する。
- [ ] operator/viewer情報境界を維持し、viewerへ旧/new session IDを露出しない。
- [ ] protocol、server、runner、両wrapper、dashboardのunit/integration/E2E testが通る。

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 17-1 | protocolへsession reset control/result/broadcast型とclosed error vocabularyを追加 | ✅ | operator-only、request ID相関 |
| 17-2 | session capabilityへ`supports_session_reset` / `session_reset_modes`を追加 | ✅ | ADR-0034拡張、spawn直後stamp、fail-closed。chunk α では両 adapter とも false stamp、fresh relaunch 実装完了時 (17-6) に true + [\"new\",\"clear\"] へ flip 予定 |
| 17-3 | `SessionPointers.detach_session/1`相当を同期実装 | ✅ | session_id=nil、cwd/engine保持。recordのmerge semanticsは維持。cwd/engine に加えて snapshot も保持 (fresh relaunch の drift 誤検出防止) |
| 17-4 | serverにvalidation、pending lock、reserved instruction reject、result処理を追加 | ✅ | lifecycle orchestrationのSSOT。SessionResets 新規 GenServer で TOCTOU 芯 (単一 handle_call) と async state-report lag 保護 (2s cooldown + viewer 除外)、intercept + handle_out で session_reset_* を operator-only gate、runner の agent_id host binding は exact match (nested-prefix spoof 防止) |
| 17-5 | runner supervisorにsame-agent fresh relaunchと旧session rollbackを追加 | ✅ | resume IDなしで試行、失敗時だけ旧IDを明示resume。phase-15 D8の最後のeffective snapshotを再適用。director must 2 点織り込み: (1) rollback previous_session_id は server 由来 (payload)、runner の spawn 時値に依存しない。(2) F2 「接続確認」文言準拠で server 側 two-phase (SessionResets の `:spawning` → `:awaiting_connect` → `confirm_connection/2` at wrapper join)。ChildEntry.pendingReset に oldResumeSessionId を含め、handleSwitchSession と同じ atomic delete + add で F4 lock を transfer (review round 1 finding 対応) |
| 17-6 | Claude/Codexでfresh session開始をintegration test | ✅ | Claude query resumeなし / Codex startThread。両 adapter の supports_session_reset を `false → true + ["new","clear"]` に flip。両 test の toEqual assertion 反映。ID確定時点・同process連続生成・event隔離の実測項目は integration 手動確認 (Codex thread ID lazy 採番は to_session_id=null で許容、fresh session の初回 envelope で SessionPointers.record 経由で pointer が確定)。dashboard Composer intercept は δ (17-8) で追加、γ では adapter flip は dark-launch 維持 (UI 発火経路が無い) |
| 17-7 | AgentStatesに session boundary append を追加 | ✅ | #109 確定仕様で両 mode は既存 history 末尾へ marker を append。表示 reset / IA purge は行わない。 |
| 17-8 | Composer exact command interceptとlocal slash completion mergeを実装 | ✅ | capability/modes判定、attachment時はresetしない。`shouldInterceptAsSessionReset` helper を protocol.ts に抽出 (exact `/new`・`/clear` + attachment 空 + capability=on 判定、fail-closed)、AgentDetail の send 経路で intercept。slash completion pool に capability=on 時のみ kaoiro-local `/new`・`/clear` を merge (エンジン報告 slash と de-dupe、engine が同名 command を報告しても kaoiro-local が先で intercept 優先) |
| 17-9 | started/completed/failed/boundary UIとbusy errorを実装 | ✅ | reset中composer操作をdisable。「新しいsessionを開始中」を表示。App.svelte に 3 handler bind + `sessionResets` state (agent_id → mode)、AgentDetail に resetMode prop 伝搬。resetMode !== null で textarea + submit disable + placeholder swap + reset-progress banner、failed は showNotice で loud (closed vocab reason 明示)。transcript 内で env.type === "session_boundary" 分岐、operator は request_id 短縮 + tooltip で ID 群、viewer は mode のみで divider 表示 |
| 17-10 | old session picker/resumeのregression testを追加 | ✅ | pointer stackなし、host files SSOT。detach_session が session_id=nil + cwd/engine/snapshot 保持 (γ 17-3)、fresh session の初回 envelope で record 経由で新 pointer に上書き、既存 resume_session (ADR-0014 F2/F3/A4 継続) で旧 session に戻れる。session_pointers_test に detach + reattach の DETS 越し永続確認、agents_channel_test に resume_session の SessionPointer 一致確認 |
| 17-11 | race/failure testを追加 | ✅ | instruction競合、double reset、旧event、spawn failure、rollback成功/失敗、timeout。**15-8 Finding 1/2 同型穴の phase-17 版**を追加: wrapper_channel_test に「pending stash 有り envelope で patch fire、無し envelope は noop」の 2 case (order independence)、agents_channel_test に「reset pending 中の resume_session は session_reset_pending で reject」(ADR-0036 F2 の列挙漏れを追補で塞ぐ)。既存 test で double reset / instruction / model / effort / permission_mode / timeout / spawn_failed → rollback / rollback_failed は既に cover 済み |
| 17-12 | specs/運用docsを更新し全regression testを実行 | ✅ | protocol/architecture/threat-model 更新。protocol.md の type table に `session_boundary` 追加、方向別 table に `session_reset` / `session_reset_started/completed/failed` / `reset_session` / `session_reset_result` を追加。architecture.md に `SessionResets` GenServer + `confirm_connection` two-phase + `AgentStates.pending_boundary_patch` を明記。threat-model.md に **session_reset 防御 6 レイヤ** (operator-only / capability advertise / host binding exact match / reserved_session_command reject / SessionResets pending lock / viewer 情報境界) を新設。ADR-0036 F2 に resume_session 追補。両engine実機の検収はマスター + director で phase-17 完走後に実施予定 |
| 17-13 | `/clear` の IA 表示仕様を更新 | ✅ | #109 確定仕様で `/clear` は IA を含む表示を維持。過去 IA を隠すのは operator `clear_history` のみ。 |

Status legend: ⏳ not started, 🟡 mostly done, ⚠ partial, ✅ done, ⛔ blocked.

## Non-goals

- 旧session fileの物理削除。
- server側previous-session stackや専用「戻る」ボタン。
- busy resetの自動interrupt/queue。
- engine native slash command parserの再実装。
- phase-16 model switchの実装。実装順だけ着手時に調整する。

## Open Questions Blocking This Phase

なし。architecture判断はADR-0036で確定する。phase-16との着手順はresource schedulingで
あり、設計blockerではない。

## Followups (phase-17 完走後、2026-07-12)

- **実測項目 3 点** (Codex thread ID 確定タイミング / 同 process 連続生成 /
  旧 event 隔離): γ 17-6 実装時点は「実装 assumption」として coded、
  実測は ε 完走後の実地検収で確認、findings が出れば
  [ADR-0036](../adr/0036-session-lifecycle-commands.md) Implementation
  セクションに追記する運用 (γ で追補済み)
- **boundary_patched の即時 broadcast**: 裁定 2 意図的決定で不採用
  (Codex lazy 采番後の to_session_id patch は server 側 SoT に反映、
  接続中 client への即時 push はせず再取得時反映)。dogfooding で不便
  なら followup として `boundary_patched` broadcast を検討
- **error state からの reset 受理**: ADR-0036 F6 MVP は idle /
  waiting_input のみ受理、error からの reset は他の非 idle と同様
  reject。errorからの reset 受理は旧 process / rollback semantics を
  実測した後の将来拡張候補
- **rollback 経路の人為的 spawn 失敗試験**: ε 完走後の検収では含めず、
  将来 followup で

## 実地検収記録 (2026-07-12、マスター + director で実施 → phase close)

- **/new・/clear のハッピー経路: 確認 OK** (マスター実操作、Codex agent もも
  ほかで両 mode の boundary marker / fresh session 開始を確認)。
- **検収中の finding**: live-agent の左ペイン「別のセッションから再開…」が
  runner の T3 再検証 (`supervisor.ts:457` `#sessionExists`) で失敗
  (Codex で再現、起動 UI の restore 経路は正常) →
  [#104](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/104)
  (bug / priority-medium) として起票、本 phase の外で対応。
- **拒否経路 / viewer 境界の実操作検収**: 実稼働で問題が出た時に対応と
  マスター判断 (unit test では全経路カバー済み)。
- **マスター決定: phase-17 はこれで close。以後の修正は別 issue / plan を
  起こして対応する。**

## See Also

- Decision: [ADR-0036](../adr/0036-session-lifecycle-commands.md)
- Related: [ADR-0014](../adr/0014-session-resume-and-restore.md) / [ADR-0034](../adr/0034-session-capabilities-advertisement.md)
- Previous prerequisite: [phase-15-wrapper-ux-parity](phase-15-wrapper-ux-parity.md)
