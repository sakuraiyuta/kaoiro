---
title: Measurement schema for operator permission latency and dashboard display conditions
status: proposed
date: 2026-07-21
opened: 2026-07-21
supersedes: []
superseded_by: null
related_specs: [protocol, architecture, threat-model]
related_adrs: [12, 20, 21, 22, 33]
---

# ADR-0041 — Measurement schema for operator permission latency and dashboard display conditions

## Status

Proposed. Alignment with the measurement definitions of the kaoiro paper project
is complete, but implementation and changes to the protocol schema have not yet
started.

## Context

kaoiro correlates `permission_request` and `permission_decision` by `request_id`
and can present `waiting_permission` on the dashboard. However, the only time
currently recorded is the ISO 8601 `ts` attached by the wrapper's
`PermissionBroker.decide()` when the request is generated. This value appears as
the same value in the following two places:

- the outer `ts` of the `permission_request` envelope
- `state_change.ext.pending_permission.ts` (the authoritative source of
  [ADR-0022](0022-pending-permission-authoritative-source.md))

This is the request-generation time, not the time when the browser actually
presented the permission dialog to the operator. The current dashboard → server
→ wrapper `permission_decision` contains only `{agent_id, request_id, allow}`;
it records neither the presentation time, decision time, wrapper resolution time,
latency, nor termination reason. There is also no guarantee that the host and
browser wall clocks are synchronized.

Future experiments will switch AgentDetail's observation stimulus among four
conditions in addition to measuring permission latency. A schema is needed that
can join measurements to conditions without removing the permission dialog or
operational controls and thereby compromising safety.

This ADR does not establish a complete trial/replay/export experiment platform.
It fixes only the permission measurement and display-condition vocabulary needed
for the first stage.

## Decision

### D1. Separate the permission lifecycle into four timestamps

Correlate one permission lifecycle by `request_id` and record the following four
timestamps as distinct concepts.

| field | symbol | occurrence / clock owner | meaning |
|---|---|---|---|
| `requested_at` | `t_request` | wrapper wall clock | The time when `PermissionBroker.decide()` generated the request. Equal to existing `pending_permission.ts` |
| `presented_at` | `t_presented` | browser wall + monotonic clock | The time when the dialog for the target `request_id` was reflected in the DOM and became presentable to the operator |
| `decided_at` | `t_decision` | browser wall + monotonic clock | The time when the dashboard accepted the operator's allow / deny action |
| `resolved_at` | `t_resolved` | wrapper wall clock | The time when the broker settled the pending Promise through allow / deny / timeout / close, etc. |

`t_request` and `t_resolved` represent the engine-host lifecycle, while
`t_presented` and `t_decision` represent the operator-UI lifecycle. Do not
collapse these four into a single “request timestamp,” so that network and
rendering delays are not mixed into decision time.

Wall-clock fields are ISO 8601 UTC strings. The two browser-owned timestamps also
include monotonic timestamps from the same browser context.

```ts
interface BrowserMeasurementTime {
  wall: string;          // new Date().toISOString()
  monotonic_ms: number;  // performance.now()
  context_id: string;    // page lifecycle ごとの random id
}
```

Update `context_id` on reload / navigation. Never subtract monotonic values from
different `context_id` values.

### D2. Use browser monotonic-clock decision latency as the primary metric

Calculate the primary metric `latency_ms` only when the observations are in the
same browser context:

```text
latency_ms = t_decision.monotonic_ms - t_presented.monotonic_ms
```

The value must be finite and at least 0. The cross-clock intervals
`t_request → t_presented`, `t_decision → t_resolved`, and
`t_request →
t_resolved` may be retained as diagnostic wall-clock intervals, but
are not the primary metric for operator decision time. NTP correction or
host/browser clock skew can make them negative.

Presentation means the time after the Svelte DOM update when the target dialog has
been confirmed visible, not the time when the permission record was incorporated
into state. Record only the first presentation for the same rendering within the
same `request_id` / `context_id`; do not overwrite it on a mere re-render. If a
pending dialog is restored after reload / navigation or reconnect, append it to
`presentations` without replacing the first presentation.

Determine latency eligibility for the entire lifecycle using these rules:

| lifecycle | `latency_eligible` | `latency_ms` |
|---|---:|---|
| Presentation → decision in the same context, with no context change / reconnect in between | `true` | Calculate from the first presentation to the decision |
| A context change or reconnect occurs after the first presentation | `false` | absent. Do not measure again from the restored presentation |
| Recovery of pending restoration or resolution correlation is confirmed impossible | `false` | absent. Terminal outcome is `correlation_lost` |

Measuring from the restored presentation loses the time the operator observed
before disconnection and systematically underestimates latency. Therefore, once a
lifecycle becomes `false`, do not return it to `true` through a later reconnect /
presentation. Do not impute missing values as 0 ms.

### D3. Record terminal outcomes and anomalies as separate types

The minimum record has the following logical shape. The final transport placement
will synchronize the protocol type and server validation in the implementation
plan, but this ADR is the SSoT for field meanings.

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

The terminal outcomes mean the following:

- `allowed` / `denied`: The operator decision settled the wrapper's pending
  request as the terminal outcome.
- `timeout`: The broker fail-closed denied it because of
  `permission_timeout_ms`.
- `wrapper_close`: The pending request was denied and settled by
  `PermissionBroker.close()` during wrapper shutdown.
- `correlation_lost`: It was confirmed impossible to restore the pending request
  or observe its resolution, so it could not be correlated with a normal terminal
  outcome.

Disconnect is a lifecycle event, not itself a terminal outcome. The lifecycle
continues after browser reconnect while the same `request_id` can be restored from
the authoritative pending state. The same applies to a wrapper disconnect while
resolution may still be correlated after reconnection; record `correlation_lost`
only once recovery is confirmed impossible.

The anomalies mean the following:

- `late_decision`: A decision for the same `request_id` arrived after the terminal
  outcome was established.
- `duplicate_presentation`: The same dialog presentation was observed at least
  twice within the same context. Retain the first valid presentation.
- `duplicate_decision`: The same decision was observed at least twice before the
  terminal outcome was established. Retain the first valid decision.
- `context_changed`: A reload / navigation, or a measurement-context break caused
  by reconnect, occurred after the first presentation. Set
  `latency_eligible=false` even when the pending request can be restored; do not
  measure again from the restored presentation.

Anomalies do not destroy the terminal outcome. Because they are an array, a
`duplicate_decision` before termination and a `late_decision` after termination
can coexist in the same lifecycle without losing information. If a durable store
is introduced, retain observations as append-only records rather than overwriting
the terminal record, and have an aggregate view expand them into terminal outcomes
and anomaly flags.

For `timeout` / `wrapper_close` / `correlation_lost` without operator action,
`decided_at` and `latency_ms` may be absent. For `correlation_lost` where the
wrapper did not settle, or for ignored anomaly events, `resolved_at` may be absent.
Do not impute missing values as 0 ms.

### D4. Use a closed enum for the display condition

Introduce the following closed enum for the AgentDetail observation area.

```ts
type ObservationCondition =
  | "raw_log"
  | "state_only"
  | "expression_only"
  | "combined";
```

| condition | transcript/raw log | state label | expression sprite |
|---|---:|---:|---:|
| `raw_log` | shown | hidden | hidden |
| `state_only` | hidden | shown | hidden |
| `expression_only` | hidden | hidden | shown |
| `combined` | shown | shown | shown |

Apply this only to AgentDetail's observation stimulus. Keep the following operator
controls in every condition:

- permission dialog and allow / deny controls
- question / input dialogs, composer, interrupt, and other operational means
- close / navigation and controls for safely stopping the experiment

Whether agent name, engine/permission metadata, model/cost/context, and other
auxiliary information are included in the observation stimulus is fixed separately
by the experiment protocol. Do not implicitly add or remove displays based only on
the four conditions in this ADR. The first implementation may reuse the current
settings' localStorage pattern, but each `presentations[]` element in the
measurement record must copy the **effective condition** at the moment the
permission dialog was presented, so that later settings changes do not alter the
condition of past records.

### D5. Align with the existing permission protocol

- Use `permission_request.payload.request_id` and
  `state_change.ext.pending_permission.request_id` as the lifecycle correlation
  key. Do not add a new ID.
- Treat the existing `pending_permission.ts` as the canonical value for
  `requested_at`. The outer `ts` of the legacy `permission_request` envelope is
  also equal, but the dashboard reads the authoritative pending record according
  to ADR-0022.
- Keep `permission_request` as the initial-notification mechanism; do not promote
  it to the authoritative source of presentation. Even when the dialog is
  restored from `ext.pending_permission` after join/reconnect, append a
  presentation in that browser context. However, a context change / reconnect
  after the first presentation means `latency_eligible=false` +
  `context_changed`; do not recalculate latency from the restored time.
- Do not change the allow / deny semantics of the current `permission_decision`.
  Even when measurement fields are bundled with the decision relay, the wrapper
  must distinguish the operator decision from browser telemetry and must not lose
  the decision itself because measurement values are unknown/invalid.
- Do not distribute permission payloads / measurements to viewers. Inherit the
  existing operator-only role policy ([ADR-0021](0021-role-information-disclosure-policy.md)).
- Codex exec does not generate a permission lifecycle with `approval: "never"`
  ([ADR-0033](0033-permission-model-dual-axis.md) F3). An absent record is not
  missing data but an asymmetry of the current engine capability.

### D6. Completion conditions and non-goals

The minimum implementation is complete when it can correlate four timestamps for
Claude permission requests, recalculate `latency_ms` for eligible operator
decisions from the browser monotonic clock, and retain the presentation-time
condition, terminal outcome, and anomalies.

Non-goals of this ADR:

- removing the fixed approval setting for Codex exec
- experiment planning, subject IDs, or randomization for trials / condition assignment
- a storage format for durable outcome export
- trace playback or deterministic re-execution of an engine
- clock synchronization between wall clocks

## Consequences

- The existing `pending_permission.ts` is preserved while request generation and
  presentation are distinguished.
- Keeping the primary metric within a single browser clock avoids host/browser
  clock skew.
- Reload/reconnect, timeout, shutdown, correlation loss, and late/duplicate
  anomalies can be separated from normal allow/deny, with latency eligibility and
  missing-data handling made explicit.
- Display conditions can be implemented locally on the client, but the effective
  value must be fixed in the measurement record for reproducibility.
- Accurately obtaining `t_resolved` and non-click outcomes requires a resolution
  observation point in the wrapper; client-only changes cannot complete the
  four-timestamp schema.

## Alternatives considered

| Option | Decision |
|---|---|
| Use the interval from `permission_request.ts` to the click time as latency | Rejected. Network / server fan-out / browser rendering and host-browser clock skew are mixed in |
| Use only the browser wall clock | Rejected. Wall-clock correction can cause negative or discontinuous values; monotonic is the primary metric |
| Treat receipt of `state_change(waiting_permission)` as presentation | Rejected. Receipt and DOM visibility are different points, so background-tab / render-queue delays would be lost |
| Combine timeout / close into deny | Rejected. System defaults cannot be distinguished from operator action, distorting interpretations of intervention rate and latency |
| Represent the four conditions as independent booleans | Rejected. This creates undefined combinations and condition drift, so use a closed enum |
