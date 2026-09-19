---
title: Inter-agent session tools
description: Exact contract for agent-requested compaction, context threshold notices, and session reset.
status: provisional
last_updated: 2026-09-18
related: [protocol, inter-agent-messaging]
---

# Inter-agent session tools

#### Session operation tool — `request_compact` (phase-28 B2)

Unlike [`list_agents` and `whoami`](directory.md#companion-tools-wrapper-sdk-mcp), `mcp__kaoiro__request_compact` is **not auto-allowed**.
Leaving it out of default allowedTools triggers canUseTool and asks the operator
through `permission_broker` each time ([#158](https://github.com/sakuraiyuta/kaoiro/issues/158)
P2, same shape as [ADR-0028](../../adr/0028-external-human-messaging.md) D4).

**Approval effectiveness depends on the agent's permission mode**
([ADR-0043](../../adr/0043-agent-initiated-session-reset.md) D4 addendum, verified
on hardware 2026-07-28). The canUseTool → `permission_broker` dialog appears
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

Tool for an agent to ask the operator to rebuild its own session
([ADR-0043](../../adr/0043-agent-initiated-session-reset.md)). Like
`request_compact` it requires per-call approval, but its **effect occurs at a
different point** — and unlike `request_compact` it is registered on **both
engines**: Claude gates it through canUseTool, Codex through the wrapper-side
`operatorApprovalGated` handler that calls the same `PermissionBroker` from
inside the bridge tool call (ADR-0043 2026-09-14 amendment, issue #347).

| item | content |
|---|---|
| input | `{ mode: "new" \| "clear", reason?: string }`; `mode` is required. |
| approval | Wrapper returns a **reservation only**; execution follows that turn's `result` processing. |
| turn boundary | Wrapper sends `session_reset_request {mode, reason?}` to the server, which applies the same capability/pending-lock/state/cooldown gates as operator requests. |
| denial | Claude: the SDK returns a deny message as the tool result. Codex: the gated handler returns an `isError` result in the same turn. Either way no reservation is created. |
| Codex lifetime | The approval wait is bounded at 300 s (`CODEX_APPROVAL_TIMEOUT_MS`, below codex's 310 s `tool_timeout_sec`) and denies on timeout. It is also bound to the calling turn: interrupt, a stream ending without a terminal, a rejected run, watchdog stop or host close deny a pending wait, and drop an already-made reservation with a notice to the agent. Only `turn.completed` / `turn.failed` is the boundary that sends `session_reset_request`, and a terminal delivered after the turn was abandoned from outside (operator interrupt, watchdog, host close) does not count. |
| engine | Both. Claude via canUseTool → PermissionBroker; Codex via the wrapper-side `operatorApprovalGated` handler inside the bridge tool call (ADR-0043 2026-09-14 amendment). |

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
