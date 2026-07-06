---
title: Phase 11 — サーバ再起動越しの agent identity 永続と明示復元(一括/個別)
description: ADR-0030 実装 phase。AgentDirectory DETS store 追加 + spawn hook + agent_persona/1 差替 + client 一覧配信 + dashboard 一括/個別復元 UI。
status: in_progress
phase: 11
depends_on: [phase-3-server-multiagent, phase-4-host-runner]
last_updated: 2026-07-06
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
- [ ] operator role の join snapshot(`agents:lobby`)に AgentDirectory の
  全 entry が含まれる
- [ ] dashboard は AgentStates(live)と AgentDirectory(known)を merge し、
  offline 表示のエージェントに個別復元ボタンを、ヘッダに一括復元ボタンを
  提供する
- [ ] server + runner 再起動 → 一括復元 → 全 agent が最後の session_id で
  復帰する end-to-end フローが手動 dogfooding で成立

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
| B-1 | operator join snapshot に `directory` を push する | ⏳ | `agents_channel.ex` after_join |
| B-2 | protocol types 更新(dashboard 側)| ⏳ | `server/assets/src/lib/protocol.ts` |
| B-3 | dashboard に live/offline merge ロジック追加 | ⏳ | offline 表示は persona で描画 |
| B-4 | server test + dashboard test | ⏳ | |

### Stage phase-2(dashboard 復元 UI、HITL)

| # | Task | Status | Notes |
|---|------|--------|-------|
| C-1 | 一括復元ボタン配置と UX 決定 | ⏳ | **HITL**: ヘッダ / メニュー / 確認 dialog の要否 |
| C-2 | 個別復元ボタン配置 | ⏳ | **HITL**: offline tile / detail どちら |
| C-3 | spawn_result エラー UI 反映 | ⏳ | |
| C-4 | dashboard test | ⏳ | |

### Stage phase-3(将来、GC / 削除 UI)

- entry 削除 UI(operator 明示)
- last_seen 経過による GC の是非(現状スコープ外、issue で追跡)

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Open Questions Blocking This Phase

なし([ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) で解決)。

## See Also

- ADR: [0030](../adr/0030-agent-directory-and-explicit-restore.md)、
  [0014](../adr/0014-session-resume-and-restore.md)、
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)
- 関連 issue:
  [#41](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/41)、
  [#24](https://gitea.example.invalid/sakurai.yuta/kaoiro/issues/24)
- Previous: [phase-4-host-runner](phase-4-host-runner.md)
