---
title: "Draft ADR-0040 addendum: Codex app-server context snapshots"
status: implemented-pending-review
last_updated: 2026-10-03
---

# Draft ADR-0040 addendum: Codex app-server context snapshots

This is the proposed addendum to [ADR-0040](../adr/0040-context-usage-capability.md),
for [issue #485](https://github.com/sakuraiyuta/kaoiro/issues/485). The operator
[chose Adopt](https://github.com/sakuraiyuta/kaoiro/issues/485#issuecomment-5954688714)
on 2026-10-02. The five requested paths have now been
[measured on pinned Codex 0.159.3](../evidence/codex-app-server/context-usage-qualification-2026-10-03.md).
Independent design review approved this plan (must 0) on 2026-10-03. The
director authorized implementation with the review follow-ups below.

## Proposed ADR addendum

### Scope and rationale

Replace D3 only for the app-server backend when this design is approved and
implemented. Exec remains `supports_context_usage: false` and never stamps
`ext.context`. D1's capability-only display and the existing three-field context
payload remain intact. No account data or new protocol field is required.

D3 rejected `turn.completed.usage.input_tokens` as a context proxy, and left
room to reconsider upstream compaction telemetry. The new evidence identifies
an atomic native snapshot, `last.totalTokens`, and a native nullable window.
A decrease after compaction is expected for occupancy; the historical Context
§2(b) rationale must not be applied to reject a qualified post-compaction
snapshot. The contract describes the latest qualified native response snapshot,
not the exact size of the next provider request or an admission guarantee.

Choices considered:

| Choice | Decision and reason |
| --- | --- |
| Keep false indefinitely | Not chosen: the operator chose adoption subject to qualification. |
| Reconstruct input/output, use cumulative totals, or copy TUI percentage | Reject: reconstruction loses compaction totals; cumulative values measure repeated requests; the TUI percentage uses a different denominator. |
| Display native boundary estimates or restore arbitrary resume replays | Reject for this contract: boundary estimates have no ordinary-response breakdown, and replay cannot establish the model/generation that produced the old reading. |
| Publish qualified native snapshots, with unknown intervals | Chosen: preserves native totals and provides explicit boundaries without inventing counts or windows. |

### Values, capability and unavailable readings

For a qualified, structurally valid native snapshot:

```text
used_tokens     = tokenUsage.last.totalTokens
max_tokens      = tokenUsage.modelContextWindow
used_percentage = 100 * (used_tokens / max_tokens)
```

All counts must be nonnegative safe integers and the window a positive safe
integer, using the actual `appServerUsage` parser. The percentage must be
finite. Preserve the native total; do not reconstruct it, add reasoning again,
subtract cached input, use cumulative `total.*`, infer a catalog window, or
carry forward the preceding snapshot's window. A null/missing window means
unknown. Malformed current-turn usage also invalidates the reading instead of
silently preserving an older known value.

`last.totalTokens > modelContextWindow` is valid telemetry: the live default
composition reported 272,534 out of 258,400 tokens. Preserve the finite raw
ratio (105.4698%) and both counts, without denominator inflation or wire-level
clamping. Existing dashboard bars already clamp their visual extent; the raw
fields and peer/directory percentage retain their mathematical meaning. Update
documentation that assumes a raw-window reading cannot exceed 100. The reported
window is neither a provider hard admission limit nor an auto-compaction trigger.

Once implemented, the app-server backend advertises
`supports_context_usage: true` even when a reading is unavailable. Unknown means
omitting `ext.context`, not zero, a fabricated window, or changing capability
to false. Construct the extension from the current meter state on every
`state_change`. A known-to-unknown transition immediately emits a fresh state
without the old field. Keep D1's existing unavailable/loading display; adding a
new UI label is outside this change. Value changes emit once; equal known
readings are deduplicated. No timer, account request or extra model turn is
introduced to refresh the meter.

### State and ownership

The host owns one meter state per live session: an increasing session/model
generation, the bound native thread, `known` or `unknown`, compaction items
currently open, and at most one current-owned-turn candidate. A dispatch records
its generation, host turn token and effective model from the runtime baseline
plus the submitted settings. Native turn identity is attached only after the
validated start response. Neither the usage event nor its window names a model.

Compaction advances the context generation but does not change the dispatch's
model binding. Candidates are cleared at its start; later response candidates
in that same owned turn attach to the new context generation. A model change,
session replacement or close revokes the old dispatch's eligibility entirely.
This distinction allows automatic compaction to recover within its current
turn while forbidding an old model's in-flight response from restoring the meter.

| Input/event | State transition |
| --- | --- |
| New wrapper/session, new/reset thread, successful transport replacement | Advance session generation; unknown; discard all candidates/windows. |
| Accepted model request | Unknown immediately; advance model generation and revoke the old dispatch. A setter rejected before acceptance does not invalidate. Rollback never restores a saved snapshot; a later successful turn must qualify again. |
| Bound-thread `contextCompaction` item start | Unknown immediately; advance context generation once for that item; clear the candidate and mark the item open, including outside a host-owned turn. |
| Matching item completion | Remove that open item; stay unknown. Item completion alone does not restore the estimate. |
| Boundary estimate or replayed usage | Do not publish. A zero input breakdown is never sufficient evidence of an ordinary response. All resume replays are suppressed, even if structurally valid. |
| Qualified usage in a current owned turn | Replace the single candidate with that full atomic snapshot and the current context generation. Do not publish yet. |
| Successful owned terminal with committed settings, matching model/session generation, no open compaction and a current candidate | Commit the candidate to known after settings/model commit, before the resulting state stamp. The candidate must occur after the latest completed boundary. |
| Failed/interrupted/abandoned owned terminal, unresolved start, disconnect or close | Discard the candidate and go unknown. A closed/revoked generation cannot emit or repopulate state. |
| Unrelated thread, old RPC child, old/completed turn, duplicate item event | No state change. Deduplicate boundary starts so they do not advance generation twice. |

A qualified ordinary-response candidate has a positive `last.inputTokens`,
belongs to the current named host-owned turn, arrives outside an open compaction,
and follows a completed `agentMessage` or `reasoning` item in that turn after
the last boundary. It is accepted only at that turn's successful terminal with
committed settings. Input/output equality is not substituted for the native total. This
predicate deliberately prefers unknown when provenance is incomplete; it does
not claim every future provider's valid response must have positive input.

The same success point can restore a value after automatic compaction in its
own turn; it is unnecessary to wait for another model turn. Explicit compaction
outside an owned turn invalidates and stays unknown. This adds no permission
to start foreign turns and does not relax the existing foreign-turn stop gate.
No bounded-number-of-readings fallback is used for freshness.

Claude provides a boundary-invalidation precedent, not this qualification rule:
its next successful SDK reading restores the display unconditionally, while
its epoch-settling gate controls threshold notices. This stricter Codex policy
is based on the observed native event identities/order and is an intentional
adapter-specific choice.

### Consequences and limits

The meter becomes available for app-server after a qualifying response, retracts
at identified boundaries, and may stay unknown through an idle resume. That
loss of immediate replay display is deliberate because the old event cannot
establish its model/generation. Normal in-progress turns can retain the previous
qualified response reading until they finish or an invalidating event occurs;
the value is a response snapshot, not a continuously sampled current prompt.

The pinned evidence covers two models with the same reported window. A different
window or null transition must be guarded by deterministic tests rather than
claimed as a live observation. The host trusts the complete window in a new qualifying
native event; it makes no claim to independently detect an upstream-internal
stale window or infer the provider's actual hard limit. Other releases/providers,
images and tool-heavy turns remain outside the live qualification.

Codex peers also acquire the existing dashboard fatigue sprite at 60% or more
of the reported model window; engine-specific thresholds are outside this scope.

No cost/rate-limit accounting, reasoning transcript, approval/permission,
steering, signal/cleanup, runner allowlist, or server persistence behavior changes.
No automatic interrupt or budget-threshold notice is added by this work.

## Implementation surface after design approval

1. Add a typed context-telemetry callback in `app_server_transport.ts`, forwarded
   through `AppServerSession` and `AppServerHostRuntime` to the host. Observe raw
   bound-thread compaction items and usage before the existing no-active-turn
   early return. Guard the callback by current RPC identity/generation, bound
   thread and close state. Leave account telemetry and foreign-turn admission
   separate. Do not treat context telemetry as input, turn evidence, queue work
   or transcript content.
2. Use the existing bounded pre-start response buffer for usage requiring a named
   owned turn; do not guess ownership before its response. Compaction starts
   can invalidate independently. Notify the context reducer once for each raw
   event; existing per-turn `kind: "usage"` remains a retained internal snapshot,
   not a second publication path. A thread-level invalidation must work while
   idle and through resume/history reads.
3. Add the host-owned reducer and dispatch binding through the current runtime
   `onDispatch`/`onHandoff`/completion path. Use the baseline plus actual prepared
   settings, including pending settings and rollback. Commit a candidate only
   after `settingsCommitted` and the host's model update; a concurrent accepted
   model request makes the older candidate ineligible.
4. Select capability from the backend, stamp/retract context lazily from current
   state, and clear it through existing model/session reset and close paths.
   Existing whole-envelope server replacement and capability-gated directory
   projection should need no Elixir change; verify retraction rather than assume
   an omitted field clears all downstream surfaces.

The host reducer is the single owner of publication. The transport supplies
typed facts and identity; the projection continues to own turn display. Do not
introduce an unbounded history of candidates or one reducer in each layer.

## Verification required after implementation

Deterministic tests may use the existing fake RPC/session harness and measured
notification sequences. They must not claim to validate native semantics.

| Contract | Test and negative control |
| --- | --- |
| Backend capability | App-server advertises true; an explicit exec backend still advertises false and emits no context. Advertising true regardless of backend must fail the exec test. |
| Atomic formula; no reconstruction or reasoning double-count | Measured reasoning/estimate samples, unequal native total, cached input and cumulative mismatch; replacing the native total with input/output or adding reasoning must fail. |
| Positive/nullable window and finite raw ratio | Null/missing/invalid windows, zero counts, safe-integer limits and the real 272,534/258,400 sample; deleting the window guard or clamping the wire ratio must fail. |
| Compaction invalidates before estimate; automatic recovery in same turn | Exact native item/usage order plus incomplete/failing boundaries and duplicate starts; cut invalidation or allow the estimate and assert the outward context is absent where required. |
| Resume and unrelated/late events cannot restore | Replays before/after opening, old native turn IDs, a foreign thread and a revoked RPC child; removing each identity/generation guard must fail. |
| Model association and success commit | Pending/failed/rollback switch, switch during an in-flight old turn, distinct/null next window, terminal before queued callbacks and close during permission observation; cutting model invalidation or the success-commit gate must fail. |
| Consumer wiring and downstream removal | Real callback chain and emitted state, then server directory/dashboard projection; disconnect a callback/retraction stamp and assert stale context is observed as a failure. |

Add one credentialed live default-composition gate using actual `runCodexCli`,
default host/session/transport, pinned native binary and a local Phoenix endpoint.
It must reach a successful ordinary response and assert capability true plus the
real outward context triple, then exercise one invalidating boundary. Do not
inject a host/session factory or substitute a fake native response. If credentials
are unavailable, report the gate as blocked, not a green default-composition
test. The current research ran the old false-capability code and cannot validate
the future consumer wiring.

For its consumer negative control, disconnect the host publication callback,
rebuild from the mutated source, run the same production gate invocation and
require a nonzero exit from its missing-context assertion. Restore, rebuild and
rerun the positive gate, binding final code/artifacts and logs by path/hash.
Stopping is limited to directly held, self-started PIDs and awaited closure;
no process discovery or kill-target mutation is required.

Run Codex package tests/typecheck/build and the affected shared wrapper suites,
runner tests/typecheck, server context/directory regression tests and dashboard
tests/check. Expand only for a new failure or changed surface. Retain research
raw capture until the issue closes; remove temporary mutation copies and owned
process/terminal fixtures at their completed boundary.

## Documentation and handoff

After design approval, record the agreed addendum in ADR-0040, preserving the
historical D3 and stating the app-server-only supersession. During implementation
update `docs/reference/engines/codex-app-server-events.md`, backend architecture,
capability/context and UI field semantics, the Codex package README, and the
protocol context comment if its semantics need clarification. Keep exec's
reference/capability unchanged. Link the evidence rather than duplicate its
event counts, and replace any claim that no peer-facing context is projected.

The director owns assignment of the independent implementation reviewer.
Implementation starts from develop `d68a0165` on a separate branch; the research
branch and raw captures remain frozen until the issue closes.

Implementation checks and artifact bindings are in the
[2026-10-03 verification record](../evidence/codex-app-server/context-meter-implementation-2026-10-03.md).
