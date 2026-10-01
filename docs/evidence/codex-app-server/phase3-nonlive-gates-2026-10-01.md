---
title: Codex inter-agent early delivery phase 3 non-live gates, 2026-10-01
status: recorded
last_updated: 2026-10-01
---

# Codex inter-agent early delivery: non-live gates

The source artifact is commit `3f8145c3b3e2e88df4cc14cd7d5bd84ff3df1b5e`
(tree `06f09cb09791360260ce704d87aa2dcb9fecd74a`), including server-first
commit `b0e64078`, its test follow-up `44837a58`, and shared-wrapper commit
`845992bb`. The pinned 0.156.1 Linux x64 native executable has SHA-256
`0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`.
Every test command below used `env -u CODEX_HOME`. No authenticated phase-3
native turn was run for this record.

## Gates

| Command and scope | Result | Warnings or unresolved errors |
| --- | --- | --- |
| `server/../scripts/mix-test.sh` | Exit 0; 1,771 passed, 1 excluded | Test fixtures emitted expected dev-auth, absent-version and delivery-loss warnings; no unhandled error. |
| `server/mix test test/kaoiro_server/delivery_states_test.exs` after the server mutation was restored | Exit 0; 37 passed | Expected fixture warnings; no unhandled error. |
| `pnpm -r run typecheck` | Exit 0; all seven workspace packages completed | None. |
| `pnpm -r run build` | Exit 0; all six build-bearing workspace packages completed | None. |
| `wrapper/core/pnpm test` | Exit 0; 306 passed | Expected legacy negotiation diagnostics; no unhandled error. |
| `wrapper/agent-common/pnpm test` | Exit 0; 505 passed | No unhandled error. |
| `wrapper/claude-code/pnpm test` | Exit 0; 761 passed | Expected SDK `canUseTool` shadow warning; no unhandled error. |
| `wrapper/antigravity/pnpm test` | Exit 0; 406 passed, 2 skipped | Expected fixture diagnostics; no unhandled error. |
| `wrapper/codex/pnpm test` | Exit 0; 1,211 passed | Fixture/model warnings and one `MaxListenersExceededWarning` from the test process; no unhandled error. |
| `runner/pnpm test` | Exit 0; 787 passed | Expected SQLite experimental and fixture warnings; no unhandled error. |
| `dashboard/pnpm check` | Exit 0; 0 errors, 0 warnings | None. |
| `dashboard/pnpm test` | Exit 0; 1,077 passed | No unhandled error. |
| `dashboard/pnpm build` | Exit 0 | Vite reported chunks above 500 kB. |
| `server/mix format --check-formatted` for the six changed server files | Exit 0 | None. |

An initial `pnpm -r run test` passed before the final test additions. Its next
run failed at `wrapper/core`: a Vitest worker exhausted its 4 GiB Node heap,
leaving 266/306 tests reported and one unhandled worker-exit error (exit 1).
The full output was retained at `/tmp/fuji346-workspace-final.log`; all packages
were then run separately at the source artifact above and passed as shown.
The repository-wide `mix format --check-formatted` exited 1 on the unchanged
`server/test/kaoiro_server/persona_assets_test.exs`; the scoped command above
passed for every server file in this change.

## Negative controls

Each mutation removed exactly the named guard or event wire, ran the covering
test, and was restored before the positive suite. These are failures of the
test invocation itself, not log-only observations.

| Mutation | Red result |
| --- | --- |
| Remove the Codex `unwritten` fallback guard | `cli_inter_agent_steer.test.ts`, unwritten case, exit 1: expected one root send, got zero. |
| Let an unrelated `clientId` select the active steer | `host_app_server_steer.test.ts`, exact-item case, exit 1: wrong-client item invoked `onItem`. |
| Remove `uncertainty == :resolve` from the server ledger resolution branch | `delivery_states_test.exs:1267`, exit 2: sequence 1 was absent from the resolved set. |
| Remove the receiver's `peer_turn_number` waiter match | `inter_agent.test.ts`, A-before-B case, exit 1: A consumed B's waiter. |
| Suppress the ticketed reply's per-sequence `replied` mark | `inter_agent.test.ts`, A-replied/B-uncertain case, exit 1: two notices instead of B's one. |
| Disconnect the post-terminal steer-response callback | `host_app_server_steer.test.ts`, late-response case, exit 1: no settlement after the response. |
| Disconnect `included` on accepted ticket use | `cli_inter_agent_steer.test.ts`, ticket-use case, exit 1: the included stage was absent. |

The Codex composition tests also cover exec, missing capability echo and
normal-intent queue controls, precondition and unwritten fallback, a failed
write without a qualifying unknown report, item-before-response, and an
accepted-but-unobserved steer. The server tests run the real notice validator
and persistence/expiry paths. The receiver tests exercise the model-facing
formatted notice as well as synchronous waiter matching.

## Remaining native gate

The phase-3 [design](../../plans/adr-0063-phase3-codex-early-delivery.md#verification-and-documentation-work-for-implementation)
requires a production `runCodexCli` trace through a local provider and peer
with authenticated scratch `CODEX_HOME`, including a held tool, a steered
input item, model continuation, reply ticket and terminal, plus negative
controls. That measurement needs the director's scratch-home arrangement and
was not authorized for this record. Existing app-server lifecycle tests use
the pinned executable and a local provider, but their peer input lacks the
new attribution echo and therefore verifies the queued compatibility path,
not phase-3 inclusion. A pin change or relevant code change invalidates the
native conclusion and requires a new trace.
