---
title: Claude SDK notification turns and reply-origin guidance
description: Investigation-backed behavior options and a proposed conservative correction for issue 422.
status: proposed
last_updated: 2026-09-27
---

# Claude SDK notification turns and reply-origin guidance

## Decision requested

Recommend **explicit rejection with accurate guidance as the immediate change**.
A background-notification continuation must not silently inherit a retired or
unrelated wrapper input. This deliberately leaves notification-only replies
unavailable until a new wrapper-delivered input; it corrects diagnostics, not
the loss of automatic background replies. If restoring those replies is the
required acceptance criterion, choose the larger lifecycle work below instead
of marking the incident resolved by guidance alone.

No product implementation is included. Kuroe owns the decision and will route
this frozen proposal to Fuji for design review before implementation. Review
must-fix rounds are counted across this deliverable, with the session's
three-round ceiling. User-visible behavior changes need the operator's
judgment; this proposal is not that approval.

## Problem and evidence

At production commit `b71674a28baa0b1e4b113dca40ce02b220e6373c`, actual SDK
0.3.280 / CLI 2.1.280 starts a model continuation after a background Bash
completion without a wrapper-fed input. The preceding successful result
retired both `ToolOrigins` and the reply snapshot. New tool IDs therefore have
no origin. The final continuation result identifies
`origin.kind: "task-notification"`; that information arrives after the send.
The no-background control sends normally.

See the [actual-host evidence](../evidence/2026-09-27-issue-422-notification-turn.md)
and its [captured events](../evidence/2026-09-27-issue-422-notification-turn.json).
The failure is reproduced in a fresh session with the current MCP registration.
The generic local error formatter incorrectly calls this spent/expired
authorization. There is no snapshot timeout involved in the observed failure;
`ReplyBasis.live(undefined)` rejects before ticket validation. Supplying a
fresh ticket cannot make an unbound call live.

## Options and tradeoffs

| Option | Benefit | Cost / unresolved requirement |
| --- | --- | --- |
| A. Model SDK-created turns explicitly and give them independent snapshots | Restores legitimate automatic replies after background work | Requires an authoritative pre-tool start boundary and correct arbitration with queued wrapper input, cancellation, and result ownership; not established by this probe |
| B. Keep the origin guard and explain rejection accurately (recommended now) | Small correction supported by the measurement; preserves input provenance and prevents misleading retries | Background-only continuations still cannot reply; a new wrapper-delivered operator/peer input is required |
| C. Keep the prior token alive, or bind an unknown call to the latest token at MCP-handler time | Would make the simple reproduction send | Reuses retired authorization or borrows unrelated input, violating the issue 407 origin invariant; rejected |

Option A must create a **new** token, not resurrect the task-launch token.
The snapshot may include only peer inputs already handed to this same SDK
session. A task notification itself advances no peer conversation basis;
queued-but-undelivered input is excluded. Previously issued tickets and old
call IDs remain retired. Notification receipt alone is insufficient because
completion can arrive during an existing turn, multiple notifications may be
coalesced, and the host may have a queued input already yielded to the SDK.
`system/init` lacks the identity needed to distinguish these cases. Neither
`result.origin` (too late) nor the measured replay option establishes the
required boundary.

If A is selected, first measure an SDK-supported pre-tool start/consumption
signal, including a notification racing a queued wrapper input. Consider a
new shared host lifecycle event for SDK-originated input only after that
measurement. Its ownership must cover snapshot begin/end, tool-ID binding,
permission waits, watchdog start/end, result attribution, and session-reset
coordination. Do not synthesize peer delivery acknowledgements or settle an
unrelated coordinator token. Distinguish root and subagent frames. If the
signal cannot be established, report that boundary as unmet and retain B;
do not add an inferred-current-token fallback. This is a separate design
increment before code, not an approved implementation hidden in this proposal.

## Immediate change specification (option B)

Scope: `wrapper/agent-common/src/inter_agent.ts`, its existing reply-basis
error tests, and the reply-basis/error reference documents. No change to
schemas, ticket generation, origin binding, host scheduling, transport, or
server checks. Do not add model calls to the automated tests.

Keep `error` and `send_not_attempted: true`; add distinct guidance branches:

| Error | Exact proposed guidance |
| --- | --- |
| `unbound_tool_call` | `This tool call is not bound to a live wrapper-delivered input. No message was sent. Wait for a new operator or peer input delivered by the wrapper before sending again. Retrying in this continuation, changing conversation_id, or adding a reply ticket cannot bind this call.` |
| `stale_tool_call` | `The input that owned this tool call has ended or been cancelled. No message was sent. Do not retry this call; send from a new live wrapper-delivered input.` |

Do not identify every unbound call as a background notification: missing
metadata and registry exhaustion can also produce that code. Do not advise
starting a new conversation as a workaround. The spent/expired-ticket message
remains for its current ticket outcomes; unrelated local-error guidance is
outside this narrow change. Lifecycle warnings observed during the probe are
follow-up scope, not fixed by a diagnostic change.

## Verification and review gates

1. Exercise the actual shared `InterAgentTool` with default constructor
   dependencies except the transport recorder needed to count sends. Enable
   negotiated v1. An invocation without origin must return the exact unbound
   guidance and produce zero sends. This covers its first meaningful operation.
2. Begin a real snapshot, end it, then invoke using that token: exact stale
   guidance and zero sends. With a live snapshot, retain a normal-send positive
   control. Check existing spent/expired-ticket cases remain distinct.
3. Mutation: remove each new error-specific branch independently; its behavior
   test must fail. Restore and rerun. Do not weaken the no-send assertions.
4. Run the affected agent-common suite and typecheck, then the wrapper build
   required for the shared dependency. Record command exit codes and warnings.
   Review the final delta after tests. Bind reported results to the final commit.
5. Update `docs/reference/inter-agent/reply-basis.md` and
   `docs/reference/inter-agent/errors.md` to state the observed Claude
   notification-only limitation and accurate recovery. Keep this evidence
   unchanged; if measuring a new implementation, record new evidence.

If option A is later implemented, add cases for notification while active,
notification after result, multiple/coalesced tasks, wrapper-input races,
late MCP callbacks, subagent frames, interrupt, EOF, reset/resume, and waiter
recovery. Assert both allowed sends and forbidden old/unknown sends, with
server-call counts. Use the actual native SDK for the disputed boundary;
recorded-frame tests alone cannot prove it. Do not make the current baseline
probe look like a passing fix test by merely expecting its rejection.

## Relationship to issue 419

The two observed symptoms have different immediate failure points:

- Issue 422 loses the host's per-call origin after a result when the SDK starts
  an untracked continuation. A fresh session reproduces it without schema
  replacement or resume.
- Issue 419 reports model-visible tool-schema drift after resume. Its caching
  hypothesis has not been verified here. The current registered schema alone
  is not proof of the schema shown to a resumed model.

Therefore resume/schema drift is not a necessary cause of issue 422, and
restoring ticket fields cannot repair an unbound origin. The symptoms can
coexist and both affect the issue 407 reply flow. There is no evidence here
for one shared underlying SDK defect; keep the investigations separate.
