---
title: Inter-agent session tools
description: Exact contract for agent-requested compaction, context threshold notices, and session reset.
status: provisional
last_updated: 2026-10-18
related: [protocol, inter-agent-messaging]
---

# Inter-agent session tools

#### Session operation tool — `request_compact` (phase-28 B2)

Unlike [`list_agents` and `whoami`](directory.md#companion-tools-wrapper-sdk-mcp), `mcp__kaoiro__request_compact` is **not auto-allowed**.
Leaving it out of default allowedTools triggers canUseTool and asks the operator
through `permission_broker` each time ([#158](https://github.com/sakuraiyuta/kaoiro/issues/158)
P2, same shape as [ADR-0028](../../adr/0028-external-human-messaging.md) D4).

**Approval depends on the engine and its approval policy.** Claude uses its
permission mode; Codex reset uses the dispatched turn and latest approval-axis
selection as described below; Antigravity reset always asks. Claude behavior
is documented in [ADR-0043](../../adr/0043-agent-initiated-session-reset.md) D4 addendum, verified
on hardware 2026-07-28. The canUseTool → `permission_broker` dialog appears
only in SDK modes that consult canUseTool (`default` family). In `auto`,
`dontAsk`, or `bypassPermissions`, the SDK auto-approves by mode semantics, so
no dialog appears. This applies to every canUseTool tool, including
`send_to_agent` and `request_session_reset`. Operators requiring strict
per-call approval must set a `default`-family mode.

| item | content |
|---|---|
| input | `{ reason?: string, resume_prompt?: string }`, both optional. `reason` appears in the approval dialog and is echoed in the tool result. `resume_prompt` is an automatic post-compaction instruction ([ADR-0055](../../adr/0055-compaction-resume-and-lifecycle-log.md), phase-33 Stage A); the agent writes it while full context is available. Omitting it preserves the legacy opt-in behavior. |
| approval | Queue the **fixed string `/compact`** and return “reservation accepted”; do not wait for compaction. Keep `resume_prompt` in wrapper memory when supplied. |
| denial | SDK returns a deny message as the tool result; the handler does not run. |
| timeout | Existing `permission_broker` rule (`permission_timeout_ms` unset means wait indefinitely, [ADR-0022](../../adr/0022-pending-permission-authoritative-source.md) F6). |
| engine | **Claude only**; Codex has no `/compact` path and relies on engine auto-compaction. |

Rules:

- **MUST**: Input is the fixed literal `/compact`; never concatenate `reason`
  or let the model inject arbitrary text into the input stream.
- **MUST**: Queue the input. It fires at a turn boundary and never interrupts
  a running turn ([ADR-0036](../../adr/0036-session-lifecycle-commands.md) F6).
- Observe completion through the Phase-A `compact_boundary` log (`kind:"system"`).
  The tool does not wait. Duration depends on context size (measured 13.7 s at
  ~22k tokens and 168.8 s at ~293k tokens) and can reach minutes; neither the
  tool description nor result promises a duration.
- Do **not** auto-trigger at 85% or similar. SDK-native autoCompact is the last
  line of defense; kaoiro triggers always require operator approval (P2).

**`resume_prompt` firing rule** ([ADR-0055](../../adr/0055-compaction-resume-and-lifecycle-log.md), phase-33 Stage A):

- The wrapper fires on `compact_boundary` and injects a **fixed prefix template**
  followed verbatim by the `resume_prompt` body as a user turn through the same
  serialized instruction queue as threshold notices. The fixed prefix states
  provenance and keeps arbitrary model text out of the injection path; only the
  agent-authored body is verbatim.
- Reservations live only in wrapper memory. If the wrapper dies during
  compaction, the reservation may disappear (timeline remains distinguishable
  as Stage-B `resume_reserved` without `resume_fired`).
- **MUST**: `resume_prompt` is checked against two independent limits before
  `/compact` is queued, and exceeding either fails the whole `request_compact`
  call rather than truncating, which would break the verbatim guarantee above:
  its own raw length, capped at 8,192 UTF-8 bytes; and the full serialized
  `request_compact` input (`reason` + `resume_prompt` + JSON overhead), which
  must fit PermissionBroker's approval-payload ceiling (16,384 bytes) once
  serialized — JSON escaping can inflate a raw value well past the first cap
  alone, so a value under it is not sufficient on its own.
- Engine is **Claude only**, as for `request_compact`
  ([codex-lifecycle-observability](../../open-questions/codex-lifecycle-observability.md)).

#### Threshold notice (phase-28 B1)

Whenever a `context` measurement updates, the wrapper evaluates
`used_percentage` and injects one notice **per context epoch** at the default
60% threshold (a user turn through the normal instruction queue). Deduplication
is per epoch and resets at compaction or conversation reset.

- **MUST**: Do not notify on an unconfirmed reading immediately after an epoch
  boundary. `getContextUsage()` may still report the pre-compaction value
  (Track-S measurement), causing a duplicate immediately after compact.
  Confirm when boundary metadata (`post_tokens`, or `pre_tokens` if absent)
  indicates the new epoch, or after the bounded number of post-boundary
  readings.
- **MUST**: Confirmation cannot rely on a **greater-than comparison alone**.
  Discrete observations can remain above the threshold forever; without a
  bounded escape such as a reading count, a valid notice could be suppressed
  permanently.
- **MUST**: Use the same serialized route as operator instructions,
  inter-agent messages, and `request_compact`. Drop a notice whose epoch changes
  while queued; never carry an old-epoch notice into a new epoch.

Do not show the notice continuously or reinject every turn (#158 P3, avoid
context anxiety). Wording should state that recovery options exist and no
immediate action is required, not imply imminent danger. The threshold remains
the wrapper constant `CONTEXT_NOTICE_THRESHOLD_PERCENT`; config wiring is
deferred until dogfooding.

#### `request_session_reset` (phase-28 C2)

Operators can inspect recorded resets through **Session history** in the agent
detail pane. Settings also accepts an agent ID, including a deleted agent whose
history is still retained. A director reset names its requester and includes the
work title while the server can resolve it; the work ID remains visible and is
the fallback after the work disappears. Legacy resets have no recorded origin.
The view distinguishes partial responses, unreadable rows, empty history and
fetch failures. Reset-started/completed notifications trigger a best-effort
re-fetch: the server can send the notification before recording its row, so a
manual refresh may be needed to see that latest row. Other lifecycle kinds use
manual refresh. See [channel queries](../protocol/channels.md#operator-session-history).

Tool for an agent to request rebuilding its own session
([ADR-0043](../../adr/0043-agent-initiated-session-reset.md)). Its effect is
reserved until the owning turn ends. Claude uses canUseTool and its permission
mode. Codex uses `operatorApprovalGated`: it skips the broker only when the
normalized approval actually sent for the calling turn and the latest operator
selection are both `never`, and permission state is not blocked. Missing policy
on a live turn, a failed policy read, `untrusted`, or `on-request` asks through
`PermissionBroker`. Exec and app-server with the axis off submit `never`.
A stricter mid-turn selection affects the next call; loosening waits for the
next turn. Antigravity keeps its per-call broker approval.

The tool describes this as: "When the engine and approval policy permit
autonomous reset, the reservation is made at once without an operator dialog;
otherwise the operator is asked first and may refuse." Cancellation notices
likewise leave the next call's approval to the engine and policy.

| item | content |
|---|---|
| input | `{ mode: "new" \| "clear", reason?: string }`; `mode` is required. |
| approval | Wrapper returns a **reservation only**; execution follows that turn's `result` processing. |
| turn boundary | Wrapper sends `session_reset_request {mode, reason?}` to the server, which applies the same capability/pending-lock/state/cooldown gates as operator requests. In both Codex SDK and app-server paths, the ready `state_change` is sent on the same socket before `session_reset_request`, following [ADR-0043 D3](../../adr/0043-agent-initiated-session-reset.md)'s requirement to process the result first. |
| denial | Broker deny or approval timeout returns an error without a reservation. Server refusals arrive after reservation as a notice: `agent_busy` is retried once and may then succeed; unsupported/runner-unavailable replies confirm refusal. A push timeout or pending reset leaves the outcome unconfirmed. |
| Codex lifetime | A call with no live turn is cancelled before the approval setting is consulted. Autonomous approval also checks cancellation before reserving. When required, the approval wait is bounded at 300 s (`CODEX_APPROVAL_TIMEOUT_MS`, below codex's 310 s `tool_timeout_sec`) and denies on timeout. It is also bound to the calling turn: interrupt, a stream ending without a terminal, a rejected run, watchdog stop or host close deny a pending wait, and drop an already-made reservation with a notice to the agent. Only `turn.completed` / `turn.failed` is the boundary that sends `session_reset_request`, and a terminal delivered after the turn was abandoned from outside (operator interrupt, watchdog, host close) does not count. |
| engine | Claude via canUseTool and its permission mode; Codex via the policy-aware wrapper gate (ADR-0043 2026-10-15 addendum); Antigravity via its per-call wrapper broker. Codex `request_compact` is not registered. |

Rules:

- **MUST**: Execute only at a turn boundary; a tool call never resets
  immediately ([ADR-0043](../../adr/0043-agent-initiated-session-reset.md) D3).
  The approval-to-execution delay is specified, and the server may reject if
  state changed meanwhile.
- **MUST**: Put `reason` only in the `session_reset_request` payload. Never
  concatenate it into instructions or runner payloads, and do not echo it in
  the tool result.
- **MUST**: Surface a server rejection to the agent on the next turn and log
  it for the operator; never silently abandon it.
- **MUST**: Retry only a confirmed retryable rejection (`agent_busy`). A push
  timeout does not prove non-acceptance, and `session_reset_pending` may mean
  the reset is already running; retrying could request it twice.
- **MUST**: Do not claim that an unconfirmed result (timeout,
  `session_reset_pending`, or unknown reason) means “not executed” or “context
  unchanged.” Say that the result is unknown and a reset may be in progress.
- **MUST**: Put no deadline on resolving an unconfirmed result. The server reset
  transaction has its own 60-second timeout independent of wrapper turn
  boundaries, and an accepted reset may replace the process just after a short
  turn. Only process replacement or an operator lifecycle event confirms the
  outcome. Until then say not to retry and keep durable state safe for either
  result.
- **MUST**: Accept only closed-vocabulary server reasons; collapse unknown,
  non-object, or empty values to `unknown_error`. Reasons appear in operator
  logs and injected turns, so they must not be an arbitrary text channel.
- **MUST**: The tool description must tell the agent to write handoff context
  externally before calling (D5); unlike compact, no summary or handoff is
  created.
- Do not promise duration or result metadata (same reason as B2 MF3).

#### `request_peer_session_reset` ([ADR-0068](../../adr/0068-director-requested-peer-session-reset.md))

Tool for a director to request the session reset of the peer it directs.
Authority is the server-owned work grant: the caller must be `director` of
`work_id`, the target its `assignee`, the grant active at
`expected_authority_epoch`, and the two agents distinct. Take `work_id` and
the epoch from your own work results (`work_control_result` /
`work_status`), not from `list_agents`. Approval is the same class as
`request_session_reset` (Claude canUseTool and permission mode, Codex
`operatorApprovalGated`, Antigravity per-call broker).

| item | content |
|---|---|
| input | `{ agent_id, mode: "new" \| "clear", work_id, expected_authority_epoch, reason?: string, wait?: boolean }`; `wait` defaults to `true`. |
| send | Immediately — the caller is not the process being replaced, so there is no turn boundary to wait for. The wrapper sends `peer_session_reset_request`; the server authorizes, applies the operator reset's gates plus `agent_in_conversation`, then checks the same-room rule last, immediately before the lock, and replies `{ request_id }`. |
| result | With `wait`, the tool returns `{ request_id, agent_id, mode, work_id, outcome: "completed" \| "failed" \| "timeout", reason?, to_session_id? }` within 70 s (the server's 60 s reset transaction plus margin). With `wait: false` it returns `{ request_id, agent_id, mode, work_id, outcome: "accepted" }` and a later `peer_session_reset_result` reaches the model as a root input, like a work notice. If the request itself gets no reply, the outcome is unknown; the tool says so and the caller must not resend. |
| refusal | One of these closed reasons: `reset_not_authorized` (any authority failure, undifferentiated), `work_control_unavailable`, `unknown_agent`, `unsupported_session_reset` (Grok targets today), `agent_in_conversation` (the target has an open conversation with a third agent; one with the caller is allowed), `agent_busy`, `session_reset_pending`, `runner_unavailable`, `room_mismatch` (the target is in another room; the grant stays valid, so ask the operator rather than retrying — [rooms](rooms.md#the-director-requested-peer-session-reset)), `rooms_unavailable` (the rooms store did not answer this one read; retryable). |
| before calling | Have the target externalize its state (file or status line) and carry the context into your next request; the target's status line survives the reset, its session does not. A busy target is refused, never interrupted — use the cooperative yield first. |
| engine | Requester side registered on Claude Code, Codex and Antigravity, where `request_session_reset` is. Target side is any engine advertising `supports_session_reset: true`. Grok is neither requester (no `work_control` negotiation, tool not registered) nor target (`supports_session_reset: false`) today; both are tracked by [issue #658](https://github.com/sakuraiyuta/kaoiro/issues/658). |

The Rules above belong to `request_session_reset`. For this tool: the request
is sent immediately, `reason` travels only in the `peer_session_reset_request`
payload, and the wrapper collapses an unrecognised reply or result reason to
`unknown_error` (the server itself answers one of the closed words above; a
new server paired with an older wrapper therefore surfaces `room_mismatch`
and `rooms_unavailable` as `unknown_error`, and nothing was changed on the
server in that case either). An
unconfirmed outcome (no reply, or `timeout`) means a reset may still be in
progress: say so, do not resend, and keep durable state safe for either
result.
