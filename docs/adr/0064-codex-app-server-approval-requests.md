---
title: Codex approval requests over the app-server transport
status: accepted
date: 2026-09-30
opened: 2026-09-30
supersedes: []
superseded_by: null
related_specs: [protocol]
related_adrs: [22, 33, 58]
---

# ADR-0064 — Codex approval requests over the app-server transport

## Status

Accepted. The operator decided on 2026-09-30 to go ahead with ADR-0058 Stage 3
([issue #367](https://github.com/sakuraiyuta/kaoiro/issues/367)). The design
was reviewed in five rounds on the issue (r1 to r5, fuji's R1 to R5; R5: no
must-fix finding) and implemented behind a per-persona opt-in that is off by
default. Diagnostic probes on the 0.156.1 pin are in the
[Stage 3 evidence](../evidence/codex-app-server/stage3-approval-probes-2026-09-30.md);
the current contract is in the
[transport reference](../reference/engines/codex-app-server.md#approval-requests-adr-0064).
Enabling the opt-in for a production persona is a separate rollout step.

This ADR supersedes [ADR-0033](0033-permission-model-dual-axis.md) F3's
"approval fixed to `never`" **for the app-server backend only**. F3 stays in
force for the exec backend, and the rest of ADR-0033 stands. It closes the
open question `codex-exec-approval-upstream`: its resolution actions (revise
F3, wire an approval path, add a Codex approval selector) are done here for
the backend that has an approval protocol.

## Context

ADR-0033 fixed Codex approval at `never` because the SDK/exec path cannot
deliver an operator's answer while `codex exec` runs. The app-server backend
(ADR-0058) is bidirectional: `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` arrive as JSON-RPC server requests and take
a `{decision}` result. ADR-0058 required a separate decision for them because
a bidirectional transport alone does not settle correlation, operator
authorization, the pending-permission state, expiry and cancellation, and
delivery of the answer.

Three earlier ordering findings on the same class (issue #366 and review
rounds R1 to R3) showed that correlating each request with a turn event by
event keeps missing orders. The design therefore separates facts from
records.

## Decision

### D1 — A mutable approval axis on the app-server backend, opt-in

- Values `untrusted`, `on-request` and `never`, permissive in that order.
  `local`, `on-failure` and granular policies are not offered. The launch
  value and ceiling stay `never`, so nothing changes until an operator selects
  another value.
- The axis exists only for a persona opted in with
  `KAOIRO_CODEX_APPROVAL_AXIS=1` or `KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS`
  (the shared `personaOptInSource` parser). Without it the backend keeps
  writing `never`, and a request is answered `-32601` as before.
- `approvalsReviewer` stays `user`.
- The selection follows ADR-0033 F3's execution-boundary triple: requested
  (the operator's latest `set_permission`), submitted (the value written into
  that turn's `turn/start`), effective (`turn_context.approval_policy` in the
  rollout). A mismatch between submitted and effective is
  `approval_policy_mismatch`, as before, against the submitted value.
- An accepted request is a one-off escalation for that command or patch. It
  does not change any requested, submitted or effective value.

### D2 — Capability `values`

`permission_switch_axes.approval` gains an optional `values`, the closed set
of selectable approvals. The server and the wrapper accept it only as a
non-empty, duplicate-free subset of the approval enum containing `max`;
otherwise the approval axis is malformed and launch-fixed. A value outside
`values` is rejected with `unsupported_permission_switch`. Codex advertises
`{max: "never", values: ["untrusted", "on-request", "never"]}`. Because an
advertisement fixes every axis it omits, Codex also advertises sandbox and
network at their most permissive values, which leaves them as unclamped as the
legacy flow.

### D3 — Facts and records

- **Facts** only ever accumulate while their owner lives. The owner is the
  transport's turn reservation: `aborted` (set by the host before it aborts
  the turn), `terminal` (the owner's own named turn completed), and `start`
  (`started(turnId)` or `failed`). Per connection: `failed`, and the typed
  server-request ids seen (bounded at 65,536; the request past the bound, or
  any reused id, fails the connection without an answer).
- **Records**: one per server request, from wire receipt to exactly one final
  state (`replied`, `dropped` or `rejected`), via `held` or `pending`.
  Admission is a ten-rule decision list over the facts, evaluated at receipt
  and again when the owner's start is set. After admission, the first of the
  record's final events wins.
- Every way a reservation window ends (named, unnamed, connection failure)
  goes through one exit that judges deferred turn evidence with the issue #366
  tripwire, folds a buffered owner terminal, and only then settles held
  records.

### D4 — The operator path

One `PermissionBroker` serves the bridge tools and approvals, so ADR-0022's
single `pending_permission` slot keeps "the newest live request shows". The
broker reports what settled a request (`operator`, `timeout`, `aborted`,
`closed`) through a callback that runs before the slot changes; only
`operator` and `timeout` lead to a write. An allow is `accept`; a deny and a
deadline are `decline`. `decline` carries no message, so a deny message does
not reach Codex. Approvals have no deadline unless `permission_timeout_ms` is
configured (ADR-0022 F6); the turn watchdog stays active and ends an
unanswered request with its turn.

Measured on the 0.156.1 pin: command approvals carry an `availableDecisions`
list that is not in the generated schema and omits `decline`, yet a `decline`
reply is honoured. The director decided to keep `decline` for a deny; the
captured shape is pinned in a test together with the Codex pin.

### D5 — Not offered

`acceptForSession`, exec-policy and network-policy amendments, `cancel`
(the operator's interrupt covers it), `item/permissions/requestApproval`
(answered `-32601`), elicitations, a launch-time Codex approval and a runner
ceiling for it, and suspending the watchdog while an approval waits.

## Consequences

- Positive: an opted-in Codex persona can run with `on-request` or
  `untrusted` and ask the operator before escalating, through the same dialog
  as Claude and the bridge tools.
- Positive: every order of turn, abort, failure, resolution and decision
  events is covered by one decision list and one first-wins race; the tests
  compare every causal order of the event alphabet with an independent oracle
  and require the visited state-event cells to equal the table.
- Negative: an unanswered request holds the turn until the operator answers,
  the watchdog interrupts it, or a configured deadline declines it.
- Negative: a deny message is not delivered to the model.
- Neutral: the exec backend is unchanged.

## Alternatives considered

| Option | Why rejected |
|---|---|
| A second broker for approvals | Two brokers would fight over ADR-0022's single slot. |
| Server-side engine knowledge instead of `values` | Keeps the server and dashboard engine-neutral only with `values`. |
| An empty grant for `item/permissions/requestApproval` | Not measured; `-32601` fails closed (P5 measured `-32601` on a file change). |
| Suspend the watchdog while an approval waits | A separate decision for both engines; Claude's `canUseTool` wait is not suspended either. |
| Map a deny to `cancel` because `availableDecisions` omits `decline` | `cancel` also interrupts the turn; `decline` was measured to be honoured. |

## Related

- [ADR-0022](0022-pending-permission-authoritative-source.md) (single
  authoritative pending slot), [ADR-0033](0033-permission-model-dual-axis.md)
  (F3, superseded here for the app-server backend),
  [ADR-0058](0058-codex-app-server-turn-steer.md) (Stage 3).
- [Transport reference](../reference/engines/codex-app-server.md#approval-requests-adr-0064),
  [wrapper configuration](../reference/configuration/wrapper.md#codex-approval-axis-controls),
  [Stage 3 evidence](../evidence/codex-app-server/stage3-approval-probes-2026-09-30.md).
