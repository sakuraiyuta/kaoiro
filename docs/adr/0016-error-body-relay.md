---
title: Re)t.error message
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [10, 12]
---

# ADR-0016 — Relay to client of wrapper error body

## Status

Accepted

## Context

If an error (e.g. 500 Overloaded) occurs in the wrapper (Claude Code adapter),
Not reaching clients. `wrapper/src/host.ts` `run()`
`cli.ts` `result` payload
`{text?, is_error?}` does not have an error body field and client
(`dashboard/src/lib/AgentDetail.svelte`) see `is_error` and "End with error"
Only display a fixed string. I can not deal with the cause.

## Decision

- `result` to payload**`error_message?: string`**Add the wrapper
Error body**Home**Relay to the client via the command line.
- In addition to (a) SDK/API level error body (500 Overloaded, etc.),
  (b) **End of wrapper process**"Send the last error just before it falls"
Cover.
- Client pane `error_message`**Always display**(Typement, summary, etc.)
not masking).
- The new envel  type for error is not built (the extension of `result`).
- Like `result`**operator**
  ([ADR-0012](0012-response-display-and-dashboard-scope.md))。

## Implementation status (2026 03 added)

This ADR policy "Relay to operator without formatting error body" is alive,
**The field type specified by decision was not implemented as it is**。

- The `error_message` field does not exist in the codebase. 
`error_subtype` and `error_detail` in issue #123
2 Add field. S  to enable UI to sort by error type
End subtype (`error_max_turns` / `error_during_execution` /
`error_max_budget_usd` / `error_max_structured_output_retries`)
For the body.
- "Send the last error just before the wrapper process crashes" (b)
  **Unmounted**Home No process finishes.
- `error_detail` cuts to 16,384 UTF-8 bytes according to envel  limit
Send The principle of summarizing and masking is kept.

[protocol](../specs/protocol.md)

## Consequences

### Positive

- You can see the actual error contents, not fixed string "End with error" and you can investigate and deal with the cause.
- The last error will be sent even when the wrapper crash.

### Negative

- Implementing wrapper crashes to ensure "de ed last minute transmission"
Finish ).
- The error body can be mixed (operator limited delivery,
  [threat-model](../specs/threat-model.md))。

### Neutral

- #1(version、[ADR-0015](0015-protocol-version-stamping.md))・#3(session_id、
[ADR-0014](0014-session-resume-and-restore.md)
Comment

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|New envel  type for error| `result`Extensible, Excess|
|Display by formatting and abstracting the error body|You can check the cause. Shaper scrapes information|
|SDK error only.|The main cause of "fall and end"|

## Related

- spec: [protocol](../specs/protocol.md) result payload、
  [threat-model](../specs/threat-model.md)。
-) ADR: [0010] (0010-protocol-precisification.md),
  [0012](0012-response-display-and-dashboard-scope.md)。
- Origin: my-idea-efef
