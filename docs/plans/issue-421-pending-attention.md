---
title: Keep attention indicators visible while approval is pending
status: implemented
last_updated: 2026-09-27
---

# Issue #421: Pending approvals in dashboard attention indicators

Review basis: source tree `b71674a28baa0b1e4b113dca40ce02b220e6373c`; first
design revision commit `134ed2ed633ee03dddd38930af6e993ebd8ffb01`. This revision
extends that reviewed plan with the viewer-path result and wrapper ownership
design.

## Problem and evidence

The operator reported that Antigravity agent Hisui's `request_session_reset`
approval dialog remained open while the upper-right attention warning blinked
once and disappeared. The master later confirmed that the open detail view was
Chloe's at 1920x1080; the warning wording itself is not remembered. In that
layout, the upper-right indicator is AgentDetail's blindspot. Hisui is not the
selected agent and therefore belongs in its "other agents" count.

The dashboard has two distinct candidates. In the grid, `AgentCard.svelte`
renders the top-right "要対応" badge from live `envelope.state` values
(`waiting_permission`, `waiting_question`, or `error`) and `hasUnackedError`
(`AgentCard.svelte:161-171`). In detail view, the upper-right
`button.blindspot` says "他に N 体が要対応" and counts only *other* agents by
live state (`AgentDetail.svelte:1119-1129, 2862-2870`). `App.svelte:1930-2010`
renders AgentDetail instead of the grid when an agent is selected and enters
the grid branch only in the paired `{:else}`. Therefore the observed warning
is the detail blindspot, not Hisui's card badge. Its current state-only
predicate excludes Chloe and includes Hisui only while Hisui's own live state
is `error`, `waiting_permission`, or `waiting_question`.

Both card and detail already use `pendingPermissionFrom(envelope)` and
`pendingQuestionFrom(envelope)` to pin the lamp and label while the dialog is
open (`AgentCard.svelte:136-143`, `AgentDetail.svelte:219-230`). These helpers
read the authoritative `ext.pending_permission` / `ext.pending_question`
fields (`dashboard/src/lib/protocol.ts:92-107, 138-153`). The attention badge
and blindspot count do not consult those fields, so a pending request can
remain authoritative while the live state no longer matches their predicate.

The engine paths differ. A fake Antigravity host/ToolHost run of the actual
`request_session_reset` descriptor produced `idle -> sending -> tool_running`
and then `tool_running` with `ext.pending_permission` set. This is the
broker-gated bridge path wired by `antigravity/src/cli.ts:139-143, 522-538`;
`AntigravityHost.setPendingPermission` only stamps and emits the current state
(`antigravity/src/host.ts:1082-1085`). It is distinct from Antigravity's
external command hook gate: `gate.ts:522-533` calls the state callbacks around
the broker wait, and the host wires those callbacks to
`permission_request` / `permission_resolved` transitions (`host.ts:1336-1337,
1718-1719`). For an actual hook-gated command, the expected sequence is
`tool_running -> waiting_permission -> tool_running`.

The one-time flash has a code-supported likely explanation, though it is not
an event trace recovered from production. `PermissionBroker.decide`
(`agent-common/src/permission.ts:130-143`) sends the initial
`permission_request` envelope first; that envelope is explicitly
`waiting_permission` with empty `ext` (`agent-common/src/state.ts:324-339`).
It then synchronously calls `onPendingChange`, and Antigravity emits a
`state_change` carrying the pending record but retaining `tool_running`
(`antigravity/src/host.ts:1082-1085`). The server stores either event as the
latest state (`wrapper_channel.ex:1235-1236, 1255`). Thus the initial
`waiting_permission` can briefly light the blindspot, then the next
`tool_running + pending_permission` state removes it under the live-state-only
predicate. The fake observation confirms the latter state; the exact
production delivery timing remains unverified because the server does not
retain state-transition history.

Fake-based pending-wait traces were also captured from the existing Claude and
Codex test setups. Claude `canUseTool` emitted `sending -> tool_running ->
waiting_permission` with a pending permission (`claude-code/src/host.ts:2215-2299`).
Codex's wrapper-owned bridge approval emitted `sending -> tool_running ->
waiting_permission` (`codex/src/host.ts:1350-1366`); the app-server fixture
also reached `waiting_permission` with pending permission. Thus the measured
state mismatch is Antigravity-specific for `request_session_reset`, but the
dashboard predicate is engine-neutral and can miss any pending record if a
later state update advances the live state before the approval is resolved.

The server retains only each agent's latest state envelope; its `history` is
transcript/log history rather than a sequence of state transitions
(`server/lib/kaoiro_server/agent_states.ex:2-22, 672-680`; wrapper channel
comment at `server/lib/kaoiro_server_web/channels/wrapper_channel.ex:1235-1238`).
The read-only production `list_agents` snapshot showed Hisui's current state
as `waiting_input`, but it is not a historical trace and cannot establish the
state at 21:48. The reported transition therefore cannot be independently
reconstructed from retained server state.

A temporary focused server channel test reproduced the viewer sequence by
broadcasting those two envelopes through the real `AgentsChannel` viewer
sanitization path (`agents_channel_test.exs:3124` at the probe revision): the
viewer received synthetic `state_change(waiting_permission)` followed by
`state_change(tool_running)`, with `ext` absent from both. The probe passed
once and was removed after measurement. This confirms that the prior plan's
claim that the existing synthetic waiting state suffices for viewers was
incorrect: a later state_change replaces it.

## Options and recommendation

1. **Dashboard uses pending records as well as live state.** The parsed
   authoritative pending fields keep operator badges aligned with the open
   dialog, but viewers do not receive `ext`; this option alone cannot fix the
   measured viewer sequence.
2. **Wrapper state only.** Hold Antigravity bridge-tool approval at
   `waiting_permission` and repair viewer / `list_agents` state. This fixes
   the information available to state-only readers, but leaves the operator
   dashboard dependent on state remaining correct for every engine and path.
3. **Change both layers (recommended).** Antigravity's bridge-tool approval
   owns a `waiting_permission` interval with turn ownership, while the
   dashboard also honors valid pending permission/question records. The
   wrapper state is the viewer and peer-facing signal; the dashboard pending
   check is defense that keeps operator attention aligned to the authoritative
   pending dialog if another engine/path advances live state unexpectedly.

Use one owner-aware permission-wait projection in `AntigravityHost`. Wrap the
bridge `operatorApprovalGated` decision promise in a bridge wait lease; keep
`PermissionBroker.onPendingChange` responsible for stamping/clearing
`ext.pending_permission`. The native `gate.ts` callbacks acquire/release their
own lease. Store active leases as a set keyed by unique lease ID, each carrying
its turn token and source; decide whether any wait remains by querying the
current set after every add or removal. Do not use an increment/decrement
counter: a stale release must remove only its own ID and leave every other
owner entry unchanged. Transition into `waiting_permission` only when the set
changes from empty to non-empty, and back to the captured pre-wait state only
when it becomes empty. Broker metadata updates for a native wait do not create
a second wait lease. A release from an owner whose turn is no longer active
must not emit `permission_resolved` or restore an old state over the new owner.
If terminal state arrives before the lease release, the later release must
leave that terminal state untouched.

The base state before `request_session_reset` is `tool_running` in the measured
ToolHost path, as it is for the native hook's tool call. Assert this precondition
when acquiring a lease. On allow or deny, releasing the bridge wait returns to
that pre-wait `tool_running` state; the tool result / subsequent Antigravity
stream then determines the next state. This restores the existing
state-machine meaning rather than inventing a deny-specific state.

The related `list_agents` asymmetry is fixed by the same wrapper state change
and is not split into a separate issue. `list_agents` continues to omit
pending details as required by ADR-0021 F6-4 and
`docs/reference/inter-agent/directory.md:175-180`; its existing top-level
`state` reports `waiting_permission` without exposing tool input or pending
records.

## Scope

In scope:

- In Antigravity's bridge-tool permission path, project the broker wait as
  `waiting_permission`; restore `tool_running` when that wait settles only if
  its owning turn is still active. Keep pending ext changes synchronized.
- Coalesce bridge broker and native hook wait ownership so the shared broker
  callback and `gate.ts` callbacks cannot double-enter or double-exit the
  permission state.
- Include a valid `pending_permission` or `pending_question` in the dashboard's
  card attention badge condition and in AgentDetail's other-agent blindspot
  predicate/tone.
- Keep the blindspot's selected-agent exclusion.
- Add wrapper tests for the transition table below, dashboard default-App
  composition tests for Hisui counted while Chloe is selected, and a server
  viewer channel test for the sanitized state sequence.
- Update `docs/reference/ui/responsive-reachability.md` to state that card
  attention and the detail blindspot follow pending dialog records as well as
  live waiting/error states, while the blindspot excludes the selected agent.
- Update `docs/reference/protocol/state-machine.md` and
  `docs/reference/engines/antigravity-tools-permissions.md` for the
  bridge-tool permission wait and its return path.

Out of scope:

- Changing server persistence/history or protocol fields.
- Changing which agent the detail blindspot counts or showing the selected
  agent as an "other" agent.
- Reconstructing the exact 21:48 production state transition; no state history
  is retained, and production interaction must remain read-only.
- Changing permission dialog contents or access-control behavior. Viewers do
  not receive operator-only `ext`; their existing synthetic waiting state
  remains content-sanitized (`docs/reference/security/enforcement-boundaries.md:24-27`).

## Wrapper transition table

| Scenario | Required state path | Ownership and guard | Pin |
|---|---|---|---|
| Bridge approval allowed | `tool_running -> waiting_permission -> tool_running`; after handler completion the stream advances normally (for example `thinking` or terminal `waiting_input`) | Clear pending and release only the bridge wait owned by the active turn | Fake Antigravity Host + real ToolHost descriptor / broker allow |
| Bridge approval denied or times out | `tool_running -> waiting_permission -> tool_running`; `operatorApprovalGated` returns its existing error result, then the normal stream determines the next state | Permission resolution itself does not invent `error`; only the later stream result does | Fake broker deny and timeout; assert handler is not run and subsequent state follows stream |
| Operator interrupt | Wait clears; if the same turn still owns it, restore `tool_running`, then existing interrupted settlement emits `error -> waiting_input` | Broker close settles once; duplicate clear is idempotent | Interrupt while pending; assert one release and terminal settlement |
| Normal turn end | A pending handler must settle before the turn can complete; after the wait returns to `tool_running`, existing result path emits `done -> waiting_input` or `error -> waiting_input` | No terminal state may be overwritten by a later clear | Allow/deny followed by fake `result`; assert final sequence |
| Epoch/socket restart or death | Cancel the old wait; restore only while its owning turn remains active, then the old turn follows existing epoch-death error settlement; fresh epoch starts from its normal initialization state | Socket-close/broker-close path clears the old owner before a new turn can own the epoch | Close fake gate socket / end fake child while pending; assert no pending leak into new epoch |
| Delayed settle after ownership moves | No transition for the old owner; preserve the new owner's or resting state | Old request IDs are removed by `PendingRegistry.closeAll`; also reject a host callback whose owner token is no longer active | Resolve old request after interrupt/new-owner setup; assert no stale `permission_resolved` or state resurrection |
| Native hook gate | Existing `tool_running -> waiting_permission -> tool_running` sequence remains exactly one entry and one exit | `gate.ts` owns the native wait; broker callback only stamps/clears ext for that same wait through idempotent owner coalescing | Fake native hook allow/deny; assert unchanged state-event sequence and no duplicate transitions |
| Concurrent waits, bridge then native | Bridge acquire: `tool_running -> waiting_permission`; native acquire: no state event; bridge release: still `waiting_permission`; native release: `waiting_permission -> tool_running` | Set contains both unique lease IDs; each release removes only its own ID; only empty/non-empty edges drive state | Acquire bridge then native leases; assert exact state sequence and owner set after each action. Removing the set-based empty check must make this pin fail |
| Concurrent waits, native then bridge | Native acquire: `tool_running -> waiting_permission`; bridge acquire: no state event; native release: still `waiting_permission`; bridge release: `waiting_permission -> tool_running` | Same set rule in reverse source order; source order must not affect state edges | Acquire native then bridge leases; assert exact state sequence and owner set after each action. Removing the set-based empty check must make this pin fail |

The adapter's generic `permission_resolved` transition returns to
`tool_running` (`agent-common/src/state.ts:115-127`), matching the Codex
bridge implementation (`codex/src/host.ts:1343-1367`). Claude stamps pending
data in `setPendingPermission` and owns transitions around `canUseTool`
(`claude-code/src/host.ts:1711-1719, 2261-2300`). The Antigravity bridge
path should align with Codex's state-driving behavior, while its native hook
path retains its existing callback-driven behavior. Do not change Claude or
Codex transitions.

## Verification plan

- Run focused wrapper and dashboard tests, wrapper typecheck, dashboard
  typecheck/check, full Antigravity tests, and full dashboard test suite.
- In server tests, retain the measured viewer path: feed the synthetic
  permission request followed by `tool_running + pending_permission` through
  `AgentsChannel` viewer broadcast. After the wrapper fix, viewer state must
  remain `waiting_permission` (with `ext` absent); before the fix this test
  must go red because the second state is `tool_running`.
- Feed the waiting state envelope emitted by the fake Antigravity host into
  the server's directory projection and assert `list_agents` reports
  `waiting_permission` during the pending wait while still omitting pending
  details.
- Cover every row in the wrapper transition table. Mutate the bridge entry
  transition, clear/restore transition, owner guard, and native-gate
  de-duplication independently; both concurrent-wait order tests must also go
  red if the set-based empty check is removed. Restore each mutation and
  require its corresponding test to pass.
- In the stale-owner test, hold one current lease and deliver release for a
  different stale lease ID. Assert the stale ID alone is removed, the current
  owner's set entry remains, and no state transition occurs until that current
  owner releases.
- Regression controls: Claude `canUseTool`, Codex bridge/app-server, and
  Antigravity native hook state sequences remain unchanged. Keep the existing
  `tool_running` envelope without pending data as the dashboard negative case.
- Exercise the default `App.svelte` composition and its normal `AgentCard` /
  `AgentDetail` wiring with no custom attention predicate or injected
  replacement component. Select Chloe and feed envelopes through the normal
  dashboard path for another agent, Hisui: (a) `tool_running` + valid pending
  permission/question keeps Hisui's grid badge and increments Chloe's
  "other agents" blindspot count by one; (b) clearing pending turns those
  indicators off when live state is non-attention; (c) select Hisui and confirm
  Hisui is excluded from its own "other agents" count.
- Negative control: remove the pending-record branch from the attention
  predicate, rerun the same default-composition test, and require it to fail
  specifically because the attention indicator is absent; restore the branch
  and require it to pass. Also keep a `tool_running` envelope without pending
  data as a passing negative case.
- Inspect operator and viewer behavior separately. Operator dashboard
  attention follows authoritative pending ext; viewer envelopes omit sensitive
  ext but now retain `waiting_permission` from wrapper state. Assert no tool
  name, input, request ID, or other pending detail reaches the viewer.

## Documentation

The approved implementation should update the three reference documents named
above. `responsive-reachability.md` records dashboard semantics,
`protocol/state-machine.md` records the added bridge wait source, and the
Antigravity engine reference records that the bridge broker wait now holds
`waiting_permission` while preserving native-hook behavior.
