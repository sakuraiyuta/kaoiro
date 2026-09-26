---
title: Reply binding versus interruption for inter-agent crossings
description: Jointly reviewed engine measurements, option comparison, and recommendation for issue 407.
status: reviewed
last_updated: 2026-09-26
---

# Reply binding versus interruption

## Scope and evidence status

Research only; no production implementation or change to the frozen plan.
Repository baseline: `148a469a`. Frozen plan SHA-256:
`3113ff38d7347e75d201f53323e483624762c63333faa05168dbff54e626fd14`.
Kogane owns this report and the Codex/server comparison at `148a469a`. Kohaku
investigated Claude SDK 0.3.280 and Antigravity at `ba696b50`. These are different
source baselines, not a claim of an identical deployed build. Both authors
reviewed the other's saved observations and source anchors without rerunning
the other's probes. Kohaku reviewed the Codex draft with no must-fix findings;
the clarifications and joint recommendation below incorporate that review.

Labels below distinguish live measurements, source observations, and inference.
Model traffic in the new measurements used loopback Responses (Codex) and
Messages (Claude) servers; no real model API calls were made. The probes drive
the actual CLI and SDK, not a replacement implementation of interruption. They do not run an
unimplemented IA automatic-interruption path or prove production integration.

## Codex measurements

Measured Linux CLI: `@openai/codex` 0.156.1; SDK 0.156.1 with the repository's
existing patch. The shell's global `codex --version` is 0.157.0; it was **not**
the tested executable. The binary was explicitly selected from this worktree's
pnpm installation, the same pinned native package used by the app-server resolver.

Binary SHA-256:
`0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`.
Probe SHA-256:
`40cfc69931c156c419fb402254183ead6e901fdef48a94666507f941c18e56e8`.
Results SHA-256:
`faec793174a21a9d31a7d28eb44e32d30442987c4f0d620ab0bda9167831b85d`.

The probe started isolated sessions with local configuration and no inherited
credentials. For each backend it ran three cases: interrupt after a completed
command while a partial assistant message streams; interrupt during a Python
command; and the same command without interruption. The Python command wrote
`before`, slept three seconds, then appended `-after`. Its PID was captured by
the child itself. The next turn's actual outgoing model input and persisted
rollout were inspected. All recorded Python PIDs were gone at the final check.

| Observation | app-server `turn/interrupt` | SDK exec `AbortController` |
|---|---|---|
| Original dispatched user input in next model request | Retained | Retained |
| Completed assistant commentary | Retained | Retained |
| Completed tool call and successful tool output | Retained | Retained |
| Text streamed only as an unfinished output delta | Absent from next request and rollout | Absent from next request and rollout |
| Running-command marker after interruption and a 3.4 s observation delay | `before-after` | `before` |
| Same command without interruption | `before-after` | `before-after` |
| Running tool result seen on resume | `aborted by user after 0.1s` | `aborted` |
| Turn-level result | `interrupted` | SDK throws `AbortError` |
| Explicit `<turn_aborted>` developer notice on resume | Present | Absent in these runs |

The last row was checked against exact `<turn_aborted>` text in the captured
request bodies: present in both interrupted app-server cases, absent in the
exec and no-interrupt cases. The probe's broader `interruptionNotice` summary
flag also matched unrelated prompt text and is not evidence for this row.

The app-server result is a concrete counterexample to “interrupt prevents the
ongoing write”: the tool was represented as aborted, but its process completed
a later write. Exec stopped this particular command but preserved its first
write. Neither observation proves rollback or universal descendant cleanup.
Detached processes, external services, Git hooks, other platforms, and crash
windows were not measured.

The operator's input-retention hypothesis is supported **after dispatch** in
these cases. It does not establish preservation before the first engine input,
complete partial-output preservation, or consistency between history and
external effects. A new turn must reconcile work already performed.

### Validation and limitations

- Final probe: exit 0, six cases. Two no-interrupt cases are the behavioral
  controls. A checker over captured results exits 0; corrupting retained-input
  evidence causes the checker to exit 1. The checker is a disposable research
  aid, not a production guard or an acceptance test for issue 407.
- An earlier probe failed (exit 1) because its shell quoting caused a tool
  command to fail. Its history observation was not used as successful-tool
  evidence; the quoted command was replaced and all six cases rerun.
- Existing `host_pending_permission.test.ts` and
  `host_interrupt_after_terminal.test.ts`: six tests pass, exit 0. They use
  mocked SDK behavior and establish host bookkeeping, not CLI tool cleanup.
  Expected unknown-auth/model-catalog warnings were emitted; no unhandled
  errors were reported. No full suite is claimed for this research-only task.
- Installation was confined to the worktree. It exited 0 with missing prebuild
  probe-bin warnings and an ignored tesseract build-script warning.
- Temporary evidence at `/tmp/kogane407-interrupt.Oqukz7/` is retained only
  through peer review, then deleted by its author. This report retains the
  measured findings and artifact identities, not a permanent dependency on it.

## Claude and Antigravity evidence

Kohaku measured eight saved Claude scenarios once each: tool, tool-stubborn,
text, perm, hook, fold, fold-now, and fold-noquery. Kogane inspected all eight
`out-*.json` records and the probe, including captured model-request messages,
event times, child-state observations, and session summaries. This is a review
of Kohaku's measurements, not an independent second execution.

Claude SDK 0.3.280 reported `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`,
and `msg_lifecycle_v1`. Interrupting Bash returned a receipt and an error result;
its pending tool output became a rejection message followed by an interruption
marker. The original input, tool call, replacement result, and later new input
remained ordered in the next model request. Streaming assistant text retained
the observed three partial deltas. A pending `canUseTool` signal was aborted.
Ordinary shell/sleep children were gone at the post-result observation; a
grandchild ignoring SIGTERM survived and Kohaku explicitly cleaned up its PID.

These observations establish input/result ordering and retention under the
measured conditions, not semantic consistency with external side effects.
Interrupted tools may already have done work even though the replacement
rejection text describes a tool use that was rejected.

Claude's raw SDK also delivered a new message during tool execution without
killing the tool: normal input was folded into a `system-reminder` in the next
model request. With `priority: 'now'`, the tool finished, the current turn
returned success with an empty answer, and a new turn consumed the message.
Pre/PostToolUse `additionalContext` also appeared in subsequent model input.
Kaoiro's current `#waitForTurnBoundary` barrier prevents the SDK from receiving
that next message early; it preserves turn-token/result correlation. Removing
it without redesigning ownership, delivery acknowledgements, and settlement
would invalidate existing guarantees.

Antigravity findings here are source inspection and an explicitly identified
past measurement, not a new live probe. At the inspected versions it has no
supported in-band interrupt; the wrapper ends the process epoch and respawns
with the conversation ID while retaining queued turns. The existing
[print-mode measurement](antigravity/print-mode-background-tasks.md) observed
input recall after SIGINT and resume. It does not establish persistence under
the current SIGTERM/SIGKILL path. Engine-side partial text persistence and
conversation-store schema remain unverified. Runner session discovery/resume
validation for Antigravity is still a stub; wrapper-local respawn is distinct.

| Axis | Claude SDK 0.3.280 | Codex app-server 0.156.1 | Codex exec 0.156.1 | Antigravity |
|---|---|---|---|---|
| Interrupt mechanism | Control request in a live Query; tools may be terminated; SIGTERM-ignoring descendant survived | `turn/interrupt`; process remains; measured running command continued | Abort signal to spawned CLI; SDK child cleanup; measured running command stopped | Process-group SIGTERM, grace (default 60 s), possible SIGKILL, then respawn |
| Partial assistant text | Retained with abort metadata in measured case | Unfinished delta text absent in measured case | Unfinished delta text absent in measured case | Not emitted to kaoiro until DONE; engine persistence unverified |
| Tool interruption record | Replacement rejection text and user-interruption marker; does not describe already performed effects | `aborted by user`; additional notice explicitly warns processes may still run and tools may have partially executed | `aborted`; no explicit turn-aborted notice in measured requests | Engine record under current termination signals unverified |
| Mid-turn delivery | Measured fold, hooks, and tool-completion `priority: 'now'`; current host barrier blocks early input | Documented `turn/steer`, not measured here | No equivalent exposed by current wrapper/SDK path | No supported route established; additional stdin line queues next turn |

The old `Promise<void>` signature in `reference/engines/claude-events.md`
does not describe SDK 0.3.280's optional interrupt receipt. This is a separate
documentation issue candidate; the frozen design and unrelated docs were not
edited during this study.

## Source observations and architectural consequences

At the baseline, `wrapper/codex/src/host.ts:1380` selects exec by default.
`host.ts:1053` abandons the active scope and wakes permission waits, interrupts
the app-server if present, and aborts the SDK signal. `host.ts:1086` provides
an exact-turn-token interrupt route; its comment correctly distinguishes
cancellation request from terminal acknowledgement. `host.ts:2322` discards
queued image turns during operator interruption but retains plain text turns.
An IA policy should not blindly reuse broader operator cancellation semantics.

`app_server_transport.ts:196` sends `turn/interrupt` with thread and turn IDs,
after the start result establishes identity; `app_server_host_runtime.ts:214`
cancels pre-dispatch admission locally and refuses to abandon an already
observed terminal. The SDK `dist/index.js:262` passes the abort signal to Node's
child spawn and calls child.kill during cleanup. This is process cancellation,
not the same protocol as app-server's cooperative turn interruption.

`cli.ts:810` converts interrupted turn failures into per-conversation notices
and settles the exact coordinator batch before dispatching its successor.
`toolhost.ts:131` combines connection/turn cancellation signals and passes them
to handlers; arbitrary handlers can ignore cancellation and effects already
committed are not undone. Permission state tests are not a live experiment of
every broker, late permission reply, or external tool.

The official [app-server reference](https://learn.chatgpt.com/docs/app-server),
opened on 2026-09-26 via the redirect from
`https://developers.openai.com/codex/app-server`,
documents interruption as a request followed by an interrupted terminal, and
also documents `turn/steer`. Steering is a possible app-server-specific future
input path; it was not measured here and does not replace atomic send admission.

The protocol's nine IA kinds do not currently include `supersede` or `cancel`.
`owner` is a placeholder and does not authorize a director. A sender-priority
flag therefore needs an explicit authority policy, not a display-name check.
Server conversation admission already serializes counting and acceptance in
`ConversationStates`; comparing a reply basis there closes the server-arrival
race that any recipient-local interruption policy leaves open.

ADR-0036 F6 rejects automatic interruption **combined with reset**, because
tool-write interruption and context destruction compound the impact. The
operator's proposal preserves the session and is not that exact reset operation.
Nevertheless its tool-write concern applies. A new IA interruption decision
should document authority, cancellation effects, queue retention, and terminal
handling without weakening busy-reset rejection.

## Options (analysis, not performance measurements)

| Axis | A: explicit basis, strict compatibility | A': automatic delivered basis, negotiated protection | I: interrupt every arrival | I': selective interruption |
|---|---|---|---|---|
| Same-thread stale reply | Atomic server rejection against declared basis | Same if the input snapshot is trustworthy | No atomic server-arrival coverage | No atomic server-arrival coverage |
| Manual burden | Every existing-thread send supplies a number | Usually none; recovery needs careful ownership | No new basis argument, but interrupted work must be recovered | Sender signals urgency/authority |
| Running mutations | Does not stop them | Does not stop them | May continue or stop partially; no rollback | Same limitation for selected traffic |
| Arrival latency | New message normally waits for next SDK turn | Inline body recovery can avoid that wait | Requests cancellation immediately; waits for actual terminal | Shortens urgent-input delay only |
| Progress under ordinary ack/inform traffic | Preserved | Preserved | Repeated cancellations can prevent useful completion | Better only with deduplication and bounded/coalesced interruption |
| Old wrappers | Ordinary sends rejected; disruptive upgrade | Legacy traffic works without protection, explicitly reported | Old recipients do not interrupt | Old recipients do not honor selection semantics |
| Deployment | Server-first plus wrapper upgrade; no silent downgrade | Per-connection negotiated guarantee, mixed-version coverage measured | Capability required to claim coverage | Capability plus authority/selection contract required |
| Efficiency expectation | Local rejection/retry replaces some correction exchanges | Lower routine argument cost; inline recovery may save a turn | More abandoned generation and restart overhead | Lower waste than I if urgent traffic is sparse |

The arrival-latency row describes the current wrapper, not an inherent Claude
engine limitation. Claude fold provides another potential way to deliver the
body mid-turn, conditional on resolving the barrier/turn-ownership contract.

No numeric productivity gain is measured. Completed work and tokens are not
all lost on interruption, but unfinished generation can be discarded and
recovery incurs extra work. Repeated ordinary messages can keep resetting
progress. Interrupt-generated failure notices can themselves trigger another
interrupt unless synthetic/error traffic is excluded. These are architectural
risks, not a measured livelock rate.

## Six incident classes

Here “sender” means the agent attempting the stale response; “recipient” means
the agent that would act on it. A/A' protection applies only to a same-thread
basis older than peer history already accepted at the admission boundary.

| Incident | A / A': sender and recipient | I / I': sender and recipient | Remaining work |
|---|---|---|---|
| 1: decision crosses design post | Sender gets rejection; recipient receives no stale post | May stop drafting before send if arrival wins; otherwise stale post still reaches recipient | Semantic reconsideration cannot be proven by a number |
| 2: unseen grant | Sender's stale waiting report rejected; recipient spared corrective reply | May deliver grant sooner after cancellation; grant arriving after send cannot retract it | Scheduling and useful work are not guaranteed |
| 3: reply to old request with done | Reject before done accounting; recipient's newer request does not close on that stale basis | May interrupt before close; cannot undo an accepted close | Cross-thread routing remains outside reply binding |
| 4: verdict after evidence withdrawal | Sender's old-basis verdict blocked; recipient cannot act on that rejected verdict | Timing-dependent reduction; accepted verdict already actionable | Existing verdicts need explicit revocation semantics |
| 5: two crossed implementations | Only stale completion report is blocked; sender's edits still occur | Attempts to halt work; measured commands may continue and earlier effects remain | Workstream authority, mutation barriers, baseline reconciliation |
| 6: authority split across threads | Not addressed across threads; no sender or recipient guarantee | Arrival can interrupt any thread, but does not identify authoritative decisions | Stable workstream identity and explicit supersession |

A' deliberately leaves legacy senders unprotected. Recipient-side containment
does not imply the recipient is notified of a rejected attempt. That distinction
must remain explicit in issue acceptance and operational metrics.

## Joint recommendation and remaining decisions

Kogane and Kohaku agree on the recommendation below. There is no remaining
policy disagreement from this exchange. Agreement is on the direction of the
design, not authorization to implement or proof of the proposed guard.

Use A' as the foundation, keeping its guarantee narrow and visible. Record
input provenance at actual engine admission, not wrapper receipt or host queue
insertion; retain the atomic server compare. Do not claim a fully protected
deployment while legacy senders are admitted without binding.

Inline recovery (A'(a)) is useful, but returning pending bodies must transfer
exact message ownership out of the next-turn queue, resolve only those delivery
entries, and preserve size/count caps and overflow. A count-only advisory
(A'(b)) neither consumes messages nor authorizes a send and is not a guard.

A shared mutable “latest delivered” value has a subtle race: two tool calls
were generated against old input; the first returns new bodies and advances
the value before the second sends. The second then borrows a basis the model
had not seen when it authored that call. Serializing tools alone does not prove
a new model decision. Prefer immutable per-SDK-turn snapshots, with an explicit
basis override only for an intentional same-turn retry after reading recovery
input, until engine-level model-step provenance is available. A waiter result
has the same attribution problem and needs the same rule. Do not automatically
retry an unchanged body. This hybrid reduces routine burden without pretending
to observe cognition.

Do not adopt unconditional I. Consider I' later as an optional latency mechanism
alongside binding, never its replacement: authenticated urgency/ownership,
target workstream/revision and active turn token, deduplication, no synthetic
notice loop, preserved new input, confirmed terminal before successor admission,
and post-interrupt reconciliation. It cannot undo an accepted send or commit.

Kohaku additionally identifies Claude fold as a promising future boundary for
advancing the basis: the captured request proves delivery to the next model
step in the probe. Kogane agrees this merits consideration, with a limitation:
production must observe or establish that boundary and bind it to the exact
tool generation; yielding to an async input queue alone is not proof that the
next model request incorporated it. Its introduction remains a director decision.
Prefer tool-completion preemption over hard interruption for ordinary urgent
updates when an engine supports it. Even explicit hard cancellation needs
post-interrupt reconciliation, since it cannot guarantee tool rollback.

## Operational measurement proposal

Compare the director's last fully recorded pre-change design/review/implementation
assignment sessions with the next comparable post-deploy assignments. Record
the selected session IDs, time window, participant engines/versions, tasks, and
completion criteria **before** counting. Mark differences in task difficulty
and staffing rather than treating all conversations as comparable.

The unit is one completed assignment/workstream across all its conversation
IDs. Count accepted IA messages and request→response exchanges; separately count
crossing incidents, exchanges solely to restate/correct a crossed instruction,
stale-basis rejections, retries after rejection, interrupts, abandoned turns,
retracted verdicts/reimplementation, elapsed completion time, and reported token
usage when present. Exclude ordinary review findings and intentional scope
changes from crossing corrections. Report raw counts plus per-completed-task
and per-100-accepted-message rates. Group duplicate retries by conflict episode.

Use transcript envelopes (conversation/turn/sender/time), tool results or
structured rejection logs, lifecycle interruption/terminal records, and artifact
SHAs to reconstruct episodes. Transcripts alone omit rejected sends; missing
server/tool logs mean unknown, not zero. The current system does not yet offer
every proposed structured counter. Do not compare a post-change measured metric
against an unobservable pre-change one or infer a before/after improvement from
the loopback probe. The director owns actual post-landing measurement and issue
407 remains open for incidents 5–6 and unfulfilled acceptance criteria.
