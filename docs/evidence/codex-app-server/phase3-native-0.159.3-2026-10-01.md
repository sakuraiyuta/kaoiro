---
title: "ADR-0063 phase 3: native gates on Codex 0.159.3"
status: recorded
last_updated: 2026-10-01
---

# Phase 3 native gates on Codex 0.159.3

Tracking: [issue #346](https://github.com/sakuraiyuta/kaoiro/issues/346).
Design: [phase 3 delivery](../../plans/adr-0063-phase3-codex-early-delivery.md).
The [machine-readable record](phase3-native-0.159.3-2026-10-01.json) binds source,
built JavaScript, native binary, raw traces, logs, and native rollout hashes.

## Bound execution

Source: `d575184b04fa9dfebf3d227ef45aa8cc21e9f22e`, branch
`adr-0063-phase3-codex-impl-pin`. Native binary: **0.159.3**, SHA-256
`8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479`.
The probes used the built production `runCodexCli`, default Host, session,
transport, RPC, bridge, and ServerLink. Observation callbacks forwarded their
arguments and results. A localhost Phoenix fixture supplied the peer wire;
the real server ledger was checked separately with its unit suite.

Every native process used the authenticated scratch state home
`~/.local/share/kaoiro-scratch/codex-468-v1593` and a separate disposable `HOME`.
The production Codex home and production server were untouched. Test commands
used `env -u CODEX_HOME`; native probes explicitly supplied the scratch value.

## Results

| Gate                                                                 | Cases / turns | Exit code | Observation                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native local provider, held shell and resumed generation             | 2             | 0 each    | One active turn and one accepted steer; exact completed item ID/text; exact text in the next provider request; valid ticket reply; queued/submitted/included/settled; zero pending identities |
| Native local provider, watchdog fail-stop                            | 1             | 0         | Accepted, unobserved steer reports unknown; no false retirement; zero pending identities                                                                                                      |
| Native local provider, on-request/untrusted allow/deny               | 4             | 0 each    | IA does not resolve the pending selection; explicit operator decision controls the command; denied commands are declined                                                                      |
| Native controls: exec, normal-granted input, absent attribution echo | 3             | 0 each    | Zero steer requests; ordinary queued turns settle                                                                                                                                             |
| Native precondition rejection                                        | 1             | 0         | Deliberately wrong expected turn ID receives the real native rejection; regular receiver formatting runs in a second turn; no included claim; zero pending identities                         |
| Authenticated held shell and resumed generation                      | 2             | 0 each    | Same-turn completed item, reply ticket, terminal, and zero pending identities; same native thread resumes                                                                                     |
| Lifecycle, approval orders, coordinator integration                  | 41 passed     | 0         | Five test files; includes deterministic fallback and writing cases                                                                                                                            |
| Attribution and steer transport controls                             | 40 passed     | 0         | Two files; wrong client ID/text/turn and refusal classifications                                                                                                                              |
| Real server delivery ledger                                          | 38 passed     | 0         | Both retirement/generation-bind orders, old-generation rejection, and uncertainty semantics                                                                                                   |

The held command completed with exit code 0 and `FUJI_TOOL_DONE` after steer
admission in the local and authenticated runs. No `turn/interrupt` was sent.
On-request and untrusted allow cases also completed their held commands;
deny cases produced native `declined` items. Altering the successful command
to `interrupted` makes the continuity check fail.

The two authenticated turns used **gpt-6-luna / low**. Across both separately
built branches, exactly **5 live turns out of the approved maximum 7** were
attempted, with no retries: phase 3 used 2 and issue 464 used 3. The ledger
reserved and numbered each attempt before invocation, then recorded exit,
checker result, and actual native turn-start count.

## Negative controls and evidence limits

For positive local traces, removing the steer, changing the completed-item
client ID, removing downstream provider input, deleting the included stage,
or adding a frozen orphan each makes the checker fail. Live trace checks use
the same controls except provider-input removal: that input is not observable
on the authenticated provider. The native precondition checker rejects a
missing rejection and a nonzero placeholder count. Product matching guards
are also exercised by the attribution suite; trace mutation alone is not a
measurement of those guards.

Exact downstream model input is established by the native local provider.
Authenticated same-turn behavior is established by native completed items,
reply authorization, and completed terminals. The exceptional reordering,
reset, and stalled-writing schedules use deterministic production-code tests;
they are not all induced in a native process. The normal-granted control
checks effective routing; dashboard policy toggling is covered by issue 463.

The deliberate watchdog test emits a handled error terminal. Server unit logs
contain test authentication/cache warnings and expected simulated losses.
Positive native and live runs emitted no unhandled errors or warnings.

## Probe failures and retention

Earlier disposable-probe attempts failed before a usable gate because of a
Node shim under a disposable HOME, a repeated local-provider response write,
an instruction sent before Host construction, and an incorrectly enabled
approval-axis flag. Their complete logs remain bound in the JSON. They used
no authenticated model turns. Corrected current traces, rather than those
attempts, support the results above.

Raw artifacts remain at `tmp/reviews/issue-346/fuji-native-pin/` for review
(about 14 MiB at collection). Disposable local sockets and temporary process
homes were removed. The shared authenticated scratch home retains the native
rollouts; its temporary probe configuration, profiles, and canaries were
removed after measurement. Existing authentication was preserved. The native
measurement commits add evidence only; product sources remain at the bound
source commit.
