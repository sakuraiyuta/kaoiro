---
title: Issue 407 implementation candidate checks
description: Content-bound checks for the server, shared wrapper, Claude, and Codex candidate; Antigravity native gate remains open.
status: provisional
date: 2026-09-26
---

# Issue 407 implementation candidate checks

## Scope and binding

This is an implementation candidate, not a landing or full-engine protection
claim. Antigravity native measurement, any resulting origin guard/activation,
and independent implementation review remain outstanding. Issue #407 also stays
open for cases 5–6 and operational before/after measurement.

Branch: `issue-407-message-crossing`, based on
`ba696b503261db5c3af9f4806a5579b9f8f8d995`. The checked code/test commit is
`105fdd842c8048abd8ff04590938a75ee9137b6a`. The companion
[manifest](2026-09-26-issue-407-implementation.json) binds changed source/test
files, built runtime files, harnesses, result records, and logs by SHA-256.
Raw records live in `/tmp/kogane407-cross-turn.bUKHrA`, retained by Kogane for
implementation review. They are not committed transcripts. The prior research
records remain separate from these product checks.

| Layer | Commit |
| --- | --- |
| Approved plan and research | `54733a28849817dfc3d70af1c76857dd79c10258` |
| Server/protocol | `c8073555f2cde6c5c78bef1f1168149c8094c8d5` |
| Negotiated directory visibility | `a36bd815cb502ae8e7381329321ac698a4c6752e` |
| Shared wrapper and transport | `055453e3a195ec997da7897b1a1cc8f9bee484ff` |
| Engine adapters and integration checks | `8adea52de8e9d28fbb41f5e4b995d7fbac033296` |
| Claude test type correction | `105fdd842c8048abd8ff04590938a75ee9137b6a` |

The final commit accidentally lacks the required attribution trailer: a shell
newline separated the second `-m` from `git commit`. This was reported to the
director. History was not amended or reset; landing treatment remains with the
director. The preceding implementation commits have the required trailer.

## Full checks

All commands ran inside the isolated worktree. Exit codes are distinct from
pass counts. Final wrapper checks ran after restoration of the last mutation.

| Command | Exit | Observed result / log |
| --- | --- | --- |
| `pnpm --dir wrapper typecheck` | 0 | `wrapper-typecheck-final.log` |
| `pnpm --dir wrapper test` | 0 | `wrapper-full-final.log`: core 270, common 387, Claude 525, Codex 825, Antigravity 392 pass; 2 Antigravity skips |
| `pnpm --dir wrapper build` | 0 | `wrapper-build-final.log`; changed runtime modules were also rebuilt after native mutations |
| `scripts/mix-test.sh` (full server suite) | 0 | `server-full-candidate2.log`: 1626 passed |
| `cd server && mix format --check-formatted` | 0 | `server-format-final.log` |
| Native-record checker | 0 | `native-check-green.log`: 3 ticket backends, 8 origin scenarios, 2 handoff scenarios |

Wrapper total: **2399 pass, 2 skip**. Warnings are present in wrapper and server
logs. No Vitest `Unhandled Errors` block occurred. The successful server suite
contains three `[error]` log entries: corrupt DETS denial-list refusal, an
unusable persona-cache fixture retaining its manifest, and an intentionally
missing AgentActivity in the live-swap setup-exit fixture. Thus exit 0 does not
mean an error-free log. Loopback Codex also emits dummy-auth/catalog warnings.

During an earlier failing typecheck, the existing stderr diagnostic checker
failed with an out-of-memory error and, on another attempt, `RangeError`.
The new test typing errors were corrected; the final check passes. The diagnostic
checker was not changed. Its failure is an out-of-scope issue candidate, not an
independently established root cause.

## Actual engine checks

Claude Agent SDK/CLI and both Codex CLI backends ran against loopback model API
responses. No real Claude/Codex model API was used. They used actual AgentHost,
MCP routing, bridge/ToolHost, and InterAgentTool code. Recording acceptance sinks
and prescribed peer-input fixtures provide controlled server responses; full
server atomic admission is tested independently through Phoenix channel tests.
Full Codex CLI/coordinator/ServerLink integration also has committed loopback
channel tests. These are separate evidence surfaces, not a claim that the native
probe alone covered the entire production stack.

### Same-turn authorization

`ticket-claude.mjs` and `ticket-codex.mjs` produce `ticket-*/result.json`.
All three backends have the same observed sequence:

- B supplies predicted peer turn 3 without a ticket: local rejection, no sink send.
- A uses the fixed default and receives stale rejection plus recovery turn 3.
- C copies the returned ticket: accepted with `in_reply_to: 3`, then receives
  waiter turn 5.
- Wrong-CID and mistyped tickets fail locally; copying the valid ticket correctly
  succeeds and receives waiter turn 7.
- Advancing the injected ticket clock by 300001 ms rejects expired authorization;
  reusing C's spent ticket is also rejected.

Sink bodies are exactly `["A", "C", "corrected"]`; handed-off peer turns are
`[3, 5, 7]`. Expiry uses an injected clock, not a five-minute native wait. The
native model requests contain required/invalid/expired/spent-ticket errors.
A previously incomplete Claude result parser did not read line-separated JSON;
those early results are superseded. The final parser requires the returned
authorization and verifies C's wire basis is 3. Its mutation now produces B at
the sink and fails on all three backends.

### Cross-turn origin

| Backend | Normal release during T | Release after interrupt during actual T2 | Release after native MCP timeout during actual T2 |
| --- | --- | --- | --- |
| Codex exec | 1 send, origin T | 0 sends | 0 sends |
| Codex app-server | 1 send, origin T | 0 sends | 0 sends |
| Claude | 1 send, origin T | 0 sends | Not measured |

`guard-probe.mjs` holds the real Codex bridge request before ToolHost processing.
The timeout controls waited approximately 310 seconds. Exec's old endpoint is
closed by T2; app-server's socket remains live but the preserved native origin
is refused. This explains why endpoint lifetime alone suffices at exec ingress
but not at app-server ingress. Both still need the final pre-send origin check.
`guard-claude.mjs` uses a descriptor-level hold as controlled scaffolding before
the common handler and resolves the actual native tool-use ID through AgentHost.
The hold is not claimed to reproduce a particular production wait's frequency.

`handoff-claude.mjs` holds after recovery creation and before SDK callback return.
Normal release produces one commit and one ack. Interrupt followed by T2 before
release produces zero commits/acks, one rollback, and no recovered marker in the
actual model requests. The stale attempt already made before the hold remains
one sink call in both cases; rollback does not undo that attempted send.

Antigravity has common coordinator tests, but no native-engine origin evidence
in this candidate and no v1 activation. Hisui's delegated measurement is pending.
ToolHost-only research does not establish how the native engine completes,
cancels, or retains an old request.

## Mutation and negative controls

Each row removed the stated protection, observed a nonzero test/probe exit,
restored the original source, and observed exit 0. Raw red/green logs and mutation
script hashes are in the manifest. Restored source hashes bind the checks.

| Removed protection | Red → restored green | Observed red failure |
| --- | --- | --- |
| Server atomic basis comparison | 2 → 0 | Expected `stale_reply_basis`; got transport stale/accepted behavior; 2 focused failures, then 55 pass |
| Server canonical notice validation | 2 → 0 | Expected `invalid_internal_notice`, got `{:ok, :notice}` / accepted channel send |
| Legacy acceptance | 2 → 0 | Legacy channel compatibility expectation fails |
| Required ticket | 1 → 0 | Expected `reply_ticket_required`; got a send attempt |
| Ticket binding | 1 → 0 | Expected `invalid_reply_ticket`; got an attempt |
| One-use ticket | 1 → 0 | Expected `spent_reply_ticket`; got an attempt |
| Ticket expiry | 1 → 0 | Expected `expired_reply_ticket`; got an attempt |
| Fixed default snapshot | 1 → 0 | Captured default no longer matches basis 3 |
| Origin cancellation at shared send | 1 → 0 | Queued-call negative test times out instead of rejecting; this red alone does not prove an extra send |
| Shared handoff commit | 1 → 0 | Commit spy called 0 times; stale authorization retained |
| Shared handoff rollback | 1 → 0 | Rollback spy called 0 times |
| CLI snapshot publication | 1 → 0 | Real CLI legacy-error waiter/next-reply count is 0 instead of 1 |
| ToolHost socket handoff | 1 → 0 | Successful socket result commits 0 times |
| Exec endpoint retirement | 1 → 0 | Retired endpoint connection resolves instead of rejecting |
| Claude pre-permission origin gate | 1 → 0 | Permission decision entered before origin was observed |
| Each of three coordinator ownership removals | 1 → 0 each | Duplicate `recover` input and incorrect unread/claim state |
| Native required-ticket guard, all three backends | 1 → 0 each | Sink bodies become `["B", "A", "C", "corrected"]` |
| Native app-server turn-ID match | 1 → 0 | Old call reaches sink once with token T2; restored result is 0 |
| Native Claude MCP handoff commit | 1 → 0 | `missing native handoff ack`; restored normal probe has one ack |

The disposable final-record checker was also tested: a copied Claude result with
C's basis changed from 3 to 1 fails with `AssertionError: claude` (exit 1); original
records pass (exit 0). It checks observable records, not production enforcement.

Committed tests additionally cover definite transient rejection → new ticket →
intentional retry, unknown delivery without renewal, real socket disconnect and
serialization rollback, mixed legacy/v1 waiter envelopes, notice producers,
coalescing, and overlapping ownership claims restored in either order.

## Remaining gates

The director's before-change ledger is read-only to this workstream. Its supplied
SHA-256 was verified; capture started at `2026-09-26T07:27:06Z`. Operational
before/after results are not replaced by reproduction counts.

The candidate needs independent implementation review, Antigravity native
measurement/decision and applicable implementation/tests, then one integrated
landing. No claim is made about rollback of external side effects, model
comprehension, or exactly-once recovery across process crashes. The full approved
engine matrix is not complete while Antigravity remains unverified.
