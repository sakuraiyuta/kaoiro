---
title: "Codex app-server Stage 2 steer probes, 2026-09-30"
status: recorded
last_updated: 2026-09-30
---

# Codex app-server Stage 2 steer probes, 2026-09-30

Pre-implementation probes for [issue #366](https://github.com/sakuraiyuta/kaoiro/issues/366)
(ADR-0058 Stage 2). The full procedure, file hashes, checker and negative
controls, and the unmodified raw JSON-RPC lines are in the
[probe comment](https://github.com/sakuraiyuta/kaoiro/issues/366#issuecomment-5894716113);
this page keeps the observations the implementation relies on.

## Artifact

- Binary: the pinned `@openai/codex` 0.156.1 Linux x64 native executable,
  SHA-256 `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`,
  launched with the `AppServerRpc` arguments and `experimentalApi: false`.
- Isolated `CODEX_HOME` (auth file copied, then deleted), read-only sandbox,
  approval `never`, `gpt-6-luna` at low effort, four model turns.

## Observations

| Probe | Observed |
|---|---|
| L0: steer during a running command | A wrong `expectedTurnId` returns `-32600` "expected active turn id ... but found ..." with no `error.data`. The valid steer returns the same `turnId`; its `userMessage` item with the matching `clientId` starts only after the command completes; the final answer follows the steer. After `turn/completed`, a steer returns `-32600` "no active turn to steer", again without `data`. |
| L3: steer, then `turn/interrupt` before the command ends | The accepted input never appears as an item, is absent from `thread/read`, and no follow-up turn starts within 25 s (one trial). The command is not stopped: its `item/completed` arrives 16.9 s after the `interrupted` terminal, with the old turn ID. |
| L4: steer during a manual compact turn | `-32600` "cannot steer a compact turn" with `error.data.codexErrorInfo.activeTurnNotSteerable.turnKind: "compact"`. `turn/started` carries no turn kind. |
| L5: steer on a thread resumed in a new process | Behaves as L0; `clientId` survives in `thread/read` history across the process restart. |

## What rests on them

- Rejection classification reads `activeTurnNotSteerable` from `error.data`
  first and otherwise matches only the two measured messages; the tests use
  these captured shapes verbatim. `review` turns are schema-only.
- An accepted but unobserved steer is reported as `unknown` and never
  re-sent; L3 is an additional observation, not a proof that no follow-up
  turn can occur. The foreign-turn tripwire covers that case instead.
- Late items of an interrupted turn are expected after its terminal and are
  not treated as foreign.

## Post-implementation probes (L1, L2, L3b, L6), 2026-09-30

Run against the landed implementation, develop `98160432`, with the same
pinned binary (SHA-256 `0b2e9301…1f33f`), an isolated `CODEX_HOME` whose
copied auth file was byte-identical to the original afterwards and was then
deleted, `gpt-6-luna` at low effort, and five model turns. Procedure, file
hashes, the checker and its negative controls are in the
[post-implementation comment](https://github.com/sakuraiyuta/kaoiro/issues/366)
on the issue. L1 to L3b drove the built `CodexHost` directly with the
production session factory and a tap on the child's stdio; L6 ran a dev
server, the built wrapper CLI with `KAOIRO_CODEX_OPERATOR_STEER=1`, and an
operator client on the lobby channel. None of the probes resumed a thread, so
the later `excludeTurns` resume change (`c415c37e`) does not bear on them.

| Probe | Observed |
|---|---|
| L1: steer during a running command | One `turn/start`, one `turn/steer` with the started turn as `expectedTurnId`, accepted with the same `turnId`; the `kaoiro-steer:` input item started after the command completed; result `STEERED_L1_366`; system lines "accepted" then "included". |
| L2: steer at `turn/started` | `gpt-6-luna` at low effort emitted no `reasoning` item in a first attempt (one turn, no steer sent), so the steer was sent at `turn/started`. It was accepted; the turn produced `ORIGINAL_L2 333833500` as a first final answer, then the steered input item, then `STEERED_L2_366`. Both answers became assistant log rows in order and the single result carried the last. |
| L3b: steer during model output, then interrupt | The steer was accepted and `turn/interrupt` followed 50 ms later; `turn/completed` was `interrupted`. The steered input item never appeared, the outcome was `unknown (not_observed)` with no re-send, and during a 25 s wait there was no further `turn/started` and no `codex_foreign_turn` line. |
| L6: end to end through the server | A first instruction with explicit `delivery_intent: "normal"` started a turn; a second one without `delivery_intent` was defaulted to early by the server from `operator_input_modes`, steered into the running turn, and reached the operator's lobby as "accepted" and "included" system lines before a result containing `STEERED_L6_366`. |

L3b adds a second timing to L3; neither proves that a follow-up turn cannot
occur, which is why the foreign-turn tripwire remains the safeguard.
