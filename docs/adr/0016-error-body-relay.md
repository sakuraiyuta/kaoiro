---
title: Relay the wrapper error body to the client (result.error_message)
status: accepted
date: 2026-06-16
opened: 2026-06-16
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model]
related_adrs: [10, 12]
---

# ADR-0016 — Relay the Wrapper Error Body to the Client

## Status

Accepted

## Context

Even when an error (for example, 500 Overloaded) occurs in the wrapper (Claude
Code adapter), its body does not reach the client. `run()` in
`wrapper/src/host.ts` does not catch SDK errors; when it crashes, `cli.ts`'s
catch only writes to stderr. The `result` payload has only `{text?, is_error?}`
and no error-body field, so the client (`dashboard/src/lib/AgentDetail.svelte`)
only sees `is_error` and displays the fixed string "exited with an error." The
cause cannot be understood or addressed.

## Decision

- Add **`error_message?: string`** to the `result` payload, include the error
  body caught by the wrapper **as-is**, and relay it to the client through the
  server.
- In addition to (a) SDK/API-level error bodies (such as 500 Overloaded), cover
  (b) **abnormal wrapper-process termination** by sending the last error just
  before the process falls.
- The client **always displays** `error_message` in the detail pane (do not
  format, summarize, or mask it).
- Do not create a new error-specific envelope type (a `result` extension is
  sufficient).
- As with `result`, deliver it **only to the operator role**
  ([ADR-0012](0012-response-display-and-dashboard-scope.md)).

## Implementation status (2026-08-03 addendum)

This ADR's policy of "relaying the unformatted error body to the operator"
remains, but **the field shape specified by the Decision was not implemented as
written**.

- A field named `error_message` has never existed in the codebase. The
  implementation instead added two fields, `error_subtype` and `error_detail`,
  to the `result` payload in issue #123. The SDK termination subtypes
  (`error_max_turns` / `error_during_execution` /
  `error_max_budget_usd` / `error_max_structured_output_retries`) were separated
  from the body so the UI can branch by error type.
- (b), "send the last error just before abnormal wrapper-process termination,"
  is **not implemented**. There is no process-exit hook.
- `error_detail` is truncated to 16,384 UTF-8 bytes to match the envelope limit
  before being sent. The principle of not summarizing or masking is preserved.

The current wire specification is the `result` row in
[protocol](../specs/protocol.md).

## Consequences

### Positive

- The actual error content is visible instead of the fixed "exited with an
  error" string, allowing the cause to be investigated and addressed.
- The last error also reaches the client when the wrapper crashes.

### Negative

- An implementation is needed to reliably send just before a wrapper crash (a
  process-exit hook).
- Error bodies may contain sensitive information (mitigated by operator-only
  delivery, [threat-model](../specs/threat-model.md)).

### Neutral

- Group it in the same protocol.md revision as #1 (version,
  [ADR-0015](0015-protocol-version-stamping.md)) and #3 (session_id,
  [ADR-0014](0014-session-resume-and-restore.md)).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Create a new error-specific envelope type | A `result` extension is sufficient and a new type is excessive |
| Format or summarize the error body for display | The raw body is useful for understanding the cause; formatting removes information |
| Handle only SDK errors (exclude abnormal process termination) | Misses a primary cause of "crashed and exited" |

## Related

- Specs: the result payload in [protocol](../specs/protocol.md) and
  [threat-model](../specs/threat-model.md).
- Related ADRs: [0010](0010-protocol-precisification.md) and
  [0012](0012-response-display-and-dashboard-scope.md).
- Origin: my-idea-brief (rough note "relay the error body to the client," high
  priority).
