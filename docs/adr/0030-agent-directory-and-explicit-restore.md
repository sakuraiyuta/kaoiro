---
title: Persistent agent identity across server restarts and explicit client restore (bulk/individual)
status: accepted
date: 2026-07-06
opened: 2026-07-06
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [12, 14, 21, 23, 24]
---

# ADR-0030 — Persistent agent identity across server restarts and explicit client restore (bulk/individual)

## Status

Accepted (implementation complete 2026-07-06 — phase-11 phase-0..2, manual dogfooding acceptance complete)

## Context

[ADR-0014](0014-session-resume-and-restore.md) defines the agent session restore mechanism
(client → server → runner spawn-with-resume) and persists `SessionPointers`
(`agent_id → {session_id, cwd}`) in DETS. The implemented
`restore` / `resume_disconnected`
([agents_channel.ex](../../server/lib/kaoiro_server_web/channels/agents_channel.ex))
targets disconnected agents and broadcasts spawn + `resume_session_id` to
`runner:<host_id>`. However, the current state is:

- **agent identity (persona) is volatile**:
  `agents_channel.ex agent_persona/1` reads persona from `AgentStates.snapshot()`.
  AgentStates disappears when the server restarts, so persona can no longer be
  included in the restore spawn payload and the resume path across restarts breaks.
- **The client has no way to obtain the list of “known agents”**:
  Immediately after restart, AgentStates is empty, so the UI shows zero agents.
  Until runner/wrapper reconnects on its own, the operator cannot even see what
  can be restored.
- [ADR-0014 A4](0014-session-resume-and-restore.md) establishes the “JSONL
  source of truth”, making response-log persistence ([#24](https://github.com/sakuraiyuta/kaoiro/issues/24)) unnecessary.
  What must persist is only identity (persona) and the fact of existence.

goal: **After the server and runner are both down and restarted, the client’s
“restore previous state” button (bulk / individual) can resume-spawn each agent
that was running until immediately before, using its last session_id**. Restore
is explicit operator action only; it is not automatic ([#41](https://github.com/sakuraiyuta/kaoiro/issues/41)).

## Decision

- **D1 (store split)**: Add a new DETS store, `KaoiroServer.AgentDirectory`,
  holding `agent_id → %{persona, last_seen}`. Keep `SessionPointers` (resume
  pointers, ADR-0014 F1) unchanged. The identity ledger and resume pointers
  are conceptually different, so keep them independent.
- **D2 (write timing, revised by issue #209 D19 — canonical persona is not
  stored in this store at all)**:
  - **At spawn** (`agents_channel.ex handle_in("spawn", ...)`), record
    `persona_id` (stable reference to the pack) and `display_name` (custom name
    for the spawn; if unspecified, a copy of the canonical name at record time,
    persisted at creation) with `AgentDirectory.record/4`. **This is a synchronous
    call (`GenServer.call`; issue #209 D22 corollary — it used to be a fire-and-
    forget `GenServer.cast`) and must complete before the spawn broadcast to the
    runner.** This ordering guarantee structurally closes the race where a
    wrapper joining immediately after spawn reads the uncommitted entry as `nil`
    in `wrapper_channel.ex` after-join `push_persona_sync/2` and silently misses
    the initial sync (unlike the fire-and-forget patterns for `SessionPointers` /
    `PermissionModes`).
  - **On envelope arrival** (AgentStates.put), update `last_seen`.
    `persona_id` is immutable during a session. The canonical persona (pack-
    derived `name` / `sprite_set` and injected personality prompt) is not stored
    in this store at all — resolve it each time by joining `persona_id` with the
    current `PersonaAssets` manifest (restore / directory projection / wrapper
    startup payload all use the same path). **Only `display_name` may be
    overwritten by an explicit rename while running (issue #187 stage 3,
    `AgentDirectory.rename/2`)** — this is an explicit mutation by an operator,
    not implicit synchronization on envelope arrival, and does not change the
    subject fixed by ADR-0029 F9 (the personality prompt derived from a zip
    update).
- **D3 (read substitution)**: Switch `agent_persona/1` to read persona from
  `AgentDirectory.get(agent_id)`. Remove the AgentStates dependency to gain
  restart resilience. Keep the existing restore / resume_disconnected wire
  unchanged.
- **D4 (provide the list to the client)**: Extend the operator-role join
  snapshot path to deliver all AgentDirectory entries (do not add a new topic).
  The client merges them with AgentStates.snapshot() to determine live/offline.
  Do not deliver them to viewers (D10). **The client’s “offline display” combines
  both directory-only entries (no entry in AgentStates, caused by server restart)
  and live disconnected entries (entry exists but state=disconnected, caused by
  wrapper-only disconnect or hot reload), and provides restore UI in one offline
  section — do not branch UX on how the failure appeared (added 2026-07-07).**
- **D5 (restore UX)**: Place two kinds of buttons in the dashboard:
  - **Bulk**: “Restore previous state” in the header or settings menu — fire
    individual resume-spawns sequentially for every offline entry.
  - **Individual**: resume-spawn one agent from its offline agent tile (or detail).
  - Both call the existing `resume_disconnected` wire one agent at a time. Do
    not create a batch-specific wire.
- **D6 (entry lifecycle)**:
  - Add only at spawn time.
  - Update only last_seen on envelope arrival.
  - Delete only by explicit operator action (dashboard operation “delete agent
    from ledger”). Automatic GC is out of the initial scope (future: candidates
    after last_seen exceeds N days, deleted with explicit approval). **Implemented
    2026-07-07**: extend the `delete_agent` handler to accept directory-only
    entries (absent from `AgentStates` and present only in `AgentDirectory`), and
    purge all four stores in one operation: `AgentStates` (memory) +
    `AgentDirectory` + `SessionPointers` + `PermissionModes`. The existing
    disconnected guard in `AgentStates.delete/1` continues to protect live-agent
    deletion (invariant). Operators can explicitly clean up zombie agents that
    cannot be restored (for example, repeated restore-spawn failures due to
    `no_session`).
  - **Note 2026-08-08:** The current purge contract is synchronized with
    `delete_agent` in [protocol](../specs/protocol.md). The targets are the seven
    stores `AgentStates`, `AgentDirectory`, `SessionPointers`, `PermissionModes`,
    `SessionResets`, `SessionStarts`, and `ClearWatermarks`; `InterAgentHistory`
    was removed by [ADR-0051](0051-history-restart-resilience.md). Do not purge
    `TokenDenylist`, which is for permanent revocation.
- **D7 (do not persist host_id)**: Since host_id can always be derived with
  `host_id_of/1` from the agent_id naming convention (ADR-0024 D3
  `<host_id>.<rand>`), persisting host_id separately is unnecessary. Do not
  store it in AgentDirectory.
- **D8 (restore failure handling)**: Reasons restoration cannot proceed (host
  runner offline / persona pack missing / session JSONL missing = ADR-0014 T3
  validation failure) are returned individually to the client in the existing
  `spawn_result` envelope. Bulk restore is best effort (partial success is
  allowed), and the client shows an error on each tile. Do not create a special
  aggregation API. **The client displays the restore button only when
  `envelope.state === "disconnected"`; do not gate it on the presence of
  session_id — the server decides actual restorability (whether a SessionPointer
  exists), and failures surface through spawn_result → sticky icon (added
  2026-07-07).**

  **fresh-restore addendum (phase-25, 2026-07-23)**: A SessionPointer can retain
  cwd / engine / snapshot while only session_id is nil (`/clear` detach = ADR-0036
  F3 addendum / unspoken session = ADR-0014 Q-A4). Previously, server
  `session_pointer/1` required a binary session_id, so the restore button always
  failed with `no_session` → ⚠. Phase-25 rescues this path as **fresh-restore**:
  the server stamps `apply_resume_snapshot: true` on a spawn payload that omits
  `resume_session_id`, and the runner reapplies the snapshot in a fresh branch,
  restarting as a fresh session with the same model / effort / engine /
  permission settings. Details are in [ADR-0014 F1 addendum “fresh-restore for
  pointer without session_id”](0014-session-resume-and-restore.md) and the
  [phase-25 plan](../plans/phase-25-fresh-restore-without-session.md).
  The D8 policy “gate the restore button on disconnected only” is unchanged;
  the principle of not controlling display based on session_id remains after
  fresh-restore is introduced.
- **D9 (prevent duplicate connections)**: Reuse the existing
  `require_disconnected/1` (ADR-0014 F4). Live agents are excluded from restore.
- **D10 (permissions)**: Both listing and restore operations are operator-only
  (reuse the role gate from [ADR-0021](0021-role-information-disclosure-policy.md)).
  Do not return the AgentDirectory-derived offline list to viewers.
- **D11 (rate limit)**: Bulk restore spawns fire synchronously and sequentially
  (a server-side for-loop, broadcast only). No special rate limit is needed —
  actual spawn execution is protected by the runner-side in-flight lock. Revise
  this ADR if this becomes a problem in operation.
- **D12 (global configuration)**: The server currently has no mutable global
  config (everything is externalized to env). This ADR does not include it. Add
  it in a separate ADR if dashboard-driven config appears in the future.

## Consequences

### Positive

- The agent list is no longer empty after server/runner restart, and the
  operator can restore all or individual agents explicitly.
- The goal is achieved while preserving ADR-0014 A4 “JSONL as source of truth”
  (no history persistence is needed).
- Implementation cost is low because it follows the same DETS pattern as the
  existing `SessionPointers` / `PermissionModes` (add a store + spawn hook +
  reference replacement + client delivery + dashboard UI).
- In the resume path, session_id / cwd (SessionPointers) and permission_mode
  (PermissionModes) are already persistent; only the persona is added.

### Negative

- Because the AgentDirectory entry lifecycle (deletion) is delegated to the
  operator, old entries may accumulate over long-term operation. Consider GC in
  the future (D6).
- Bulk restore broadcasts spawns to many runners. Add a rate limit to D11 if
  this becomes a problem in operation.

### Neutral

- “Previous state” consists only of persona + session_id + cwd + permission_mode;
  response logs and internal agent states (idle/thinking, etc.) are not restored,
  consistent with ADR-0014 A4.
- The client determines live/offline by merging AgentDirectory and
  AgentStates.snapshot (the server simply delivers both).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Extend `SessionPointers` to include persona + last_seen | The pointer concept would expand into the identity domain. It does not fit ADR-0014’s wording (“pointers only, no history”). |
| Persist all of AgentStates | It would include volatile envelopes and history, contrary to ADR-0014 A4. |
| Automatically resume after a server crash | Risk of duplicate connections, removes the operator’s decision, and conflicts with the user policy (explicit action). |
| Add a new wire (`bulk_restore`) for bulk restore | Redundant because the existing restore / resume_disconnected can simply be called one agent at a time. |
| Automatically GC entries (delete after N days) | Could confuse operators in the initial scope; a future option. |
| Include it as phase-3 of ADR-0014 | ADR-0014 is the resume mechanism itself; this is conceptually separate identity persistence + UX. |

## Implementation phases (roadmap, to be split out when planning)

- **phase-0**: Add the `AgentDirectory` GenServer + DETS, spawn / envelope-arrival
  hooks, replace `agent_persona/1`, and add tests (reuse the `SessionPointers`
  test template).
- **phase-1**: Deliver AgentDirectory in the operator-role join snapshot and
  implement client-side merging with AgentStates to determine live/offline.
- **phase-2**: Add individual restore buttons (offline agent tile) and a bulk
  restore button (header) to the dashboard, and display `spawn_result` errors in
  the UI.
- **phase-3** (future): Add entry deletion UI and track the merits of last_seen-
  based GC in an issue.

## Related

- Dependency ADRs: [0014](0014-session-resume-and-restore.md) (resume mechanism
  itself, pointer persistence), [0024](0024-agent-instance-identity-and-spawn-auth.md)
  (derive host_id from the agent_id naming convention)
- Referenced ADRs: [0012](0012-response-display-and-dashboard-scope.md) (A4 JSONL
  source-of-truth policy), [0021](0021-role-information-disclosure-policy.md)
  (operator role gate), [0023](0023-host-runner-architecture.md) (runner is the
  spawn executor)
- Related issues:
  [#41](https://github.com/sakuraiyuta/kaoiro/issues/41) (resolved by this ADR),
  [#24](https://github.com/sakuraiyuta/kaoiro/issues/24) (decision to give up),
  [#88](https://github.com/sakuraiyuta/kaoiro/issues/88) (the same pattern for
  future per-persona setting persistence)
- Related specs: [protocol](../specs/protocol.md) (spawn / resume path),
  [architecture](../specs/architecture.md)
