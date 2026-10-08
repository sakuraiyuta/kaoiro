---
title: Codex early corrections into the sender's running request
status: recorded
last_updated: 2026-10-09
---

# Early corrections into a running request

Tracking: [issue 548](https://github.com/sakuraiyuta/kaoiro/issues/548).
The authenticated Codex scenarios also cover the scheduling measurement in
[issue 517](https://github.com/sakuraiyuta/kaoiro/issues/517).
Design: [phase 3 delivery](../../plans/adr-0063-phase3-codex-early-delivery.md).

## Execution boundary

Product source and the positive non-live gates are bound to
`5cd38d7d81c539ec44408b3db96511843b7f94c6`, on
`issue-548-early-own-request`, based on `3c1dd786`.
The native probes use the built production `runCodexCli()` and
`runClaudeCli()` without dependency or factory injection: the default Host,
session, transport, RPC or SDK, MCP bridge and ServerLink. Observers forward their arguments and results. The localhost
Phoenix fixture scripts peers P and Q and accepts network replies; it is not
the real server's conversation ledger. The real `ConversationStates` and
`InterAgentReplyBasis.admission/2` are checked separately.

The native binary is Codex **0.161.0**, SHA-256
`9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c`.
Each run has its own authenticated scratch state and disposable shell HOME.
Credential copies remain in mode-600 files and are removed after the owned
native children close. The production state home, runner, Docker and production
deploy were not operated. Full suites and native runs use `setsid` and
a PID namespace mapping the current non-root UID to itself.

## Scheduling and reply basis

The production CLI/Host regression sends running P/X turn 4 (seq 60), queued
ordinary P/X turn 5 (seq 63), and early P/X turn 6 (seq 64). Only turn 6 goes
into the active turn; the ordinary body remains for the next root. The
completed native `userMessage` must have the exact client ID, text and turn ID
of the corresponding `turn/steer`, alongside an accepted submission stage.

Spending turn 6's ticket credits its basis for a later default reply. Without
spending it, the ordinary root's local default remains 5, while the real
server already expects peer turn 6 and rejects basis 5 as `stale_reply_basis`.
The server regression pins both that rejection, without state mutation, and
acceptance of basis 6. The accepted design addendum corrects the earlier
fake-network assumption that an unspent ticket's plain reply would be accepted.
No server admission rule or ReplyBasis contract was relaxed.

For a corroborated steer, stale-basis recovery can return the retained body
and a fresh authorization inline; only an empty recovery requires waiting
for confirmed input. Recovery fits the entire JSON tool result into 16,384
bytes, whereas steer admission measures formatted text. The margin for
bodies in the 10 KiB range is **unmeasured**; these gates establish no
size threshold for successful retained-body recovery.

The host queue's FIFO order and per-token caps protect root progress. The
two-write cap counts only waiting host-queue peer roots, is a tuning value,
and bounds steer count rather than turn duration.

A root waits until every steer's result is reconciled, including responses
arriving after the terminal. A different peer's late steer must also release
the original root peer; releasing only the steer peer strands its successor.
Five production CLI/Host cases pin the queued body, spent/unspent ticket and
late-response paths. An abandoned final attempt also reconciles held roots.

## Positive non-live gates

All commands are from the worktree; test commands unset inherited CODEX_HOME.
Exit codes and counts below are copied from the final command outputs.

| Gate | Result | Exit |
| --- | --- | --- |
| Wrapper typecheck | All five packages completed | 0 |
| Wrapper build | All five packages completed | 0 |
| Core full suite | 485 passed | 0 |
| Agent-common full suite | 564 passed | 0 |
| Claude Code full suite | 807 passed, 4 skipped | 0 |
| Codex full suite | 1,384 passed | 0 |
| Antigravity full suite | 493 passed, 3 skipped | 0 |
| Server conversation, admission and footer suites | 79 passed | 0 |
| Actual reducer output through real server admission | 7 cases, 14 notices | 0 |

Typecheck and build emit no warnings or unhandled errors. The full wrapper
suite emits two `MaxListenersExceededWarning` messages and expected fault-path
logs; it reports no Vitest unhandled-error section. The server gate emits the
test environment's unset-auth and cache-mode warnings and the callback-failure
logs exercised by its tests. The real-admission wire gate emits no warnings.
All of these commands still exit 0; logs are bound in the evidence index.

The shared-adapter checks include the unchanged Claude two-argument
`prepareFoldInput` caller and Antigravity CLI notice/reply behavior. Root-only
output remains equal to `resolveTurnEnd`, including legacy unscoped notices.
The built-in footer states same-conversation overtaking, the waiting-root cap
of two within three IA writes, later ordinary delivery and stale-basis recovery.
Its replaced paragraph shrank from 535 to 522 UTF-8 bytes.

## Negative controls

Each product mutation started after the fix was committed and was restored
before the next mutation. All 24 TypeScript mutations independently failed
their covering tests with exit 1. They cover the arrival and commit blanket
root guards separately; ticket credit; held-root dispatch and release; other
owners and legacy roots; earlier early fallback; root/steer reconciliation;
identity-scoped records and preparation-time capture; record loss; 16-entry
chunks and defensive duplicate splitting; exact ticket discharge; unknown
reply discharge; root-only compatibility; canonical timeout text; queue and
operator admission; the two-write budget; charging once per write and only
while roots wait; and token-local counters.

The server stale-basis guard mutation fails two tests (52/54 passed, exit 2).
Changing the built-in footer's running-request clause fails its production
asset test (14/15 passed, exit 2). The final restored server gate passes 79.

For wire output, deliberately merging delivery identities into one notice
produces duplicate seq values. Real admission rejects the output (exit 1).
Relaxing its `seq > previous` guard to `seq > 0` accepts that same payload
(exit 0); restoring the guard rejects it again. Restored production output
passes all seven cases, including uncertain generation duplicates, root/steer
identity changes, 17 entries, defensive duplicates and a separate legacy CID.
The timeout text uses the server's canonical message; the previous custom
uncertainty message was rejected as `invalid_internal_notice`.

Deleting the matching completed native item from a copied authenticated trace
makes the independent trace checker fail with exit 1. Its positive checks
also require normal command completion, all completed terminals, exact native
turn counts and accepted submission, plus S4's actual ticket reply. The
negative copy was removed. Authenticated provider input is not directly
observable, so native item receipt and the tool reply support the live claim;
they do not expose the provider's full downstream request.

## Native scenarios

P and Q are scripted senders and never reply. The held shell runs about
30 seconds; successor roots ask for plain text only. Baseline S1 costs one
native turn, and baseline S2 declines the own-sender early input and then
delivers it as an ordinary root, costing two. Post-change S1–S6 run twice,
costing 2 × (1 + 1 + 2 + 1 + 2 + 3) = 20 native turns.

| Scenario | Post-change result | Codex turns per run | Runs | Exit |
| --- | --- | --- | --- | --- |
| S1: Q running, P early | P is steered into Q's turn | 1 | 2 | 0 |
| S2: P running, P early in another CID | Early is steered | 1 | 2 | 0 |
| S3: P/k running, P/k+1 queued, P/k+2 early | Early is steered; ordinary body runs next | 2 | 2 | 0 |
| S4: P running, P early in the same CID | Early is steered; ticket reply observed | 1 | 2 | 0 |
| S5: P running, Q root waiting, P early | Early is steered; Q's root runs next | 2 | 2 | 0 |
| S6: Q running, P root waiting, P early | Early is declined; P's root then early run | 3 | 2 | 0 |

All 14 authenticated Codex traces, including the two baseline controls, pass
the independent checker. Native turns total **23**. The native account's
seven-day readings range from 35% to 36%; the five-hour window is absent and
remains unknown. Each scenario reads the kaoiro snapshot and then the native
account before its first `turn/start`, stopping at 48% against a 50% cap.
The initial baseline auth-path preflight used zero native turns and is recorded
as a failure. Baseline S1 initially omitted the scripted peers from its directory;
it proves intake and command completion, without a ticket-reply claim.

Claude parity uses the installed **0.3.293** Agent SDK and the default wrapper
constructor. The final S3, S4 and S2 runs pass with respectively **2, 1 and 1**
native turns, all exit 0. The independent checker verifies completed SDK roots,
the actual successful foreground tool result, folded input, exact ticket and
basis in the native `send_to_agent` tool arguments, and the emitted reply's
basis and CID. The wrapper consumes the ticket locally; it is not a wire field.
Changing only that tool argument in a copied trace makes the checker fail
with exit 1. All three original traces pass; the negative copy was removed.

Earlier Claude attempts cost four turns and fail their gates: S2's `sleep`
command was moved to the background before completing (one turn), and S3's
relative `python3` command exited 126 before the held work (three root inputs,
counted conservatively). These are not positive parity evidence. The director
approved four additional turns after a model-free installed-SDK probe verified
`/usr/bin/python3` with normal foreground completion. Total consumption is
**8 Claude turns**, including those four failures. Before every live turn the
seven-day snapshot is 88%; final native SDK readings remain 88%, below the
91% stop threshold. Readings are shared-account snapshots, not a cost bound.

Before the retries, the native-input guard is measured without a live model:
ordinary and early writes require the root to still have zero terminal results
and the Host to be `tool_running`. The installed SDK runs the real foreground
command against a local synthetic provider. The positive guard probe exits 0;
a provider that ends the root before the ordinary input is rejected by that
specific guard (child exit 1). No live model turns are consumed by these probes.
The earlier synthetic fixture failed to distinguish a tool-less auxiliary SDK
request from the tool-enabled request; those failed attempts are superseded
and are not treated as parity evidence.

The Claude SDK ignores the probe's attempted config cwd override, so the real
SDK cwd is this feature worktree. The prompts permit only the held command and
reply tool; no model file edits are requested or observed. The known SDK
`canUseTool`/bypass warning remains. Provider downstream requests and timing
outside these observed SDK/native items are not measured.

## Release boundary and retained evidence

This is a TL high-risk change under
[High-risk change release](../../operations/high-risk-change-release.md).
The shared adapter affects all engines. Production canaries are `ao`, `momo`
and `hiiro`, each engine in turn. The director runs that release procedure
when deploying; it was not executed by this implementation task.

The [machine-readable evidence index](issue-548-early-own-request-2026-10-09.json)
binds the source, compiled modules, probes, trace files, gate outputs and ledger
by SHA-256. It contains no credentials or reply capabilities.

Raw traces, the native ledger, probe/checker scripts and gate logs remain under
`tmp/reviews/issue-548/` for implementation review. The detached baseline
worktree and disposable state homes are removed once their records are bound.
The feature worktree remains for review and landing. Attribution for the test
changes in `5cd38d7d` is Fuji / gpt-6.1-sol via kaoiro; its omitted trailer is
recorded in the subsequent evidence commit without rewriting that commit.
