---
title: operator latency and dashboard display conditions
status: proposed
date: 2026-07-21
opened: 2026-07-21
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [12, 20, 21, 22, 33]
---

# ADR-0041 — monitor display conditions

## Status

Pro。 kaoiro has completed a collision with the measurement definition of the paper project,
The implementation and the change of the protocol schema are not yet supported.

## Context

kaoiro correlates `permission_request` and `permission_decision` with `request_id`
`waiting_permission` can be presented to dashboard. However, the current time is recorded.
Only ISO 8601 `ts` that `PermissionBroker.decide()` of the wrapper is attached to the request generation
Comment This value is the same as the following two points:

- `permission_request` `ts`
- `state_change.ext.pending_permission.ts` ([ADR-0022](0022-pending-permission-authoritative-source.md) authoritative source)

This is the request generation time, and br er is actually in the operator
It is not the time presented. current dashboard → server → wrapper
`permission_decision` has only `{agent_id, request_id, allow}` and present time,
Do not record judgment time, wrapper resolution time, latency, or end time. host
The browser clock does not guarantee the match.

In the future experiment, in addition to the measurement of permissionncy late, the observation stimulation of the AgentDetail is four conditions
Switch. The permission dialog itself and the operation function can be combined with the condition.
schema is required.

Book ADR does not decide the complete experimental base of trial/replay/export. required at first stage
Fix permission measurement and display condition vocabulary only.

## Decision

### D1. Leave time

Correlation of one lifecycle with `request_id`, and the following four-time as a separate concept
Record.

| field |Signs|clock owner||
|---|---|---|---|
| `requested_at` | `t_request` | wrapper wall clock | `PermissionBroker.decide()`when the request is generated. Existing`pending_permission.ts`Same value|
| `presented_at` | `t_presented` | browser wall + monotonic clock |`request_id`The dialog is reflected in theoper and the time it is possible to show to the operator|
| `decided_at` | `t_decision` | browser wall + monotonic clock |The allow/deny operation of the operator is received by dashboard|
| `resolved_at` | `t_resolved` | wrapper wall clock |time when the pending promise is settled for allow / deny / timeout / close etc.|

`t_request` and `t_resolved` are engine host lifecycle, `t_presented` and
`t_decision` represents the operator UI lifecycle. DeHome network delays and draw delays
Don’t crush these fours into one “request timestamp” because they don’t mix them into time.

wall-clock field is ISO 8601 UTC string. 2 hours owned by browser
monotonic timestamp in the same browser context.

```ts
interface BrowserMeasurementTime {
  wall: string;          // new Date().toISOString()
  monotonic_ms: number;  // performance.now()
  context_id: string;    // page lifecycle per random id
}
```

`context_id` is updated with reload / navigation. different `context_id` monotonic
Let's reduce the value.

### D2. The main indicator is browser monotonic clock.

The primary indicator `latency_ms` is calculated only when observation is performed in the same browser context.

```text
latency_ms = t_decision.monotonic_ms - t_presented.monotonic_ms
```

The value must be 0  and 0 or higher. clock owner
`t_request → t_presented`、`t_decision → t_resolved`、`t_request →
t_resolved` for diagnosis wall-clock interval can be retained,operator Time
not the main indicator. NTP correction and host/br er clock skew


presentation is not the time passed to the state,
The time when the target dialog is visible after the dialog update is completed. Same
`request_id` / `context_id` record only once for the same drawing
Do not overwrite in reJapanese terming. pending after reload / navigation or reconnect
If dialog is restored, add the first presentation to `presentations` instead.

latency eligibility is determined by the following rules for the entire lifecycle:

| lifecycle | `latency_eligible` | `latency_ms` |
|---|---:|---|
|Presentation in the same context → decision, the middle context change / no reconnect| `true` |First presentation to decision|
|context changes or reconnects after the first presentation| `false` |absent. Don't measure from presentation after restoration|
|pending Restore or resolution failure to recover| `false` |absent. terminal`correlation_lost` |

If you measure from the presentation after the restoration, the operator will drop the time that it was observed before cutting,
systematically underrated latency. For this reason, after a lifecycle that has become `false`
`true` 0 ms
Not complemented.

### D3. Record terminal outcomes and anomaly separately

The minimum record has the following logical shape: The final arrangement on the transport is implementation plan
Synchronizes the protocol type and server validation, but the meaning of the field is SSoT and


```ts
type PermissionTerminalOutcome =
  | "allowed"
  | "denied"
  | "timeout"
  | "wrapper_close"
  | "correlation_lost";

type PermissionAnomaly =
  | "late_decision"
  | "duplicate_presentation"
  | "duplicate_decision"
  | "context_changed";

interface PermissionPresentation extends BrowserMeasurementTime {
  condition: ObservationCondition;
}

interface PermissionMeasurement {
  request_id: string;
  agent_id: string;
  session_id?: string;
  requested_at: string;
  presentations: PermissionPresentation[];
  decided_at?: BrowserMeasurementTime;
  resolved_at?: string;
  latency_ms?: number;
  latency_eligible: boolean;
  terminal_outcome?: PermissionTerminalOutcome;
  anomalies: PermissionAnomaly[];
}
```

terminal outcome

- `allowed` / `denied`: operator decision pending request for wrapper
settle
- `timeout`: `permission_timeout_ms` fail-closed deny.
- `wrapper_close`: `PermissionBroker.close()` at wrapper shutdown
pending request settle with deny.
- `correlation_lost`: pending cannot be restored or observation disabled
Fixed and couldn’t correlate with normal terminal outcomes.

disconnect is an event on lifecycle and it is not terminal outcome.
The same `request_id` restores from authoritative pending state
Keep lifecycle while you can. wrapper disconnect also after reconnection
It is similar to the possibility of correlation, only when the unrecoverable is confirmed
`correlation_lost`

The meaning of anomaly is:

- `late_decision`: terminal outcome
Arrival
- `duplicate_presentation`: two or more dialog presentations in the same context
Comment The first effective presentation is held.
- `duplicate_decision`: terminal outcome 2 or more observation
Comment The first valid decision is held.
- `context_changed`: reload / navigation, or
Abortion of measurement context caused by reconnect. Even if pending is restored
`latency_eligible=false` does not measure from presentation after restoration.

anomaly does not destroy terminal outcomes. before terminal because it is an array
`duplicate_decision` and `late_decision` after terminal occur in the same lifecycle
Never lose information. Not overwrite terminal record when using a durable store
append-only observation and ag ation view is terminal outcome and anomaly
Expand to flags.

`timeout` / `wrapper_close` / `correlation_lost`
`decided_at` and `latency_ms` are absent. wrapper did not settle
`resolved_at` is absent for `correlation_lost` or ignored anomaly event.
does not compensate as 0 ms.

### D4. display condition is closed enum

Agent the next closed enum in the observation area of AgentDetail.

```ts
type ObservationCondition =
  | "raw_log"
  | "state_only"
  | "expression_only"
  | "combined";
```

| condition | transcript/raw log |state label|facial sprite|
|---|---:|---:|---:|
| `raw_log` |display|non-display|non-display|
| `state_only` |non-display|display|non-display|
| `expression_only` |non-display|non-display|display|
| `combined` |display|display|display|

Specifically, only observe stimulation of AgentDetail. The following operator control is
Contact Us

deny permissions
- How to use question / input dialogs, composer, interrupt, etc.
- close / navigation and control to stop the experiment safely

stimulation of auxiliary information such as agent name, Stimulation/permission metadata, model/model/context
To include or otherwise fix the experiment protocol. The display implicitly from the four conditions of this ADR
Don't increase or decrease. In the first implementation, you can reuse the current settings localStorage pattern,
Each `presentations[]` element of measurement record presents permission dialog
**Effective condition**copy and change settings after past record
Do not change.

### D5. Conforming with existing permission protocol

- `permission_request.payload.request_id`
`state_change.ext.pending_permission.request_id` with lifecycle correlation key
Don't add a new ID.
- `requested_at` duplicates existing `pending_permission.ts` as a normal value.
legacy `permission_request` The outer frame of envel  `ts` is the same, but the dashboard is
authoritative pending record
- `permission_request` maintains the role of the first notification and presents authoritative
Don't promote to source. after join/reconnect `ext.pending_permission` dialog
You can add presentations in the browser context to the array.
However, after the first presentation, the context change / reconnect is
`latency_eligible=false` + `context_changed` and latency from the restored time
Not recal d.
- The current `permission_decision` allow/deny semantics does not change. Measurement field
The wrapper is also included in the decision relay.
Let's differentiate and lose the decision itself because of unknown/fair measurement values.
- Don't send permission payload / measurement to viewer. operator-only
inherit the existing policy role ([ADR-0021](0021-role-information-dis sure-policy.md)).
- Codex exec does not generate lifecycle with `approval: "never"`
([ADR-0033] (model3-permission-model-dual-axis.md) F3). record absent
AJapanese termmetric of current engine capability.

### D6. Completion and Non-Goal

Corres ing to the minimum implementation completion condition by separating the four-time for theudeude permission request
browser monotonic
Recal d from clock and preserves condition, ter  outcome, and anomalies when presented
What can we do?

Non-Target ADR:

- Codex exec approval
- trial / condition assignment experiment planning, subject ID, randomization
- storage format for durable export
- deterministic reexecution of trace playback or engine
clock clockhronization

## Consequences

- Request generation and presentation
Can be distinguished.
- The influence of host/br er clock skew to close the main indicator to a single browser clock

- reload/reconnect,timeout,shutdown,correlation loss,late/duplicate anomaly
can be separated from normal allow/deny, and can be expressed with latency eligibility and missing processing.
- The display condition can be implemented in client-local, but it is possible to reproduce
There is a required to fix the actual value to record.
- wrapper side resolution to get `t_resolved` and non-click outcomes accurately
is required and only client can not complete four-time schema.

## Alternatives considered

|||
|---|---|
| `permission_request.ts`from click time to ncy late|rejected. host-br er clock skew|
|browser wall clock|rejected. The negative value and disco ance can occur with wall clock correction. Make monotonic the main indicator|
| `state_change(waiting_permission)`Presentation at reception|rejected. Receive andVisualization Visualization drops background tab / render queue|
|timeout / close to deny|rejected. distort operator behavior and system default, distort intervention rate and latency interpretation|
|4 conditions are expressed by boolean independently|rejected. undecided step-by-step combination and experiment conditions make drift open enum|
