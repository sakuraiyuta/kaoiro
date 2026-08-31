---
title: server reboot agent identity persistent and client explicit recovery (b)/individual)
status: accepted
date: 2026-07-06
opened: 2026-07-06
supersedes: []
superseded_by: null
related_specs: [protocol, architecture]
related_adrs: [12, 14, 21, 23, 24]
---

# ADR-0030 — server reboot transceiver agent identity persistence and client explicit recovery (b /individual)

## Status

Accepted (completed 2026 -06 — phase-11 phase-0..2, manual dogfooding inspection)

## Context

[ADR-0014](0014-session-resume-and-restore.md) is the agent's session recovery mechanism.
(client → server →   spawn-with-resume)
(`agent_id → {session_id, cwd}`) was persisted with DETS. implemented
`restore` / `resume_disconnected`
([agents_channel.ex](../../server/lib/kaoiro_server_web/channels/agents_channel.ex))
spawn + `resume_session_id`
`runner:<host_id>` However:

- **Agent identity (persona) volatile**:
`agents_channel.ex agent_persona/1` from `AgentStates.snapshot()` to persona
Read More The agent spas disappears in the server restart, so the restore spawn payload
The resume route that straddles the reboot is broken.
- **Specify "known agent list" acquisition method from client side**:
If you need to reboot, the Agentdisplays is empty = 0  /wrapper
Until the auto reconnection comes, the operator cannot be able to restore operations.
- [ADR-0014 A4](0014-session-resume-and-restore.md)by JSONL
[#24](https://github.com/sakuraiyuta/kaoiro/issues/24) Only identity and existence facts should be persistent.

goal: **cli and   are restarted at the same time, and then client's last
"Restore state" button operation (b  / individual), each agen that moved to the last minute
You can resume-spawn with last session id**. restore only the operator explicitly,
[#41](https://github.com/sakuraiyuta/kaoiro/issues/41)

## Decision

- **D1(store split)**: Add new DETS store `KaoiroServer.AgentDirectory`
`agent_id → %{persona, last_seen}` `SessionPointers`
ADR-0014 F1) identity ledger and resume pointer separate concept
so independent.
- **Revised by D2 (written timing, issue #209 D19) — canonical persona
not in this store)**:
  - **spawn time**`persona_id`
(spawn custom name,
Copy of canonical name at record if not specified — when created
`AgentDirectory.record/4`. **Sync call
(`GenServer.call`, issue #209 D22 corollary — Previously fire-and-forget
and spawn broadcast to spa
Complete before. spawn wrapper
`wrapper_channel.ex` `push_persona_sync/2`
read entry as `nil` and take off the first race
Structurally closed order warranty (`SessionPointers` / `PermissionModes`)
of fire-and-forget).
  - **envel  upon arrival**update `last_seen` to (Agent s.put).
`persona_id` does not change during the session. canonical persona
`name` / `sprite_set`, injected personality prompt)
Don’t save to this store — every time `persona_id` is present `PersonaAssets`
restore / directory projection
wrapper startup payload).DE0
by rename(issue #187 step 3, `AgentDirectory.rename/2`)
overwrite** — this is not an implicit  with envel  arrival
ADR-0029 F9 is an explicit mu  by the operator operation.
If you change the target (zip update origin personality prompt),

- **D3**`agent_persona/1`
persona Switch to reference. Remove Agent s dependencies and get restart resistance. Existing
restore / resume disconnected
- **D4**: server is a role operator join snapshot path
expands and distributes all entries of AgentDirectory (not adding new topics).
client is merged with Agent lives.snapshot() to determine live/offline.
Do not send to viewer (D10). "offline display" on client side is directory-only
(Agent entrys entry, = server restart) and disconnected
(the state=disconnected, = wrapper alone, due to hot reload)
integration and provide a restore UI in one offline section — of failure
Don’tUX UX on the way out (appended 2026 ). Home
- **D5 (Restore UX)**: dashboard two buttons in dashboard:
  - ****: "Restore previous state" in the header or setting menu — offline entry
Each resume-spawn is fired se tially.
  - **Individual**: offline only one from the agent tile (or details) in the display
    resume-spawn.
- Both call existing `resume_disconnected` wire one by one. B
No wire.
- **D6(entry lifecycle)**:
- Added: spawn only.
- Update: only last seen when envel  arrives.
- Delete: only remove the agent from the ledger on Dashboard
operation). Auto GC is not in the initial scope (in the future: last seen is not exceeded N days,
Delete by explicit approval).**2026  **`delete_agent` handler
directory-only entry
`AgentStates`
`SessionPointers` + `PermissionModes`
`AgentStates.delete/1`
(unchanged) z e agent (`no_session`)
The operator can explicitly clean the restore spawn (the case where the failure is repeated).
  - **2026 08 Note:**[protocol](../specs/protocol.md)
to `delete_agent`. `AgentStates`, `AgentDirectory`,
    `SessionPointers`,`PermissionModes`,`SessionResets`,`SessionStarts`,
`ClearWatermarks`
[ADR-0051](0051-history-restart-resilience.md) For permanent revoke
`TokenDenylist` does not purge.
- **D7(host id non-permanent)**: Agent id
to `host_id_of/1`, so host id is not required.
AgentDirectory does not store.
- **D8 (Restore failure handling)**: Unrecoverable factors (host   offline /
persona pack missing / session JSONL missing = ADR-0014
Return to client with existing `spawn_result` envel . B  Restoration is Best
Error display on each tile. Special ag ation API
Don't make it. **Restore button display is `envelope.state === "disconnected"` on client side
not gate with session id.
existence) is assigned to determining the debug side, and fail is spawn re t → sticky icon
surface (appended 2026. ). Home

  **Fresh-restore (phase-25, 2026 -23)**: SessionPointer
cwd / engine / snapshot
(`/clear` detach = ADR-0036 F3 supplementary / unissued session = ADR-0014 Q-A4)
Comment `session_pointer/1` of server is binary session id.
The recovery button is always failing with `no_session` → ⚠. phase-25
This route**fresh-restore**Save as: server is `resume_session_id`
stamp `apply_resume_snapshot: true` to spawn payload
reapply snapshot with fresh  .
Please set permission as fresh session. More
  [ADR-0014 F1 supplement "sesion id no pointer fresh-restore"](0014-session-resume-and-restore.md)
and [phase-25 Plan](../plans/phase-25-fresh-restore-without-session.md).
D8 "Restore button disconnected only gate" policy is unchanged,
The principle of not displaycontrol with or without session id is fresh-restore
Maintained as it is.
- **D9(double connection prevention)**: Reuse existing `require_disconnected/1` (ADR-0014 F4).
The live agent is excluded from the restore object.
- **D10(permission)**: List/Restore operation and operator only
[ADR-0021](0021-role-information-disclosure-policy.md)
viewer does not return the AgentDirectory-derived offline list.
- **D11(rate limit)**: B  Restoration spawn is spahronously fired ( spa side)
for-loop, broadcast only). No special rate limit — real spawn execution
in-flight lock Revise this ADR if it is an actual operation problem.
- **D12 (Global Settings)**: The current value does not have mutable global config
(All env out). This ADR is not included in the scope. Future dashboard-driven
Add to another ADR when config occurs.

## Consequences

### Positive

- The agent list is not empty even after the server/ server restart, and the operator is
It can be restored to the whole/  by explicit operation.
- ADR-0014 A4 "JSONL Japanese term" is maintained and goal is achieved (history permanently unnecessary).
- Implemented with the same DETS pattern as the existing `SessionPointers` / `PermissionModes`
Low cost (store added + spawn   + reference change + client delivery +
  dashboard UI).
- session id / cwd(SessionPointers) / permission mode
(PermissionModes) is already permanent and only one persona item is added.

### Negative

- To delegate the AgentDirectory entry lifecycle (remove) to the operator,
Long-term operation may yield old entry. Future GC review (D6).
- spawn broadcast runs on many  broadcasts at once. If it is a problem with actual operation
Add rate limit to D11.

### Neutral

- "Last state" is only 4 points of persona + session id + cwd + permission mode
ADR-0014
A4
- AgentDirectory and Agentshots.snapshot
merge.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| `SessionPointers`extension to include persona + last seen|pointer The concept bulges up to identity. ADR-0014 is not compatible with "pointer only, without history"|
|Persistent Agent s|Contrary to ADR-0014 A4, including up to volatile envel s and history|
|Auto resume from server crash|Double-connection risk, deprived of operator decisions, contrary to user policies|
|New wire for b  restoration`bulk_restore`)Add|Redundant to just call existing restore / resume disconnected one body|
|entry Auto GC (Remove in N-day)|In the initial scope, the operator may be confusing. Future Options|
|ADR-0014|0014 is the main body of the resume mechanism, the concept is separate with identity persistence + UX|

## Implementing phase (cut out at roadmap, plan)

- **phase-0**: `AgentDirectory` GenServer + DETS Additional, spawn / envel  arrival
, `agent_persona/1` replacement, test (`SessionPointers` test template

- **phase-1**: AgentDirectory to join role snapshot
dashboard logic to merge with Agent s to determine live/offline.
- **phase-2**:Dealer button (offline tile agent)
UI of button (header) and `spawn_result` error.
- **phase-3**Sorry, this entry is only available in Japanese.

## Related

- Dependent ADR: [0014](0014-session-resume-and-restore.md)(resume mechanism body,
pointer persistence), [0024](0024-agent-instance-identity-and-spawn-auth.md)
(host id calculation from the agent id  ing convention)
- Reference ADR: [0012](0012-response-display-and-dashboard-scope.md)(A4 JSONL)
[0021](0021-role-information-disclosure-policy.md)(operator)
role gate), [0023](0023-host-runner-architecture.md)
)
-: issue:
[#41](https://github.com/sakuraiyuta/kaoiro/issues/41)
Close
[#24](https://github.com/sakuraiyuta/kaoiro/issues/24)

[#88](https://github.com/sakuraiyuta/kaoiro/issues/88)
per-personaType pattern)
-CO:s: [protocol](../specs/protocol.md) (spawn / resume route),
  [architecture](../specs/architecture.md)
