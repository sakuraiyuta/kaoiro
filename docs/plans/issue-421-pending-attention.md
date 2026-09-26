---
title: Keep attention indicators visible while approval is pending
status: proposed
last_updated: 2026-09-26
---

# Issue #421: Pending approvals in dashboard attention indicators

## Problem and evidence

The operator reported that Antigravity agent Hisui's `request_session_reset`
approval dialog remained open while the upper-right attention warning blinked
once and disappeared. The exact viewport and warning were not recorded, so the
production observation alone does not identify the component.

The dashboard has two distinct candidates. In the grid, `AgentCard.svelte`
renders the top-right "要対応" badge from live `envelope.state` values
(`waiting_permission`, `waiting_question`, or `error`) and `hasUnackedError`
(`AgentCard.svelte:161-171`). In detail view, the upper-right
`button.blindspot` says "他に N 体が要対応" and counts only *other* agents by
live state (`AgentDetail.svelte:1119-1129, 2862-2870`). `App.svelte:1930-1952`
renders AgentDetail instead of the grid when an agent is selected. Therefore,
the grid badge is the matching indicator if the warning belonged to Hisui; the
detail blindspot cannot count Hisui while Hisui is selected. It may describe a
different agent and must not be treated as Hisui's badge.

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
(`server/lib/kaoiro_server/agent_states.ex:18-20, 672-679`; wrapper channel
comment at `server/lib/kaoiro_server_web/channels/wrapper_channel.ex:1235-1236`).
The read-only production `list_agents` snapshot showed Hisui's current state
as `waiting_input`, but it is not a historical trace and cannot establish the
state at 21:48. The reported transition therefore cannot be independently
reconstructed from retained server state.

## Options and recommendation

1. **Dashboard derives attention from pending permission/question as well as
   live state.** Use the existing parsed authoritative pending fields in the
   card badge and the detail blindspot's other-agent predicate/tone. This
   matches the existing lamp/label behavior, works consistently across engines,
   and avoids changing coarse wrapper state semantics. The blindspot continues
   to exclude the selected agent because its contract is about *other* agents.
2. **Wrappers hold `waiting_permission` for the full approval lifetime.** This
   could align state and attention for Antigravity's broker-gated bridge calls,
   but it changes state-machine transitions and server broadcasts. It must
   avoid double transitions in Antigravity's separate external hook gate and
   needs careful late-settlement/turn-ownership handling. It would not address
   any dashboard predicate that is semantically meant to follow pending data.
3. **Change both layers.** This duplicates the source of attention semantics
   and increases the risk that the coarse state and authoritative pending
   record disagree during settle, interruption, or engine-specific waits.

Recommend option 1. Pending permission/question records are the UI's existing
authoritative signal for open dialogs, while live state remains useful for
errors and non-dialog waits. No change to wrapper state machines or wire
schema is needed.

The operator did not preserve a screenshot or identify whether the warning
was the grid badge or detail blindspot. The implementation should make both
existing attention surfaces honor pending records, while preserving the
blindspot's selected-agent exclusion. If the intended requirement is instead
to count the selected agent in the detail blindspot, that changes the meaning
of "other agents" and requires a separate scope decision.

## Scope

In scope:

- Include a valid `pending_permission` or `pending_question` in the dashboard's
  card attention badge condition.
- Include valid pending permission/question records when counting other
  agents in AgentDetail's blindspot, and choose its tone from the pending kind
  when that is the reason for attention.
- Add dashboard component tests for pending-on / pending-cleared behavior and
  for a pending non-selected agent in the detail blindspot.
- Update `docs/reference/ui/responsive-reachability.md` to state that card
  attention and the detail blindspot follow pending dialog records as well as
  live waiting/error states, while the blindspot excludes the selected agent.

Out of scope:

- Changing wrapper state transitions, server persistence/history, or protocol
  fields.
- Changing which agent the detail blindspot counts or showing the selected
  agent as an "other" agent.
- Reconstructing the exact 21:48 production state transition; no state history
  is retained, and production interaction must remain read-only.
- Changing permission dialog contents or access-control behavior. Viewers do
  not receive operator-only `ext`; their existing synthetic waiting state
  remains the display input (`docs/reference/security/enforcement-boundaries.md:25`).

## Verification plan

- Run focused dashboard tests, dashboard typecheck/check, and the full
  dashboard test suite.
- Exercise the default `App.svelte` composition and its normal `AgentCard` /
  `AgentDetail` wiring with no custom attention predicate or injected
  replacement component. Feed state envelopes through the normal dashboard
  envelope path: (a) `tool_running` + valid pending permission/question keeps
  the grid badge and another-agent blindspot on; (b) clearing pending turns
  them off when live state is non-attention; (c) pending on the selected agent
  does not increment the "other agents" count.
- Negative control: remove the pending-record branch from the attention
  predicate, rerun the same default-composition test, and require it to fail
  specifically because the attention indicator is absent; restore the branch
  and require it to pass. Also keep a `tool_running` envelope without pending
  data as a passing negative case.
- Inspect operator and viewer behavior separately. Operator envelopes use
  authoritative pending ext; viewer envelopes omit sensitive `ext` and use
  synthetic `waiting_permission` / `waiting_question` state, which must keep
  the existing indicator visible without exposing pending details.

## Documentation

Update `docs/reference/ui/responsive-reachability.md` only if implementation
is approved. No protocol or engine documentation change is proposed because
the fix consumes the existing pending fields and does not change engine state
semantics.
