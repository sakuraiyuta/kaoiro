---
title: Phase 11 — サーバ再起動越しの agent identity 永続と明示復元(一括/個別)
description: ADR-0030 実装 phase。AgentDirectory DETS store 追加 + spawn hook + agent_persona/1 差替 + client 一覧配信 + dashboard 一括/個別復元 UI。
status: done
phase: 11
depends_on: [phase-3-server-multiagent, phase-4-host-runner]
last_updated: 2026-07-07
---

# Phase 11 — サーバ再起動越しの agent identity 永続と明示復元

## Goal

[ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) に基づき、
server + runner ダウン後に client 明示操作(一括 / 個別)で agent を最後の
session_id で resume-spawn できるようにする。gap は persona の永続化 1 点。

## Acceptance Criteria

- [x] `KaoiroServer.AgentDirectory` GenServer(DETS backed)が
  `agent_id → %{persona}` を保持する
- [x] spawn 成功時に fire-and-forget で persona を記録する
- [x] envelope 到着時に last_seen(memory-only)を更新する
- [x] `agent_persona/1`
  ([agents_channel.ex](../../server/lib/kaoiro_server_web/channels/agents_channel.ex))
  が AgentDirectory を参照する。AgentStates が空でも restore 経路が成立
- [x] operator role の join snapshot(`agents:lobby`)に AgentDirectory の
  全 entry が含まれる
- [x] dashboard は AgentStates(live)と AgentDirectory(known)を merge し、
  offline 表示のエージェントに個別復元ボタンを、ヘッダに一括復元ボタンを
  提供する
- [x] server + runner 再起動 → 一括復元 → 全 agent が最後の session_id で
  復帰する end-to-end フローが手動 dogfooding で成立(2026-07-06 検収)

## Tasks

### Stage phase-0(server 基盤)

| # | Task | Status | Notes |
|---|------|--------|-------|
| A-1 | `AgentDirectory` GenServer + DETS 追加 | ✅ | `SessionPointers` / `PermissionModes` template 流用 |
| A-2 | `application.ex` 監督ツリーに登録 | ✅ | |
| A-3 | `runtime.exs` に `KAOIRO_AGENT_DIRECTORY_PATH` 追加 | ✅ | test.exs にも throwaway path を追加 |
| A-4 | spawn 成功時に `AgentDirectory.record` を呼ぶ | ✅ | `agents_channel.ex build_spawn_payload/4` 直後 |
| A-5 | envelope 到着時に `AgentDirectory.touch` を呼ぶ | ✅ | `wrapper_channel.ex handle_in("envelope", ...)` success 経路 |
| A-6 | `agent_persona/1` を AgentDirectory 参照に切替 | ✅ | restore/resume_session 経路用に `fetch_restorable_agent_id/1` も追加(AgentStates.known? OR AgentDirectory) |
| A-7 | `agent_directory_test.exs` | ✅ | 7 tests、SessionPointers テスト template 流用 |
| A-8 | `agents_channel_test.exs` に「AgentStates 空でも restore が成立」テスト追加 | ✅ | server 再起動シナリオ、`disconnect_with_session/2` も AgentDirectory seed するよう更新 |
| A-9 | mix format / mix test 通過 | ✅ | 285 tests all pass |

### Stage phase-1(client 配信)

| # | Task | Status | Notes |
|---|------|--------|-------|
| B-1 | operator join snapshot に `directory` を push する | ✅ | `agents_channel.ex` after_join、既存 `hosts` push の隣 |
| B-2 | protocol types 更新(dashboard 側)| ✅ | `DirectoryEntry`、`onDirectory`、`parseDirectory` |
| B-3 | dashboard に live/offline merge ロジック追加 | ⏳ | UI 実装(phase-2)と一体化のため次 phase へ移動 |
| B-4 | server test | ✅ | operator 受信 / viewer 非受信 の 2 ケース |

### Stage phase-2(dashboard 復元 UI、HITL)

| # | Task | Status | Notes |
|---|------|--------|-------|
| C-1 | 一括復元ボタン配置と UX 決定 | ✅ | offline `<details>` の summary 内、confirm dialog あり |
| C-2 | 個別復元ボタン配置 | ✅ | offline tile 上に明示表示(既存 restore ボタン再利用、`directoryOnly` prop で session_id gate 解除) |
| C-3 | spawn_result エラー UI 反映 | ✅ | tile 右上に ⚠ icon + tooltip、次 live envelope or 成功で clear |
| C-4 | dashboard test | ✅ | `parseDirectory` unit test 4 ケース(vitest 71 tests all pass) |

追加実装:

- `directoryOnly` prop 時は tile の `.open` ボタンを disabled 化(a11y:
  「詳細を開く」affordance を出さない、review-cycle round 1 advisory 反映)。
- offline 視覚は半透明(`opacity: 0.7`)+ 「offline」ラベル。
- live disconnected と directory-only は同じ disconnected 状態表示で統合
  (grayscale スプライト、ADR-0030 承認済 UX)。
- **2026-07-07 追加**: offline セクションを directory-only(サーバ再起動起因)
  だけでなく live disconnected(wrapper 単独切断・ホットリロード起因)も
  集約するよう拡張([App.svelte](../../dashboard/src/App.svelte) の
  `sorted` は state=disconnected を除外、`offlineEntries` は両者を merge)。
  併せて [AgentCard.svelte](../../dashboard/src/lib/AgentCard.svelte) と
  [AgentDetail.svelte](../../dashboard/src/lib/AgentDetail.svelte) の
  `canRestore` から session_id gate を撤去し、復元可否はサーバの
  SessionPointer 判定に一任(ADR-0030 D4 / D8 の追記に対応)。

### Stage phase-3(GC / 削除 UI)

- [x] entry 削除 UI(operator 明示、2026-07-07 実装)—
  `delete_agent` handler を directory-only entry も受け付けるよう拡張、
  `AgentStates` (memory) + `AgentDirectory` + `SessionPointers` +
  `PermissionModes` の 4 store を一括 purge。client 側は offline
  セクションの directory-only タイルにも削除ボタンを表示、confirm
  ダイアログは「保存された persona / session ポインタ / permission_mode
  も破棄され、以後この agent_id は復元できなくなります」と明示。
  復元不可なゾンビ(`no_session` 等の spawn_result エラーで復元 spawn が
  繰り返し失敗するケース)を operator が掃除できる(ADR-0030 D6)。
- last_seen 経過による GC の是非(現状スコープ外、issue で追跡)

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Open Questions Blocking This Phase

なし([ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) で解決)。

## See Also

- ADR: [0030](../adr/0030-agent-directory-and-explicit-restore.md)、
  [0014](../adr/0014-session-resume-and-restore.md)、
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)
- 関連 issue:
  [#41](https://github.com/sakuraiyuta/kaoiro/issues/41)、
  [#24](https://github.com/sakuraiyuta/kaoiro/issues/24)
- Previous: [phase-4-host-runner](phase-4-host-runner.md)
