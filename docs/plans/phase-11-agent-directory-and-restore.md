---
title: Phase 11 — Persistent Agent Identity Across Server Restarts and Explicit Restore (Bulk/Individual)
description: ADR-0030 implementation phase. Add the AgentDirectory DETS store + spawn hook + replace agent_persona/1 + client directory distribution + dashboard bulk/individual restore UI.
status: done
phase: 11
depends_on: [phase-3-server-multiagent, phase-4-host-runner]
last_updated: 2026-07-07
---

# Phase 11 — Persistent Agent Identity Across Server Restarts and Explicit Restore

## Goal

Based on [ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md), enable
the client to resume-spawn agents with their last session_id through explicit
bulk / individual actions after the server + runner go down. The only gap is
persona persistence.

## Acceptance Criteria

- [x] `KaoiroServer.AgentDirectory` GenServer (DETS-backed) retains
  `agent_id → %{persona}`
- [x] Record the persona fire-and-forget when spawn succeeds
- [x] Update last_seen (memory-only) when an envelope arrives
- [x] `agent_persona/1`
  ([agents_channel.ex](../../server/lib/kaoiro_server_web/channels/agents_channel.ex))
  references AgentDirectory. The restore path works even when AgentStates is empty
- [x] The operator-role join snapshot (`agents:lobby`) includes every AgentDirectory
  entry
- [x] The dashboard merges AgentStates (live) with AgentDirectory (known), provides
  an individual restore button for agents shown offline, and a bulk restore button
  in the header
- [x] The end-to-end flow server + runner restart → bulk restore → all agents return
  with their last session_id was established through manual dogfooding (accepted
  2026-07-06)

## Tasks

### Stage phase-0 (server foundation)

| # | Task | Status | Notes |
|---|------|--------|-------|
| A-1 | Add `AgentDirectory` GenServer + DETS | ✅ | Reuse the `SessionPointers` / `PermissionModes` template |
| A-2 | Register it in the `application.ex` supervision tree | ✅ | |
| A-3 | Add `KAOIRO_AGENT_DIRECTORY_PATH` to `runtime.exs` | ✅ | Add a throwaway path to test.exs as well |
| A-4 | Call `AgentDirectory.record` when spawn succeeds | ✅ | Immediately after `agents_channel.ex build_spawn_payload/4` |
| A-5 | Call `AgentDirectory.touch` when an envelope arrives | ✅ | Success path of `wrapper_channel.ex handle_in("envelope", ...)` |
| A-6 | Switch `agent_persona/1` to reference AgentDirectory | ✅ | Also add `fetch_restorable_agent_id/1` for the restore/resume_session path (AgentStates.known? OR AgentDirectory) |
| A-7 | `agent_directory_test.exs` | ✅ | 7 tests; reuse the SessionPointers test template |
| A-8 | Add a “restore works even when AgentStates is empty” test to `agents_channel_test.exs` | ✅ | Server restart scenario; update `disconnect_with_session/2` to seed AgentDirectory as well |
| A-9 | Pass mix format / mix test | ✅ | All 285 tests pass |

### Stage phase-1 (client distribution)

| # | Task | Status | Notes |
|---|------|--------|-------|
| B-1 | Push `directory` in the operator join snapshot | ✅ | `agents_channel.ex` after_join, next to the existing `hosts` push |
| B-2 | Update protocol types (dashboard side) | ✅ | `DirectoryEntry`, `onDirectory`, `parseDirectory` |
| B-3 | Add live/offline merge logic to the dashboard | ⏳ | Moved to the next phase to integrate with the UI implementation (phase-2) |
| B-4 | Server test | ✅ | Two cases: operator receives / viewer does not receive |

### Stage phase-2 (dashboard restore UI, HITL)

| # | Task | Status | Notes |
|---|------|--------|-------|
| C-1 | Place the bulk restore button and decide the UX | ✅ | Inside the offline `<details>` summary, with a confirm dialog |
| C-2 | Place individual restore buttons | ✅ | Explicitly on offline tiles (reuse the existing restore button; release the session_id gate with the `directoryOnly` prop) |
| C-3 | Reflect spawn_result errors in the UI | ✅ | ⚠ icon + tooltip at the tile's upper right; clear on the next live envelope or success |
| C-4 | Dashboard test | ✅ | 4 `parseDirectory` unit-test cases (all 71 vitest tests pass) |

Additional implementation:

- When the `directoryOnly` prop is set, disable the tile's `.open` button (a11y:
  do not expose the “open details” affordance; reflects the round-1 review-cycle
  advisory).
- Show offline visually as translucent (`opacity: 0.7`) + an “offline” label.
- Integrate live disconnected and directory-only into the same disconnected-state
  display (grayscale sprite, UX approved by ADR-0030).
- **Added 2026-07-07**: Extend the offline section to aggregate not only
  directory-only entries (caused by server restart) but also live disconnected
  entries (caused by wrapper-only disconnection or hot reload) ([App.svelte](../../dashboard/src/App.svelte)'s
  `sorted` excludes state=disconnected, and `offlineEntries` merges both).
  Also remove the session_id gate from `canRestore` in
  [AgentCard.svelte](../../dashboard/src/lib/AgentCard.svelte) and
  [AgentDetail.svelte](../../dashboard/src/lib/AgentDetail.svelte), leaving
  restore eligibility to the server's SessionPointer decision (corresponding to
  the addition to ADR-0030 D4 / D8).

### Stage phase-3 (GC / deletion UI)

- [x] Entry deletion UI (explicit operator action, implemented 2026-07-07)—
  extend the `delete_agent` handler to accept directory-only entries as well, and
  purge all four stores at once: `AgentStates` (memory) + `AgentDirectory` +
  `SessionPointers` + `PermissionModes`. On the client side, show a delete button
  on directory-only tiles in the offline section; the confirm dialog explicitly
  states that “the saved persona / session pointer / permission_mode will also be
  discarded, and this agent_id can no longer be restored.” The operator can clean
  up unrestoreable zombies (cases where restore spawn repeatedly fails with
  spawn_result errors such as `no_session`) (ADR-0030 D6).
- Whether to GC based on elapsed last_seen (currently out of scope, tracked in an
  issue)

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

## Open Questions Blocking This Phase

None (resolved in [ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md)).

## See Also

- ADR: [0030](../adr/0030-agent-directory-and-explicit-restore.md),
  [0014](../adr/0014-session-resume-and-restore.md),
  [0024](../adr/0024-agent-instance-identity-and-spawn-auth.md)
- Related issues:
  [#41](https://github.com/sakuraiyuta/kaoiro/issues/41),
  [#24](https://github.com/sakuraiyuta/kaoiro/issues/24)
- Previous: [phase-4-host-runner](phase-4-host-runner.md)
