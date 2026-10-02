---
title: Default-on in-flight delivery with a per-agent opt-out
description: Design for making in-flight delivery the default on every engine, with a revisioned per-agent opt-out stored on the server and switchable from the dashboard at launch and live.
status: proposed
last_updated: 2026-10-02
---

# Default-on in-flight delivery with a per-agent opt-out

Issue [#463](https://github.com/sakuraiyuta/kaoiro/issues/463); end state in
[ADR-0063](../adr/0063-layered-delivery-authority-and-continuations.md)
(Amendment 2026-10-01) and [ADR-0058](../adr/0058-codex-app-server-turn-steer.md)
("Default backend"). This document is the design only; implementation starts
after design review and the operator decisions in the last section.

"In-flight delivery" means: operator early input (Claude fold, Codex
`turn/steer`) and inter-agent early / yield delivery into a running turn.

## Current state (develop `0f1acf3a`, re-checked in code)

| Engine / backend | Operator early | Inter-agent early | Inter-agent yield | Control today |
|---|---|---|---|---|
| Claude Code | fold | fold | `tool_boundary` cut | `KAOIRO_CLAUDE_PHASE2_DELIVERY` / `_PERSONAS`, read once at wrapper start (`wrapper/claude-code/src/cli.ts:171-179`), default off |
| Codex app-server | `turn/steer` | `turn/steer` | none (yield downgraded to early) | operator: `KAOIRO_CODEX_OPERATOR_STEER` / `_PERSONAS`, default off (`wrapper/codex/src/cli.ts:180-185`); inter-agent: always on for app-server, no toggle (`cli.ts:699`, `:818`) |
| Codex exec | queue | queue | queue | no mid-turn seam |
| Antigravity | queue | queue | queue | no seam; join carries no delivery modes at all (`wrapper/antigravity/src/cli.ts:348-354`) |

Facts that shape the design:

- The Codex default backend in code is still exec:
  `dependencies.backend ?? config.codex_backend ?? "exec"`
  (`wrapper/codex/src/cli.ts:177`). The runner relays the host-wide
  `codex.backend` from `runner.config.json` (`runner/src/supervisor.ts:482,491`).
- Delivery capability is a join-time declaration. The server stores it in memory
  only (`server/lib/kaoiro_server/work_store.ex:142-194`) and nothing updates it
  after join. The wrapper adopts the echo once (`wrapper/core/src/transport.ts:1732`).
  There is no persisted per-agent delivery setting anywhere.
- The server decides the inter-agent grant (`prepare_delivery_intent`,
  `server/lib/kaoiro_server_web/channels/wrapper_channel.ex:3062-3173`): early or
  yield is downgraded to normal when the recipient advertises `none` or nothing.
- Every flag lives in the wrapper environment, inherited from `runner.env`.
  Changing it needs a runner restart and hits every agent on the host.
- The dashboard has no delivery UI. Precedent for a revisioned live control is
  `set_permission` (`agents_channel.ex:876-975`, persisted, acknowledged by the
  wrapper with a revision).
- Production (from the issue record, not re-measured here): the Claude canary
  runs phase 2 for persona `ao` only (issue #441, probes E1–E4 on 2026-09-29).
  Codex phase 3 is live for app-server peers since 2026-10-01 (issue #346).

Defects found while checking, to fix in stage 1:

1. `default_operator_intent` (`agents_channel.ex:1989-1994`) falls back to the
   inter-agent modes when the wrapper declared no operator modes. A Codex
   app-server agent with operator steer off therefore receives operator input
   stamped `early`. Its host queues it without the "queued for the next turn"
   system log (`wrapper/codex/src/host.ts:1076`). The fallback is right for
   Claude (operator fold rides the inter-agent modes) and wrong for Codex.
   Fix: Codex always declares `operator_input_modes`, with `early: "none"`
   when steer is off.
2. `docs/reference/inter-agent/delivery.md:296` says Antigravity advertises
   `early: "none", yield: "none"`; it advertises nothing, and the server
   reports `recipient_legacy`. Correct the doc.

## Design

### Two separate things: supported mechanism and effective policy

The phase 3 plan (`docs/plans/adr-0063-phase3-codex-early-delivery.md`,
"Dependency and end-state route") already concluded that the join-time echo
must stay frozen and that a live switch needs a separate revisioned policy.
This design adopts that route.

- **Supported mechanism** (per wrapper process, fixed for its lifetime): what
  the engine and backend can do. It is still declared at join, as today.
  The environment opt-ins stop gating it (stage 4).
- **Effective policy** (per agent, operator-owned, mutable): `on` or `off`.
  It is stored on the server, revisioned and acknowledged by the wrapper.

Effective in-flight delivery for an agent:
`mechanism != none` AND `host default allows` AND `agent policy == on`.

### Where the setting lives

| Layer | Holds | Changed by | Takes effect |
|---|---|---|---|
| Server store `DeliveryPolicies` (new DETS, one row per agent) | `{agent_id, policy, revision, applied_revision}` | dashboard (launch and live), server | live, after the wrapper's applied ack |
| `SpawnMessage` field `in_flight_delivery: "on" \| "off"` | launch value | LaunchDialog | seeds the row before the spawn broadcast |
| `runner.config.json` `in_flight_delivery.<engine>.default` (bool) | host default per engine; also the host kill switch | operator edits the file | next spawn after hot reload (issue #469 contract) |
| Environment variables | deprecated overrides during migration | `runner.env` | runner restart |

Persistence: the store joins `KaoiroServer.PersistencePaths.stores()` so it
reaches `mix kaoiro.env`, the cross-store tests and the deploy manifest
(issue #310). Rows survive server restart and are deleted with the agent.
Restore keeps the stored policy; a fresh spawn takes the launch value.

Agreement with issue #469: #469 moves host-wide behaviour settings into
`runner.config.json` and explicitly leaves the `_PERSONAS` lists to this
issue. This design puts only the host default per engine in
`runner.config.json`. The per-agent value lives on the server, because it must
change live and survive the wrapper. The `_PERSONAS` lists are retired, not
migrated (stage 5).

### Live switch protocol

Wire names below are proposals for review.

1. Dashboard → server `set_delivery_policy {agent_id, policy, expected_revision}`.
   Operator-only. The server compare-and-sets the revision, persists the row and
   replies `{revision, status: "pending"}`.
2. Server → wrapper `delivery_policy {revision, policy}`. It is also re-pushed
   after every join, like `permission_sync`.
3. Wrapper → server `delivery_policy_applied {revision}`. The server records
   `applied_revision` and broadcasts the confirmed state to the dashboard.

Ordering rules, taken from the phase 3 plan:

- **Opt-out:** the server stops granting early or yield to this recipient at
  step 1. Those requests are downgraded to normal with reason
  `recipient_policy_off`, and the operator default intent becomes `normal`.
  The wrapper installs a local no-new-fold/steer fence before it acks. An
  early item that was already granted and is still queued at the fence goes
  to the root queue, with reason `local_policy_disabled`. An item whose
  submission committed before the fence stays as it is.
- **Opt-in:** the server grants early again only after it has received
  `applied_revision >= revision`. The wrapper drops its fence only on a
  policy whose revision is not older than the newest it has seen.
- **Lost ack / rejoin:** the server re-pushes the latest revision after join.
  A stale revision never clears a newer opt-out.
- **Old wrapper** (no support for `delivery_policy`): the server marks live
  switching unavailable for that agent. The dashboard shows that and does not
  report the change as applied. The server-side downgrade at admission still
  applies to inter-agent input. Operator fold/steer on an old wrapper follows
  the server-stamped intent, so the opt-out still holds for operator input.

Because the server decides every grant, an opt-out works for new messages as
soon as the server accepts it. The wrapper fence covers only what was already
granted. This is the alternative to re-negotiating capabilities after join,
which the issue says may be needed: no rejoin and no change to the join echo.

### Per engine

- **Claude:** the policy check replaces the start-time `phase2Delivery` constant
  inside `earlyNegotiated` / `yieldNegotiated` and the operator fold branch
  (`cli.ts:178-179`, `:1014-1029`). Supported mechanism: fold and
  `tool_boundary`.
- **Codex app-server:** the policy check gates `trySteerInterAgent` and the
  operator steer path (`cli.ts:700-811`, `host.ts:1076`). Yield stays
  unsupported. A director's yield is downgraded to early (phase 3 plan,
  ADR-0063 D2/D9). The dashboard shows "early only".
- **Codex exec:** mechanism none. The toggle is shown as unavailable and the
  agent queues. Choosing exec is the backend opt-out. It is a launch or resume
  choice through `codex.backend`, not the live toggle.
- **Antigravity:** mechanism none until ADR-0063 phase 4 measures a
  `PreInvocation` path. Today only the first invocation has been measured
  (issue #412). The policy defaults to on and the toggle is stored, but the
  dashboard shows "not supported by this engine; messages queue". This is an
  honest queue fallback, not a narrowed scope: when phase 4 lands, the stored
  policy starts to apply with no new UI. Phase 4 has no issue yet; stage 0
  opens one.

### Dashboard

- LaunchDialog: an "in-flight delivery" checkbox. It defaults to the host
  default for the selected engine and is disabled when the engine or backend
  has no mechanism.
- AgentDetail: a toggle showing the effective state (`on`, `off`,
  `pending`, `unsupported`, `live switch unavailable`) and the mechanism
  (fold, steer, early only). It is confirmed only after the applied ack.
  Operator-only, with both the server gate and the client `isOperator` guard.

## Default-on criteria per engine

Each flip is its own commit, review and evidence record.

**Claude (flip `in_flight_delivery.claude-code.default` to true).** The canary
showed early fold at tool boundaries (E1–E4). It did not show the following,
which issue #441 lists as not yet exercised:

1. at least one production yield (`tool_boundary` cut) with its disposition
   recorded;
2. the per-turn fold and overtake limits reached once, natively or in
   production;
3. an oversized input taking the downgrade path;
4. the receipt-root timeout path.

In addition: the observation window shows `lost_count` 0 and no duplicated
replies for the canary agent, and the canary is widened to one `opus[1m]` peer
before the flip, because the only canary model so far is `sonnet`. Items 2 to
4 may be reported as "unmeasurable natively". That is a valid result if it is
stated (issue #434 acceptance).

**Codex operator steer (default on for app-server).** ADR-0058 requires that,
before rollout, both live steering probes (thinking and tool running), the
review/compact fallback, resume and interruption are exercised on the
production artifact. The 0.159.3 adoption evidence
(`docs/evidence/codex-app-server/pin-0.159.3-adoption-gates-2026-10-01.md`)
covers scheduling cases with steer enabled. This design has not audited it row
by row. Stage 0 produces that audit. Any missing row is measured on the
production pin before the flip.

**Codex backend (default exec → app-server).** ADR-0058 requires, before the
default adapter changes, measurements of configuration capture, account and
model defaults, hooks, credential refresh and compaction. Production already
runs app-server for its Codex peers, but that is observation and not a recorded
gate. Stage 0 maps each requirement to an evidence file or to a dated
production observation, and measures the rest. The flip lands immediately
before the stage 4 Codex flip (see the operator decisions).

**Antigravity:** no flip. The default policy is on, and the mechanism stays
none until phase 4.

## Stages and rollback

| Stage | Content | Behaviour change | Rollback |
|---|---|---|---|
| 0 | Gate audits (Claude criteria, Codex steer and backend); phase-4 issue; `delivery.md` drift fix | none | n/a |
| 1 | Server store, admission check, `set_delivery_policy` / `delivery_policy` / `delivery_policy_applied`; Claude and Codex wrapper support; Codex declares operator modes always (defect 1). Policy seeds from the current env result, so effective behaviour is unchanged | none intended | revert the deploy; an old server ignores the new DETS file |
| 2 | Dashboard launch checkbox and detail toggle | operator can opt agents in or out | hide the UI; stored rows keep their values |
| 3 | `runner.config.json` host default per engine; env flags become deprecated overrides (env wins, warns) | none while the defaults equal today's | remove the keys; the env path still works |
| 4a | Codex operator steer default on (app-server) | yes | per-agent off (live); host default false (next spawn); revert |
| 4b | Codex backend default app-server | yes | `codex.backend: "exec"` (next spawn); revert |
| 4c | Claude default on | yes | per-agent off (live); host default false (next spawn); revert |
| 5 | Remove the `_PERSONAS` variables after one released version with deprecation warnings | none | re-add the reader |

Stage 1 is behaviour-neutral by construction. Its default-composition contract
test injects nothing and asserts today's advertisement and grants.

## Verification plan

- Protocol and server: CAS on revision (stale `expected_revision` rejected);
  opt-out downgrades at admission before any ack; opt-in grants only after
  the applied ack; re-push after rejoin; a stale ack cannot clear a newer
  opt-out; an old wrapper is shown as live switch unavailable; deleting the
  agent removes the row.
- Persistence surface: the store is in `PersistencePaths.stores()` and has a
  deploy manifest entry; a close/reopen test; a mutation that drops it from the
  list makes the cross-store test fail.
- Wrapper: the fence before the opt-out ack (no fold or steer after the
  applied revision, natively once per engine); queued granted items downgrade
  with `local_policy_disabled`; opt-in only after the newer revision.
- Negative controls: policy off → zero folds or steers in a native run per
  engine; exec and Antigravity → zero in-turn submissions with the policy on.
- Mutations: the admission policy check, the wrapper fence, the revision
  comparison and the after-join re-push. Each must turn its own test red,
  run one at a time.
- Gates per touched layer: server `mix test` / `mix format`; wrapper, runner
  and dashboard typecheck/test/check.

Docs to update when the code lands: ADR-0063 phasing status, ADR-0058 Default
backend status, `docs/reference/configuration/{runner,wrapper}.md`,
`docs/reference/inter-agent/delivery.md`,
`docs/reference/protocol/channels.md`.

## Operator decisions (recommendations included)

1. **Claude flip criteria.** Recommended: the four unexercised items above,
   plus one `opus[1m]` canary peer and a `lost_count` 0 window. Alternative:
   flip on the E1–E4 evidence alone and treat the rest as production
   observation after the flip.
2. **Host kill switch.** Recommended: `runner.config.json`
   `in_flight_delivery.<engine>.default` doubles as the host-wide off switch
   (next spawn). Alternative: a server-wide switch that applies live. It needs
   a server config change and restart, or a new operator control.
3. **Granularity of the Codex backend opt-out.** Recommended: host-wide
   `codex.backend` only, as today. Alternative: a per-agent backend choice in
   LaunchDialog (new `SpawnMessage` field). Its interaction with resume needs
   its own review.
4. **"Just before this work merges into develop".** The work lands in stages.
   Recommended reading: the backend default flip (4b) lands immediately before
   the Claude default flip (4c), the last stage of the series. Alternative:
   before stage 1.
5. **Antigravity.** Recommended: accept the queue fallback with the toggle shown
   as unsupported, and open a phase-4 measurement issue. Alternative: hold the
   whole #463 merge until phase 4.
6. **Codex yield.** Recommended: accept the downgrade of yield to early, shown
   in the UI. Alternative: hold the Codex default until a native cut is measured
   and designed.
7. **Environment flag variables.** Recommended: the three flags without
   `_PERSONAS` are handled here (stage 3: deprecated overrides) because they
   are the same switch. This answers the open question in issue #469.
