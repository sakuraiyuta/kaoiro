---
title: Default-on in-flight delivery with a per-agent opt-out
description: Design for making in-flight delivery the default on every engine, with a revisioned per-agent opt-out stored on the server and switchable from the dashboard at launch and live.
status: approved
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
- Operator input keeps an explicit `delivery_intent` from the client and fills
  in a default only when it is absent
  (`server/lib/kaoiro_server_web/channels/agents_channel.ex:597-604`).
- Every flag lives in the wrapper environment, inherited from `runner.env`.
  Changing it needs a runner restart and hits every agent on the host.
- The runner re-sends its register on every accepted `runner.config.json`
  hot reload (`runner/src/runner-cli.ts:407`, `updateRegister`).
- The dashboard has no delivery UI. Precedent for a revisioned live control is
  `set_permission` (`agents_channel.ex:876-975`, persisted, acknowledged by the
  wrapper with a revision).
- Production (from the issue record, not re-measured here): the Claude canary
  runs phase 2 for persona `ao` only (issue #441, probes E1–E4 on 2026-09-29).
  Codex phase 3 is live for app-server peers since 2026-10-01 (issue #346).

Prerequisites found while checking:

1. [Issue #489](https://github.com/sakuraiyuta/kaoiro/issues/489): a Codex
   app-server agent with operator steer off receives operator input stamped
   `early`, because `default_operator_intent` falls back to the inter-agent
   modes. It must be fixed before stage 1, because this design uses the
   server-stamped intent to enforce the opt-out.
2. `docs/reference/inter-agent/delivery.md:296` says Antigravity advertises
   `early: "none", yield: "none"`; it advertises nothing, and the server
   reports `recipient_legacy`. Stage 0 corrects the doc.

## Design

### Two separate things: supported mechanism and effective policy

The phase 3 plan (`docs/plans/adr-0063-phase3-codex-early-delivery.md`,
"Dependency and end-state route") already concluded that the join-time echo
must stay frozen and that a live switch needs a separate revisioned policy.
This design adopts that route.

- **Supported mechanism** (per wrapper process, fixed for its lifetime): what
  the engine and backend can do, limited by the host ceiling (below) and,
  until stage 4, by the global opt-ins (the variables today, issue #469's
  config keys once it lands) and the `_PERSONAS` lists. It is declared at
  join as today.
- **Effective policy** (per agent, operator-owned, mutable): `on` or `off`.
  It is stored on the server, revisioned, and confirmed by the current wrapper
  process.

In-flight delivery happens for an agent only when both hold:

1. the wrapper declared a mechanism other than `none`, and
2. the agent's stored policy is `on`, and, when the current wrapper
   incarnation declared `delivery_policy: "v1"` at join, that incarnation has
   acknowledged the stored revision. A wrapper that did not declare it is
   not asked for an acknowledgement (see "Old and new combinations").

### Host settings: a ceiling and a default, as two keys

`runner.config.json` gets two keys per engine, with different meanings:

| Key | Meaning | Path | Takes effect |
|---|---|---|---|
| `in_flight_delivery.<engine>.enabled` (bool, default `true`) | **Ceiling** and host kill switch. When `false`, nobody on this host gets in-flight delivery for this engine | runner relays it in the per-agent wrapper config at spawn (the path `codex_backend` already uses, `supervisor.ts:447-519`); the wrapper then declares mechanism `none` (per engine below), and the server downgrades as for any `none` recipient. It does not depend on the server version | next spawn after hot reload (issue #469 contract) |
| `in_flight_delivery.<engine>.default` (bool) | **Default** policy. It seeds a new agent's policy when the launch request has no explicit value, and it is the LaunchDialog's initial checkbox value | runner adds `in_flight_defaults` to its register; `updateRegister` re-sends it on hot reload; the server keeps it with the host record and serves it to the dashboard | new spawns after the re-register; never rewrites stored rows |

So per-agent `on` works on a host whose default is `off` (the canary use that
the `_PERSONAS` lists serve today) while the ceiling is `true`. The kill
switch stops every agent of that engine at its next spawn; to stop running
agents at once, the operator turns them off individually (live).

What "mechanism `none`" means on the wire when `enabled` is `false`:

- Codex: inter-agent modes `early: "none"`, and `operator_input_modes` also
  declared with `early: "none"`. This builds on the issue #489 fix (always
  declare operator modes); it never goes back to omitting the declaration.
- Claude: inter-agent modes `early: "none"`, `yield: "none"`. Claude declares
  no operator modes, so the server's fallback reads the inter-agent `none`
  and stamps operator input `normal`.
- Antigravity: no declaration, as today.

### Per-agent policy store

Wire names and store names below are proposals for review.

- New DETS store `delivery_policies` (`KAOIRO_DELIVERY_POLICIES_PATH`), one row
  per agent: `{agent_id, policy, revision}`, plus a never-deleted revision
  counter namespace, the same layout as `PermissionSettings`
  (`{:settings, id}` / `{:counter, id}`). Writes are synchronous, like
  `PermissionSettings.submit_request/5`.
- It is registered in `KaoiroServer.PersistencePaths.stores()`, so it reaches
  `mix kaoiro.env`, the cross-store tests and the deploy manifest
  (issue #310).
- **Deploy (issue #339).** Issue #339 is still open, but the deploy CLI now
  has a `never_existed` outcome for a store that is new in the target image
  (`docs/operations/server-update-and-rollback.md`, "A newly added store").
  The outcome requires three things: the old image answers its manifest
  probe, the old effective path is absent, and compose puts the new path
  under `/var/lib/kaoiro`. The production image is post-#310 (the manifest
  landed in `ce0ef832`, 2026-09-07). `work_store` was added on 2026-09-28, and
  production has since been updated to `83208b27`, which includes it
  (issue #346). This design did not read that update's transaction record.
  Stage 1 adds the compose entry. Before the stop window it
  requires a dry run whose `env_consistency` entry for this store reads
  `first_application: "never_existed"`. If the entry reads anything else, the
  update stops there and the operator decides. Rollback: the old image ignores
  the file.
- Reusing `permission_settings.dets` was considered and rejected. One DETS
  file has one owning process, so the policy would have to live inside
  `PermissionSettings`, whose pure `State` module encodes Codex permission
  transitions. Coupling a delivery control to it saves one store entry but
  makes both harder to change.
- **Unavailable or unreadable.** If the store cannot be opened or a row
  cannot be decoded, the agent's policy is `unknown`. `unknown` grants no
  early or yield and clamps operator intent to `normal` (fail closed), and
  the dashboard shows it. An **absent** row is not an error, and it is not
  left absent. A spawn writes the row before its broadcast (launch value or
  host default). Any agent that joins without a row gets one written at that
  join. Until stage 4 the written value is `on`, which keeps today's
  behaviour. From stage 4 it is the host default if the host has registered
  one, and `on` otherwise. Absence therefore lasts only from the stage 1
  deploy to each existing agent's first join, and "absent means on" is not a
  standing rule.
- Rows survive server restart and are deleted with the agent. Restore keeps
  the stored policy; a fresh spawn takes the launch value or the host default.

Agreement with issue #469: #469 moves host-wide behaviour settings into
`runner.config.json` and explicitly leaves the `_PERSONAS` lists to this
issue. The two host keys above follow #469's contract. The per-agent value
lives on the server, because it must change live and survive the wrapper.
The two in-flight `_PERSONAS` lists are retired, not migrated (stage 5). The
global flags become #469's config keys; see "Dependency on issue #469".

### Live switch protocol

1. Dashboard → server `set_delivery_policy {agent_id, policy, expected_revision}`.
   Operator-only. The server compare-and-sets the revision, persists the row
   synchronously and replies `{revision, status: "pending"}`.
2. Server → wrapper `delivery_policy {revision, policy}`. The server sends it
   after every join and after every accepted change.
3. Wrapper → server `delivery_policy_applied {revision}`.

**Support is declared at join.** A wrapper that implements this protocol
adds `delivery_policy: "v1"` to its join parameters, and a server that
implements it echoes the same. Neither side sends policy messages to a peer
that did not declare support.

**Confirmation is bound to the wrapper incarnation.** The server keeps the
applied revision in memory, keyed by the channel owner (the pid that
`WorkStore.register_modes` already records). It is never persisted. Every join
of a supporting wrapper starts unconfirmed, and the server sends the current
revision. The server grants early or yield to it only while the stored policy
is `on` and the current owner has acknowledged that same revision. Opt-out
needs no acknowledgement: the server stops granting as soon as the row says
`off`. A wrapper that did not declare support is never asked for an
acknowledgement: `on` grants, `off` refuses.

**Wrapper start state.** A new supporting wrapper process starts fenced: no
fold, steer or cut until it applies a `delivery_policy` whose policy is
`on`.

**Old server under a new wrapper.** This happens after a server rollback, or
when a wrapper rejoins a server that was rolled back. If the join echo lacks
`delivery_policy: "v1"`, the wrapper decides from its own history:

- it has never received a policy, or the last one it received was `on`:
  launch-time behaviour (the mechanism it declared, no fence);
- it has received `off` at least once and no later `on`: it keeps the fence.

A wrapper that has seen an opt-out therefore never lifts it because the
server lost the protocol.

**Server restart.** The wrapper process survives and rejoins. The rejoin is
a new incarnation for the server (unconfirmed again). The wrapper keeps its
local fence state across the rejoin, and changes it only on a revision at
least as new as the newest it has seen. Until the new acknowledgement, the
server grants nothing early. That costs only the short window between the
rejoin and the acknowledgement.

**Old and new combinations.**

| Server | Wrapper | Policy `on` | Policy `off` |
|---|---|---|---|
| new | new | granted after the incarnation's ack | server refuses; wrapper fence |
| new | old | granted (no ack asked) | server refuses; only items granted before the change can still arrive early |
| old | new | launch-time behaviour, unless this process has received `off` (then fenced) | not enforced by the server; a wrapper that received `off` keeps its fence; a wrapper spawned under the old server knows no policy |
| old | old | today's behaviour | not available |

The last two rows mean that a **server rollback after stage 2 loses the
opt-out** for agents spawned under the old server. The stop that does not
depend on the server is the host ceiling `enabled: false` (next spawn).

**Operator intent (explicit or default).** The `instruction` handler clamps
the intent to `normal` whenever early delivery is not allowed. Early delivery
is not allowed when the policy is `off` or `unknown`, or when it is `on` but
not yet confirmed by a wrapper that declared support. The clamp also applies when the client sent an explicit
`early` or `yield`. The reply then carries
`{delivery_intent: "normal", downgrade_reason: "recipient_policy_off" | "policy_unconfirmed" | "policy_unknown"}`,
so an API client learns of the downgrade. The bundled dashboard sends no
intent today, so the dashboard behaviour does not change.

**Inter-agent grants.** `prepare_delivery_intent` applies the same condition.
A refused early or yield is downgraded to normal with the same reasons,
recorded in the existing stage records.

**Opt-out fence in the wrapper.** On a `delivery_policy` with `off`, the
wrapper installs a local fence before it acknowledges. Each queued item is
decided exactly once, at a single commit point per engine:

- Claude: the commit point is the input scheduler's submit (issue #434: the
  single serialization point for folds and cuts). An item classified as early
  checks the fence again at submit. If the fence is up, the item goes to the
  root queue with `local_policy_disabled`. A yield whose claim succeeded but
  whose cut is not yet pushed is not cut; the item takes the existing
  failed-claim path, which the fence then sends to the root queue. The policy
  revision is read at the commit point, never earlier. A change in the middle
  of a turn therefore cannot split one item.
- Codex app-server: the commit point is the synchronous start of
  `turn/steer`. A steer whose RPC was already started before the fence keeps
  its outcome from the RPC result. If it is accepted, the item counts as
  steered. If it is rejected, the item goes to the root queue. It never
  becomes both. No new steer starts after the fence.
- The sender learns of a downgrade through the existing stage report
  (`local_policy_disabled`).

**Old wrapper** (did not declare `delivery_policy: "v1"`): the server marks
the live switch unavailable for that agent, and the dashboard says so. It
asks for no acknowledgement (combinations table). The server-side clamp and
downgrade still apply to `off`. Opt-out therefore holds for new input, and
only items granted before the change can still be delivered early.

This is the alternative to re-negotiating capabilities after join that the
issue anticipates: there is no rejoin and no change to the join echo.

### Per engine

- **Claude:** the policy replaces the start-time `phase2Delivery` constant as
  the gate. It is read only at the commit points above (`cli.ts:178-179`,
  `:745-955`, `:1014-1029`). Supported mechanism: fold and `tool_boundary`.
- **Codex app-server:** the policy gates `trySteerInterAgent` and the
  operator steer path (`cli.ts:700-811`, `host.ts:1076`) at the steer commit
  point. Yield stays unsupported. A director's yield is downgraded to early
  (phase 3 plan, ADR-0063 D2/D9). The dashboard shows "early only".
- **Codex exec:** mechanism none. The toggle is shown as unavailable and the
  agent queues. Choosing exec is the backend opt-out. It is a launch or resume
  choice through `codex.backend`, not the live toggle.
- **Antigravity:** mechanism none until ADR-0063 phase 4 measures a
  `PreInvocation` path. Today only the first invocation has been measured
  (issue #412). Its host ceiling `in_flight_delivery.antigravity.enabled`
  ships as `false`, and the toggle is shown as "not supported by this
  engine; messages queue". When phase 4 lands, nothing starts by itself:
  the mechanism appears only when the operator sets the ceiling to `true`,
  as its own default flip (stage 4d) with evidence and review. Stored
  per-agent policies for Antigravity agents apply from that point. Phase 4
  has no issue yet; stage 0 opens one.

### Dashboard

- LaunchDialog: an "in-flight delivery" checkbox. Its initial value is the
  host default for the selected engine (from the register). It is disabled
  when the ceiling is `false` or when the engine or backend has no mechanism.
- AgentDetail: a toggle that shows the effective state (`on`, `off`,
  `pending`, `unknown`, `unsupported`, `live switch unavailable`) and the
  mechanism (fold, steer, early only). It shows `on` only after the applied
  ack. It is operator-only, guarded by both the server gate and the client
  `isOperator` check.

## Default-on criteria per engine

Each flip is its own commit, review and evidence record.

**Claude (stage 4c: the global opt-in and persona list stop gating the mechanism, and
`in_flight_delivery.claude-code.default` becomes true).** The canary showed
early fold at tool boundaries (E1–E4). It did not show the following, which
issue #441 lists as not yet exercised:

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

**Codex operator steer (stage 4a: default on for app-server).** ADR-0058
requires that, before rollout, both live steering probes (thinking and tool
running), the review/compact fallback, resume and interruption are exercised
on the production artifact. The 0.159.3 adoption evidence
(`docs/evidence/codex-app-server/pin-0.159.3-adoption-gates-2026-10-01.md`)
covers scheduling cases with steer enabled. This design has not audited it row
by row. Stage 0 produces that audit. Any missing row is measured on the
production pin before the flip.

**Codex backend (stage 4b: default exec → app-server).** ADR-0058 requires,
before the default adapter changes, measurements of configuration capture,
account and model defaults, hooks, credential refresh and compaction.
Production already runs app-server for its Codex peers, but that is
observation and not a recorded gate. Stage 0 maps each requirement to an
evidence file or to a dated production observation, and measures the rest.

**Antigravity (stage 4d):** only after phase 4 lands with its own evidence;
the flip is setting the ceiling to `true` and choosing its default.

## Stages and rollback

| Stage | Content | Behaviour change | Rollback |
|---|---|---|---|
| 0 | Gate audits (Claude criteria, Codex steer and backend); phase-4 issue; `delivery.md` drift fix; issue #489 fixed | none | n/a |
| 1 | Server store, clamp and admission check, `set_delivery_policy` / `delivery_policy` / `delivery_policy_applied`; Claude and Codex wrapper support | one: for a new wrapper, nothing is delivered early (operator input included, stamped `normal` with `policy_unconfirmed`) between join and its first ack. Otherwise none (see below) | revert the deploy; the old image ignores the new DETS file |
| 2 | Dashboard launch checkbox and detail toggle | the operator can turn agents off; turning on works only where a mechanism is declared | hide the UI; stored rows keep their values. A **server** rollback from here on loses the opt-out for agents spawned under the old server; stop with `enabled: false` (next spawn) |
| 3 | `runner.config.json` `enabled` / `default` per engine, relayed through issue #469's registry and registered (requires #469's flag keys to have landed) | none while `enabled` is `true` and the global opt-ins still gate | remove the two keys |
| 4a | Codex operator steer: mechanism declared without `codex.operator_steer` or its persona list; default on | yes | per-agent off (live); `enabled: false` (next spawn); revert |
| 4b | Codex backend default app-server | yes | `codex.backend: "exec"` (next spawn); revert |
| 4c | Claude: mechanism declared without `claude_code.phase2_delivery` or its persona list; default on | yes | per-agent off (live); `enabled: false` (next spawn); revert |
| 4d | Antigravity, after phase 4: ceiling true | yes | `enabled: false` (next spawn) |
| 5 | Remove the `_PERSONAS` variables after one released version with deprecation warnings | none | re-add the reader |

**Why stage 1 changes nothing.** Until stage 4, the global opt-ins and persona lists still
gate the mechanism each wrapper declares, exactly as today. Agents that exist
before stage 1 get an `on` row at their first join. Agents spawned during
stages 1 to 3 get `on` from a launch default that stays `true` until stage 4.
Wrappers not yet updated declare no support and are granted on `on` without
an acknowledgement. So effective delivery equals the declared mechanism,
which is today's behaviour, during the mixed-version window too. Today's mix is preserved because the mechanism
already encodes it: Codex app-server declares inter-agent steer always and
operator steer only under its global or persona opt-in, and Claude declares fold
only for `ao`. The one visible difference is the fence: right after a join,
nothing is delivered early until the first `delivery_policy` is
acknowledged. Stage 1's default-composition contract test injects nothing
and asserts today's advertisement and grants. A second check, after deploy,
confirms that `ao` still advertises `fold` / `tool_boundary`, and that the
other Claude peers still advertise `none`.

## Verification plan

- Protocol and server: CAS on revision (a stale `expected_revision` is
  rejected); opt-out refuses grants before any ack; opt-in grants only after
  the current owner's ack; a re-join of a confirmed agent grants nothing early
  until the new ack; a stale ack cannot clear a newer opt-out; an old wrapper
  is shown as live switch unavailable; deleting the agent removes the row but
  not the counter.
- Old and new combinations: new server, old wrapper, policy `on` → early is
  granted with no ack (mutation: drop the "no ack asked" rule; the test must
  go red); new server, old wrapper, policy `off` → refused. Old server, new
  wrapper: a process with no policy history uses launch-time behaviour; a
  process that received `off` keeps the fence after rejoining a server that
  does not echo `delivery_policy`.
- Rows: an existing agent without a row gets an `on` row at its first join;
  a spawn writes its row before the broadcast.
- Operator intent: with the policy `off`, `unknown` or unconfirmed, an
  explicit `early` and an explicit `yield` are both stamped `normal`, and the
  reply carries `downgrade_reason`; with `on` and confirmed, the explicit
  intent passes.
- Persistence surface: the store is in `PersistencePaths.stores()`, compose
  declares it under `/var/lib/kaoiro`, and its default path is not `/tmp`. A
  close/reopen test. A mutation that drops it from the list makes the
  cross-store test fail. A deploy dry run reports `never_existed`. After the
  deploy, the operator confirms that the production container's effective
  path equals the compose value. An unreadable store yields `unknown` and
  grants nothing.
- Wrapper: the fence goes up before the opt-out ack; a new process starts
  fenced and unfences only on an `on` revision; it stays unfenced behind an
  old server. Queued granted items take the root queue with
  `local_policy_disabled`. One test per engine fixes a single outcome for an
  item at the commit point during a switch (Claude submit; Codex steer whose
  RPC is pending when the fence goes up). The sender receives the stage
  report.
- Negative controls: policy off → zero folds or steers in a native run per
  engine; exec and Antigravity → zero in-turn submissions with the policy on.
- Mutations, run one at a time, each turning its own test red: the server
  clamp, the admission check, the incarnation binding of the ack, the
  no-ack rule for wrappers without support, the wrapper fence and its
  survival across a rejoin, the revision comparison, the re-push after join,
  and the store's `unknown` fallback.
- Gates per touched layer: server `mix test` / `mix format`; wrapper, runner
  and dashboard typecheck/test/check.

Docs to update when the code lands: ADR-0063 phasing status, ADR-0058 Default
backend status, `docs/reference/configuration/{runner,wrapper}.md`,
`docs/reference/inter-agent/delivery.md`,
`docs/reference/protocol/channels.md`,
`docs/operations/server-update-and-rollback.md` (the new store).

## Operator decisions (decided 2026-10-02)

Recorded on [issue #463](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-5946655166),
on design commit `24d61f06`. Production rollout timing stays pending until the
operator instructs it directly.

Decided by the director (on the reviewer's classification):

- Host kill switch: in `runner.config.json`, following the current config
  contract. It is the `enabled` ceiling above.
- Codex backend opt-out: host-wide `codex.backend` only, as today. There is
  no per-agent backend choice.

Decided by the operator (all as recommended, except where noted for 6):

1. **Claude flip criteria.** Stage 4c requires the four paths the canary has
   not exercised: a production yield (`tool_boundary` cut) with its
   disposition recorded, the per-turn fold and overtake limits being reached,
   an oversized input taking the downgrade path, and the receipt-root timeout
   path. "Natively unmeasurable" is an acceptable, stated result. It also
   requires one `opus[1m]` canary peer and a `lost_count` 0 window.
2. **Host settings.** Two keys: an `enabled` ceiling (the kill switch, next
   spawn) and a `default` seed (new spawns and the LaunchDialog).
3. **"Just before this work merges into develop".** The backend default flip
   (4b) lands immediately before the Claude default flip (4c), the last stage
   of the series.
4. **Antigravity.** Queue fallback, with its ceiling shipped `false`, the
   toggle shown as unsupported, and a phase-4 measurement issue opened.
   Activation after phase 4 is a separate flip (4d).
5. **Codex yield.** Yield is downgraded to early, and the UI shows it.
6. **Environment flag variables.** Issue #469 moves the three global flags
   to runner config keys (`claude_code.phase2_delivery`,
   `codex.operator_steer`, `codex.approval_axis`), with the precedence in its
   section 2.4: a set variable wins over the file. This issue consumes the
   first two (see "Dependency on issue #469"). The `_PERSONAS` lists stay
   with this issue and are replaced by the dashboard switch.

A constraint that holds regardless: after stage 2, rolling the **server**
back loses the per-agent opt-out for agents spawned under the old server.
The stop that survives a server rollback is the host ceiling
`enabled: false`, effective at each agent's next spawn.

## Dependency on issue #469

- **Before stage 3.** Issue #469's group carrying the flag keys must have
  landed. Until stage 4, `claude_code.phase2_delivery` and
  `codex.operator_steer` (or their variables, which win) and the `_PERSONAS`
  lists keep gating the mechanism each wrapper declares, exactly as the
  variables do today. This design does not re-implement that precedence.
- **Stage 3** adds only `in_flight_delivery.<engine>.enabled` and
  `in_flight_delivery.<engine>.default`. They go through #469's single relay
  registry (its section 2.2) rather than a separate path. The `default`
  key also rides the runner register.
- **Stages 4a and 4c** stop gating the mechanism on those flag keys and lists:
  the mechanism is then declared whenever the engine supports it and
  `enabled` is `true`. From that point `codex.operator_steer` and
  `claude_code.phase2_delivery` have no effect. Their deprecation and removal
  are coordinated with #469 in the stage 4 review. They are not deleted
  silently.
- **Stage 5** removes `KAOIRO_CODEX_OPERATOR_STEER_PERSONAS` and
  `KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS` after one released version with
  deprecation warnings.
- **Not covered here:** `KAOIRO_CODEX_APPROVAL_AXIS_PERSONAS`, and the
  `codex.approval_axis` key, control approval requests (ADR-0064), not
  in-flight delivery. Issue #469 lists that `_PERSONAS` list under this
  issue, but a per-agent approval switch is a different feature. Its routing is
  left to the director; this design neither migrates nor removes it.
