---
title: Default-on in-flight delivery with a per-agent opt-out
description: Design for making in-flight delivery the default on every engine, with a revisioned per-agent opt-out stored on the server and switchable from the dashboard at launch and live.
status: approved
last_updated: 2026-10-10
---

# Default-on in-flight delivery with a per-agent opt-out

Issue [#463](https://github.com/sakuraiyuta/kaoiro/issues/463); end state in
[ADR-0063](../adr/0063-layered-delivery-authority-and-continuations.md)
(Amendment 2026-10-01) and [ADR-0058](../adr/0058-codex-app-server-turn-steer.md)
("Default backend"). This is the approved design and remaining
implementation plan. The revised design has independent approval; implementation children require their own
design and implementation reviews. Production operations and native runs
require their own authorization and budget. The ten children below are filed
as issues 558 to 567 ([mapping](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-6066094342)).

"In-flight delivery" means: operator early input (Claude fold, Codex
`turn/steer`) and inter-agent early / yield delivery into a running turn.

## C1W implementation boundary

The wrapper implementation for [issue #560](https://github.com/sakuraiyuta/kaoiro/issues/560)
shares one controller between each Claude/Codex CLI transport and host. Off
blocks new acceptances before its ack; previously accepted Claude receipts
may still reach the SDK afterwards. Native controls and independent
implementation review remain prerequisites to landing this child. C1W does
not retire launch flags or change mechanism defaults. Its candidate was forked
from the C1S branch at `7df92a775237ef6696d4b16b56a14c5840245d96`, then
replayed onto landed C1S `8e9360a5507c0ca2387df48c1118903a14544197`;
release only after the supporting C1S server is integrated. Rollback below a
live wrapper's high-water requires restarting that affected wrapper, as
[documented](../operations/server-update-and-rollback.md#delivery-policy-revision-recovery).
The [C1W evidence record](../evidence/issue-463/2026-10-09-c1w-live-delivery-policy.md)
separates native RPC acceptance, model inclusion and remaining measurement limits.

## C3 implementation boundary

The runner resolves host ceilings and independent new-row defaults from the
canonical `in_flight_delivery` engine table. Antigravity omissions resolve to
false for both keys. Startup, successful reload and catalog refresh share one
applied snapshot with subsequent wrapper launches, including the four captured
legacy delivery environment variables. Legacy mechanism opt-ins and the Codex
backend default remain in place. Bounded launch metadata uses the shared pure
resolver and a required cross-client JSON contract fixture. Integration evidence
must cover the producer through real server register to the dashboard decoder
and UI; independent implementation review remains required before landing.

## Current state (develop `0bfede23`, re-checked at `867696cb`; production decision E3)

Source defaults and configured production behavior are separate:

| Engine/backend | Supported operator / inter-agent mechanism today | Shipped controls and omitted-setting behavior | Production starting point / remaining work |
|---|---|---|---|
| Claude Code | fold / fold and `tool_boundary` yield, when enabled at launch | `claude_code.phase2_delivery`, environment override and `_PERSONAS`; the mechanism is still gated at wrapper start | All Claude peers enabled since October 3, according to E3 and Ao's inventory. Replace legacy opt-ins with the new ceiling/policy; no first production flip remains. |
| Codex app-server | `turn/steer` / `turn/steer`; yield downgrades to early | `codex.operator_steer`, environment override and `_PERSONAS` gate operator steer; inter-agent steer is enabled for this backend subject to existing admission/order checks | Production explicitly selects app-server and enables operator steer. Introduce live per-agent policy, then retire the operator opt-in. |
| Codex exec | queue / queue | Still the omitted backend in wrapper and runner code; no mid-turn mechanism | Remains an explicit backend fallback. Stage 4b changes the omitted-setting default, rather than switching the already-configured production peers for the first time. |
| Antigravity | queue / queue | Join omits delivery-mode declarations; no measured later-turn mid-flight delivery seam | Keep its ceiling false and the UI unsupported. Phase 4 measurement and later activation remain separate work. |

The production column records [the E3 operator decision](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-6063194859)
and Ao's inventory.

Prerequisites and baseline facts:

- [Issue 346](https://github.com/sakuraiyuta/kaoiro/issues/346) is closed;
  app-server inter-agent steer is shipped. It is not a future prerequisite.
- [Issue 489](https://github.com/sakuraiyuta/kaoiro/issues/489) is closed;
  the explicit Codex operator-mode declaration fix landed as `70e47552`.
  Preserve it when the ceiling or policy is off. Do not restore fallback
  from omitted operator modes to the inter-agent modes.
- [Issue 469](https://github.com/sakuraiyuta/kaoiro/issues/469) is still
  open for other groups, but the three flag keys landed in `5b78697d`,
  an ancestor of this baseline. Stage 3 needs that shipped registry,
  not the closure of the whole issue. A set legacy environment variable
  wins over the file. Config reload affects subsequent spawns without a
  host-wide runner restart.
  Existing wrapper declarations remain fixed for their process lifetime.
- There is still no `delivery_policies` store, `set_delivery_policy`,
  `delivery_policy_applied`, or `in_flight_defaults` in the relevant
  server/protocol/runner/wrapper/dashboard sources at this baseline.
  The per-agent opt-out remains proposed work.
- Correct `delivery.md` to describe Antigravity's omission and honest
  queue fallback, rather than claiming it declares two explicit `none`
  fields.
- The `in_flight_delivery` engine keys remain the plan's canonical engine
  names: `claude-code`, `codex`, `antigravity`. The old config block
  `claude_code` is a different spelling. The runner registry supplies the
  mapping; do not create a second relay path.

Source claims use `bf02a928`, whose relevant source paths are unchanged at
`0bfede23`, and at `867696cb` (only `AGENTS.md`, `CLAUDE.md` and docs differ
from `0bfede23`).
Production configuration is recorded from the operator decision; the
[C0 record](../evidence/issue-463/2026-10-09-c0-baseline-and-codex-evidence.md) adds a dated read-only observation
of the three configuration keys and the effective delivery modes. The policy
described below remains unimplemented at this base.

## Design

### Two separate things: supported mechanism and effective policy

The phase 3 plan (`docs/plans/adr-0063-phase3-codex-early-delivery.md`,
"Dependency and end-state route") already concluded that the join-time echo
must stay frozen and that a live switch needs a separate revisioned policy.
This design adopts that route.

- **Supported mechanism** (per wrapper process, fixed for its lifetime): what
  the engine and backend can do, limited by the host ceiling (below) and,
  until stage 4, by the shipped issue #469 config keys, environment
  overrides and `_PERSONAS` lists. It is declared at join as today.
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

So per-agent `on` works on a host whose default is `off` (the selected-agent
configuration that the legacy `_PERSONAS` lists provide) while the ceiling
is `true`. The kill switch stops every agent of that engine at its next spawn; to stop running
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

The following wire and store names belong to the approved design; their
implementation remains planned.

- New DETS store `delivery_policies` (`KAOIRO_DELIVERY_POLICIES_PATH`), one row
  per agent: `{agent_id, policy, revision}`, plus a never-deleted revision
  counter namespace, the same layout as `PermissionSettings`
  (`{:settings, id}` / `{:counter, id}`). Writes are synchronous, like
  `PermissionSettings.submit_request/5`.
- It is registered in `KaoiroServer.PersistencePaths.stores()`, so it reaches
  `mix kaoiro.env`, the cross-store tests and the deploy manifest
  (issue #310).
- **Deploy.** Register and wire the new store on the named state volume.
  An authorized prepare may report ordinary consistency match or an
  explicitly accepted new-store mismatch. Neither permits maintenance
  without the unconditional target effective-path/mount gate in
  [Policy-store deployment](#policy-store-deployment-and-pre-maintenance-gate).
  Dry-run is not an env-consistency measurement. Rollback's old image
  ignores the new file; its policy limitations remain as described below.
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

Agreement with issue #469: its flag-key group has moved host-wide settings into
`runner.config.json` and explicitly leaves the `_PERSONAS` lists to this
issue. The two host keys above follow #469's contract. The per-agent value
lives on the server, because it must change live and survive the wrapper.
The two in-flight `_PERSONAS` lists are retired, not migrated (stage 5). The
legacy global flag keys are already shipped; see "Dependency on issue #469".

### Live switch protocol

1. Dashboard → server `set_delivery_policy {agent_id, policy, expected_revision}`.
   Operator-only, using the authenticated channel role rather than a payload
   claim. Refuse viewers before any write, revision increment, wrapper push
   or applied-state change, even when no dashboard is present. The server
   compare-and-sets the revision, persists the row
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

- Claude: the commit point is synchronous `AgentHost.pushLiveInput` acceptance,
  after formatting/size checks and before receipt, queue or quota mutations.
  An item classified as early checks the fence again at submit. If the fence
  is up, the item goes to the
  root queue with `local_policy_disabled`. A yield whose claim succeeded but
  whose cut is not yet pushed is not cut; the item takes the existing
  failed-claim path, which the fence then sends to the root queue. The policy
  revision is read at the commit point, never earlier. A change in the middle
  of a turn therefore cannot split one item.
- Codex app-server: the commit point is the synchronous start of
  `turn/steer`. A steer whose RPC was already started before the fence keeps
  its outcome from the RPC result. Accepted/corroborated input remains
  steered. Definite precondition rejection may fall back to the root queue.
  A possibly delivered write with an uncertain result is not retried or
  duplicated into that queue. Preserve one outcome per item. No new steer
  starts after the fence.
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
  the gate. It is read only at the scheduler submit/cut commit points
  described above. Supported mechanism: fold and `tool_boundary`.
- **Codex app-server:** the policy gates `trySteerInterAgent` and the
  operator steer path at the synchronous `turn/steer` commit point. Yield stays unsupported. A director's yield is downgraded to early
  (phase 3 plan, ADR-0063 D2/D9). The dashboard shows "early only".
- **Codex exec:** mechanism none. The toggle is shown as unavailable and the
  agent queues. Choosing exec is the backend opt-out. It is a launch or resume
  choice through host-wide `codex.backend`, not the live toggle; legacy
  sessions follow the C4B compatibility procedure below.
- **Antigravity:** mechanism none until ADR-0063 phase 4 measures a
  `PreInvocation` path. Today only the first invocation has been measured
  (issue #412). Its host ceiling `in_flight_delivery.antigravity.enabled`
  ships as `false`, and the toggle is shown as "not supported by this
  engine; messages queue". When phase 4 lands, nothing starts by itself:
  the mechanism appears only when the operator sets the ceiling to `true`,
  as its own default flip (stage 4d) with evidence and review. Stored
  per-agent policies apply from that point. C4D tracks later-turn delivery
  after [issue 541](https://github.com/sakuraiyuta/kaoiro/issues/541) lands,
  alongside issue 416 and the issue 412 boundary, without duplicating their
  turn-identity work. It does not block Claude/Codex policy integration.

### Policy preserves the current ordering contract

Default-on permits an eligible mechanism; it does not prove a particular
input was steered or override delivery authority, reply authorization,
incarnation or size checks. Ordering is base-relative: C1W and C4A must
preserve admission and commit-time ordering rules in force at their pinned
implementation base. Record that base and its allowed/blocked cases. This
requirement works before or after issue 548; do not restore a superseded
same-sender/open-root guard or bypass a still-applicable guard. The director
coordinates shared writers without prescribing a landing order with 548.

### Dashboard

- Viewer sessions have no actionable launch or agent-detail policy control;
  read-only state remains available. C2 tests this UI guard independently
  of C1S's authenticated server-role refusal.
- LaunchDialog: an "in-flight delivery" checkbox. Its initial value is the
  host default for the selected engine (from the register). It is disabled
  when the ceiling is `false` or when the engine or backend has no mechanism.
- AgentDetail: a toggle that shows the effective state (`on`, `off`,
  `pending`, `unknown`, `unsupported`, `live switch unavailable`) and the
  mechanism (fold, steer, early only). It shows `on` only after the applied
  ack. It is operator-only, guarded by both the server gate and the client
  `isOperator` check.

## Prerequisites for retirement and remaining defaults

**Claude 4c.** E3 treats the enablement prerequisites as satisfied:
production yield disposition, fold/overtake limit exercise,
oversized downgrade, receipt-root timeout, an `opus[1m]` canary, and the
`lost_count` zero window. Do not reproduce them as blockers in stage 0,
stage 4c, a child issue, or an operator decision still waiting to be made.
Tests and native negative controls for the **new policy/fence
implementation** remain required.

**Codex 4a.** Audit the recorded ADR-0058 steering evidence, including
thinking/tool-running probes, review/compact fallback, resume and
interruption, against their actual artifact/pin. Retain the existing
0.159.3 evidence as evidence for that pin; do not silently treat it as
a measurement of a later artifact. Fill genuinely missing or invalidated
rows through separately approved native runs. These rows establish the
backend migration requirements. The C0 inventory of this evidence is the
[C0 record](../evidence/issue-463/2026-10-09-c0-baseline-and-codex-evidence.md#3-codex-evidence-inventory).

**Codex 4b.** Retain ADR-0058's configuration capture, account/model
defaults, hooks, credential-refresh and compaction requirements for the
code default change. Existing production selection can support a row
only with a dated, artifact-bound observation. Sweep all omitted-setting
paths: runner relay, wrapper selection, host construction, register/
diagnostic defaults, and history/backend consumers. Change values that
mean the default adapter; retain values that intentionally mean an
explicit exec backend or an exec-specific compatibility path. The exact
source edits belong in that child's reviewed implementation design.

### C4B compatibility choice: keep unmeasured exec sessions on exec

**Chosen:** no automatic exec-session → app-server resume. A legacy exec
agent is any Codex agent whose current session was launched under exec,
including agents spawned while the host compatibility pin was in place.
Such an agent remains on exec until the operator deliberately starts a new
native session, or until a separately reviewed, current-artifact measurement later
approves that exact transition. C4B does not obtain such approval by changing
a default literal.

Grounding at bf02a928:

- `docs/evidence/codex-app-server/backend-rollback-artifact.md` measures
  **app-server → exec** resume on 0.153.4 with a loopback provider. It does
  not establish the reverse direction on the C4B pin, production auth/model
  behavior, or an omitted-default migration. ADR-0058's resume requirement
  still applies. No matching reverse-transition measurement was produced
  for this plan, so it claims none.
- Selection is host-wide, relayed as `WrapperConfig.codex_backend`
  (`runner/src/supervisor.ts:499`); `resume_snapshot.ts:75-85` has no backend
  field. Config reload changes selection for subsequent wrapper lifetimes
  (`supervisor.ts:736-741`). Do not infer a session's original backend from
  a bare UUID, an absent snapshot field, or the new default.

Use the existing explicit **host** `codex.backend: "exec"` opt-out to retain
compatibility; add no per-agent backend selector or UI field. The limitation
is intentional: while legacy exec sessions remain resumable on that host,
new Codex agents there also use the explicit exec selection. This does not
alter hosts, including current production, that already explicitly select
app-server, or empty hosts using the new omitted default.

The C4B runbook must precede a code update/default change with an inventory
of affected omitted-backend hosts and their legacy sessions. This initial
inventory is not the pin-removal inventory: while the pin remains set, new
agents can acquire exec sessions too. If an existing session's backend is unestablished, pause that host's migration and obtain
its launch evidence; do not guess app-server or automatically resume it.
For hosts known to have used the old omitted exec default, persist the
explicit exec selection and confirm the applied config before any restore,
restart or wrapper respawn under C4B. Keep the setting through runner and
server restart. Existing agents' per-agent delivery-policy rows are intact;
exec still has no in-flight mechanism.

Removing this compatibility setting is an operator-controlled new-session
operation, not a hot backend switch. Use the following coordinated procedure
under one operator-owned maintenance operation, with no competing operator
restore, reset, session selection or instruction delivery for the affected
agents:

1. **Keep explicit exec.** While the affected wrappers are still registered,
   complete the existing operator `session_reset` with mode `new` for each
   legacy agent. This preserves display history; `clear` is not required.
   Wait for completion/join, not merely `spawn ok`, and stop immediately
   after that join in step 2. Peer input can arrive between reset and stop
   and create another exec session; if a non-nil pointer appears, keep the
   pin and repeat the reset/stop operation. Competing operator actions are
   held by the maintenance owner; peer deliveries are not assumed held.
   At bf02a928, `SessionResets.commit_connection` detaches the old SessionPointer ID
   on success (`session_resets.ex:617-651`; ADR-0036 F4). Keep exec throughout
   this phase: reset's synchronous fresh-launch failure resumes the old ID
   via `Supervisor.#rollback` (`:1706-1821`), so changing the backend first
   would make that fallback an unmeasured cross-backend resume.
2. Deliberately stop these known supervised agents through the normal
   operator stop control. Confirm all affected agents are disconnected,
   no reset/transition remains pending, and their persisted pointers have
   **session_id nil**, retaining agent ID/cwd/engine/snapshot/policy. Codex
   fresh IDs are normally lazy until a first input; if any pointer is
   non-nil or unobservable, stay on exec and repeat/resolve the new-session
   phase. Do not erase a pointer by raw DETS editing or guess it detached.
3. Only after all remaining legacy agents on the shared host satisfy that
   boundary, remove the host compatibility pin and confirm the applied new
   default. Restore each same agent through the existing operator restore
   **fresh branch**: `build_restore_payload` for a nil pointer omits
   `resume_session_id` and sets `apply_resume_snapshot: true`
   (`agents_channel.ex:3192-3224`). The launcher therefore receives no
   `--resume`; an old exec ID is not handed to app-server. If fresh restore
   fails, leave it disconnected/fresh and restore the explicit exec setting
   for recovery; do not use a reset's old-ID rollback under app-server.

The C4B preflight must retake the whole affected-host inventory at pin-removal
time, including agents created during the pinned interval, and observe these
completed boundaries before clearing the pin. Recheck the fresh-pointer
condition before each restore. It refuses unknown, non-nil, incomplete or
changed observations before launching. On a shared host, do not clear the
pin while any legacy agent could still respawn its old ID. A new native ID
is observed on the first later approved input, rather than invented at join.
Resuming an archived legacy session later requires restoring the explicit
exec host setting first, or reviewed reverse-resume evidence. These future
reset/stop/restore actions need their own authorization; none is performed
or authorized here. This is a proposed runbook/preflight for C4B, not a
claim that the existing restore API itself enforces a backend-origin guard.

C4B acceptance includes fake-launch/config tests for legacy-host explicit
exec → same-session restore, deliberate fresh session → omitted app-server,
and an already explicitly app-server host → unchanged restore. Also force
the exec-phase reset's fresh launch to fail and observe old-ID rollback still
selects exec. The legacy preflight refuses an unprepared omitted-default
migration before a resume launch. Independently omit the explicit exec
preparation and the nil-pointer boundary checks on legacy-host fixtures:
the corresponding refusal tests must fail. A failed reset, one non-nil
remaining sibling, an agent created while pinned with a non-nil pointer,
or an unknown pointer prevents pin removal/app-server restore. A fake-table
case specifically adds that pinned-interval agent after the initial
inventory and requires pin removal to fail. Omitting the re-inventory must
make this case red.
Use fake launch/session tables, never real-host process scans or unknown
PIDs. New session IDs and unchanged stored policy are observed separately.
Real native claims require their own approved, exact-pin evidence;
these deterministic tests establish routing
and the runbook gate only.

**Antigravity 4d.** E3 does not waive phase 4. Require
[issue 541](https://github.com/sakuraiyuta/kaoiro/issues/541) to land before
native later-turn measurement or activation; an unavailable wrapper must
not be mistaken for a delivery failure. Track measurement alongside
[issue 416](https://github.com/sakuraiyuta/kaoiro/issues/416)
and the [issue 412](https://github.com/sakuraiyuta/kaoiro/issues/412)
PreInvocation boundary. First-invocation success alone does not establish
delivery into a running later turn. Keep queue behavior and the false
ceiling until the separate implementation/evidence/activation review.

## Stages and rollback

| Stage | Remaining content | Behavior relative to the current production baseline | Rollback / completion boundary |
|---|---|---|---|
| 0 | Pin current state; audit remaining Codex evidence; fix delivery docs; track phase-4 measurement; note 489 and 469 prerequisites already shipped ([C0 record](../evidence/issue-463/2026-10-09-c0-baseline-and-codex-evidence.md)) | None; Claude's retired first-flip checklist is excluded | Documentation/evidence only; no production operations in this design task |
| 1 | Store, protocol, server clamps/admission and Claude/Codex local fences | Preserve enabled mechanisms and old-wrapper on; supporting wrappers have the stated join-to-ack queue window | Old image ignores the new file; retain the mixed-version/rollback limitations above |
| 2 | Launch checkbox and live detail control | Adds the operator's per-agent opt-out and honest pending/unsupported states | Hiding UI retains rows; server rollback cannot preserve policy for newly spawned old-server agents |
| 3 | Runner ceiling/default keys, single registry relay and re-register | Unchanged settings preserve behavior; explicit ceiling/default edits affect their documented next-spawn/new-agent paths | Remove new host keys only with their documented fallback; keep server rows |
| 4a | Retire Codex operator-steer global/persona gates; use enabled ceiling and default-on per-agent policy for app-server | Existing configured-on peers stay on unless opted out; previously unconfigured supported peers gain the new default | Per-agent off live; ceiling false next spawn; explicit exec remains unsupported/queued |
| 4b | Normalize omitted Codex backend to app-server in code; retain explicit exec on legacy-session hosts | Configured production app-server stays unchanged; fresh/default hosts use app-server; legacy exec sessions remain exec under the compatibility procedure | Explicit host exec next spawn or code revert; old-session resume is not silently migrated; removing the host compatibility pin requires the documented new-session operation |
| 4c | Retire Claude global/persona gates; use ceiling and default-on policy | Existing configured-on peers stay on unless opted out; defaults no longer require legacy flags | Per-agent off live; ceiling false next spawn; code revert. No old six-condition flip gate |
| 4d | Separate Antigravity phase-4 implementation and reviewed activation | Future mechanism change after measurement; until then queue/unsupported/ceiling false | Ceiling false next spawn; retain this unresolved scope on the parent |
| 5 | Remove retired in-flight flag/list readers after the warning window | No change for configs migrated to the new keys | Coordinate removal with 469; reintroducing a reader must not discard stored opt-outs |

Stage 4b lands immediately before 4c in the retirement series.
The independent 4d activation is outside that adjacent pair; stage 5
waits for the released deprecation window rather than elapsed wall time.

At 4a/4c the old keys and lists cease gating supported mechanisms.
Recognize their presence and warn through the documented release window;
do not silently discard them or map an old opt-in onto a stored off row.
The new ceiling and policy are authoritative after retirement. Removing
readers later is distinct from the stage that stops using them as gates.
`codex.approval_axis`, `KAOIRO_CODEX_APPROVAL_AXIS`, and its `_PERSONAS`
list remain outside this issue.

## Policy-store deployment and pre-maintenance gate

[Issue 339](https://github.com/sakuraiyuta/kaoiro/issues/339) is closed; its explicit `--accept-new-store` behavior is in bf02a928.
C1S implements the following prepare/runbook gate for this store:

1. Register `delivery_policies` / `KAOIRO_DELIVERY_POLICIES_PATH` in
   `PersistencePaths`, the runtime override, sample env generation,
   compose's state-volume declaration, and backup/cross-store surfaces.
   The production effective path must be the compose path under
   `/var/lib/kaoiro`, not a temporary-directory fallback.
2. Do not state that the canonical fallback itself is already persistent.
   At the baseline, `DetsStorePath.default_path/1` uses
   `System.tmp_dir!()/kaoiro-dets/<file>`, and `manifest/0` reports that
   fallback. Keep the manifest faithful to the store's real fallback.
   This plan proposes no shared fallback/manifest API change.
3. `update --dry-run` does not build the image or execute
   `env_consistency`. A future, **separately authorized** prepare without
   `--maintenance-approved` records that observation before the stop
   window. Inspect the prepared transaction, not a fictitious dry-run
   observation. Preparing is itself a mutating deployment action and is
   not authorized by this plan.
4. An ordinary observed `match: true` requires no first-application
   fields or flag. It is only the consistency result, **not permission to
   enter maintenance**: step 6 is mandatory for this store in this branch
   too. At bf02a928 `checkEnvConsistency` computes
   `match = compose === containerEffective` (`:996-1003`). When the old
   container has no override and the store's fallback is temporary,
   compose can produce `match: true` by declaring that same temporary path.
   Reject that configuration before maintenance in step 6.
5. On a mismatch, require the operator's explicit
   `--accept-new-store KAOIRO_DELIVERY_POLICIES_PATH` and the deploy
   CLI's checks/observations: genuinely new store (or the operator's
   historical assertion if the old manifest is unavailable), no old
   configured env value, named-volume destination, absent file probe,
   `first_application: "never_existed"`,
   `operator_accepted_new_store: true`, and `match: true`. A present or
   undetermined file, an old manifest already containing the store,
   or an unset/incorrect destination must not become an automatic pass.
   Otherwise stop before maintenance and follow the runbook's migration
   procedure; do not repair the deploy algorithm in this work.
6. In **both branches** (ordinary match in step 4 and explicitly accepted
   mismatch in step 5), before approving maintenance, require a prepare
   record that the **target startup's effective**
   `KAOIRO_DELIVERY_POLICIES_PATH` resolves beneath `/var/lib/kaoiro`
   on the named state volume. Use compose's resolved environment, not
   the informational `.env` `declared` value. Confirm the new store's
   runtime override and startup path resolver against the prepared
   target artifact with that environment; its manifest must still
   describe the genuine fallback. Record the observed effective path
   and the named-volume placement as defined below. Missing, unreadable,
   unresolved, shadowed, outside-volume or disagreeing observations stop
   the procedure before maintenance; do not substitute an expected path or create the store
   in the temporary directory. The old-container fallback probed for
   absence may be under `/tmp`; it is not the target effective path.
   The existing new-store check already refuses a compose destination
   outside its named state volume. Do not claim that check alone proves
   the new module consumes the runtime override: the artifact/path
   observation is a separate required prepare step. Pin it with the
   ordinary-match temporary-path case, correct-compose / target-fallback
   case, and nested-mount case before calling it verified. This specifies
   a future authorized prepare procedure,
   not an existing new target-runtime verifier or a live check here.
7. `prepare_parent!/1` is not a persistence gate. At bf02a928 it rejects
   only a parent whose expanded path equals `System.tmp_dir!()`.
   `/tmp/kaoiro-dets/delivery_policies.dets` has a different parent and
   passes that check. Directory creation/permissions therefore do not
   establish state-volume persistence; retain the prepare check above.
8. After a separately approved update, observe the effective path and
   restart persistence. The old server ignoring the file is not evidence
   that a rollback preserves opt-out on newly spawned agents.

### Named-volume placement and the pre-maintenance gate

The positive condition is physical mount placement, not the lexical
`isUnderStateVolume` result. At bf02a928 that helper (`:910-914`) only
normalizes a path's lexical relationship to `/var/lib/kaoiro`.
`resolveNamedVolumeFromCompose` (`:1295-1319`) finds the volume at that
exact target but does not check whether another nested mount hides it.
Neither helper alone proves this store is on the backed-up state volume.

For the prepared target and the same service/environment as step 6:

1. Build the complete target mount table as the union of resolved compose
   `services.<service>.volumes` (all types), `services.<service>.tmpfs`
   (each tmpfs target, including the service-key form), and anonymous
   volumes from the prepared image's `VOLUME` declarations. The Dockerfile
   at the pinned base declares no `VOLUME`; a later image may. Bind the
   union to the prepared image/config, not the old running container.
   Resolve image-volume declarations and override precedence; an unknown
   or ambiguous observation refuses maintenance. Do not infer completeness
   from the existing volumes-only named-volume resolver.
   If using a prepared target's inspected table instead, read both
   `.Mounts` and `HostConfig.Tmpfs` and account for image volumes. C1S must
   measure whether compose `tmpfs:` targets appear in `.Mounts`, in
   `HostConfig.Tmpfs`, or both, on its approved target/Compose pin before
   relying on either view. This is an unmeasured C1S item here, not an
   assertion that either Docker field alone is complete.
2. Use the target startup's observed absolute effective file path. Normalize
   container path segments, respect segment boundaries, and resolve any
   filesystem aliases in the target namespace (or establish that none
   changes the observed path). An unresolved alias/path is not a pass.
3. Collect every mount whose target contains that path, using equality or
   `target + "/"` component-prefix matching. The containing mount with the
   **longest target prefix** must be type `volume`, with target exactly
   `/var/lib/kaoiro`, and the expected resolved named-volume source. Resolve
   a compose source key through its volume definition/name; a prepared
   target table must identify that same volume. Record the selected mount
   and the relevant full table so a shadowing mount is visible.
4. Refuse an absent/unreadable/incomplete table, an ambiguous duplicate
   target, an unknown source or a different longest-prefix mount. A nested
   tmpfs, bind mount, or even a different named volume beneath
   `/var/lib/kaoiro` fails for a store in that nested subtree. A nested mount
   at an unrelated sibling does not fail. `/var/lib/kaoiro-other` is not
   beneath this mount.
5. The prepare validation result gates the subsequent maintenance step in
   the same workflow: require both an acceptable consistency result and
   step 6's verified target path/mount result before requesting/invoking
   `--maintenance-approved`. Failure or unknown ends the workflow first;
   printing a warning or recording a desired path is not validation. Bind
   the observation to the transaction/prepared artifact and resolved config;
   a changed artifact/environment/mount table invalidates it and requires
   a new check. The later C1S implementation design names this workflow's
   real entry point and its stopping behavior. This plan supplies no existing
   CLI verifier and changes no shared env-consistency algorithm.

Required fake-observation cases include an ordinary `match: true` where
compose equals `/tmp/kaoiro-dets/delivery_policies.dets`; approved mismatch
with a good effective path and state volume; good lexical path with a
nested tmpfs declared via the separate `tmpfs:` key and via long-form
`volumes` with `type: tmpfs`; image `VOLUME` shadowing; nested bind; nested
different volume; unknown table; and a non-shadowing sibling mount. In the ordinary-tmp case, no first-application
flag is needed by the CLI but **the workflow must still refuse maintenance**.
Dropping the step-6 gate only in the match branch, ignoring the longer
mount prefix, omitting the `tmpfs:` key from the union, or omitting image
volume declarations must make each corresponding test fail independently.
Tests invoke the workflow's real entry point with fake Docker/path/process observations and
assert the maintenance/stop call is never reached on refusal.

These two consistency paths are still acceptable only **together with**
this unconditional target-path/mount gate. The shared DETS temporary
fallback and truthful manifest are unchanged. All prepare observations and
subsequent updates are later, separately authorized operations; none is a
completed live deployment check in this plan.

## Verification plan

This is a verification plan, not test results. Implementation children
must run the project gates for the touched layers and transcribe counts
and exit codes from logs. Bind results to their final commits/artifacts.

- **Default composition:** for each changed production constructor/startup
  path, include a test with no dependency injection through its first
  meaningful lifecycle action. Omitted backend must select app-server
  after C4B; explicit exec must still select exec. Test runner omission
  through wrapper startup as well as direct wrapper omission. A fixture
  that supplies app-server cannot prove the omitted-setting default.
- **C4B history and reported defaults:** change the CLI replay selector at
  `wrapper/codex/src/cli.ts:665` to use the CLI's already resolved backend
  (selected once per wrapper lifetime), rather than a separate literal
  fallback while `host` is absent. This is consistent with the host-wide
  selection contract. In a wrapper started with backend omitted, hydration
  must use app-server history and preserve the expected replay/reset/live-log
  ordering; explicit exec must use exec history. Mutate only this replay
  selector to the old omitted exec resolution (`config.codex_backend ??
  "exec"`): the omitted-wrapper replay test must fail while actual Host
  selection remains app-server. A dormant `host ?? exec` branch that the
  lifecycle never calls cannot establish this behavior.
  Independently mutate only `host.ts:1494`'s omitted `historyBackend`
  fallback back to exec: a host constructed with backend omitted must expose
  app-server to its history consumer and that test must fail. A host test
  that injects `backend: "app-server"` cannot pin the omitted fallback.
  Independently mutate only `host.ts:337`'s `initialStatusExt` omitted
  resolution back to exec: the initial status/capability projection before
  host readiness must fail its app-server expectation (including
  `supports_context_usage`); do not wait for a later state to overwrite it.
  Preserve an explicit-exec positive at every consumer, and sweep the helper
  default at `host.ts:295` with the remaining default-adapter sites. These
  three mutations run separately on the final C4B artifact, restore after
  each, and record the actual failing test/count/exit. This adds to the
  existing runner relay and wrapper entry mutations; it replaces none.
- **C4B session routing:** on a known legacy omitted-exec host prepared with
  explicit exec, restore the old session through the default launcher and
  observe exec selection and the same session ID. After the deliberate
  fresh-session operation, omitted selection is app-server and a new ID is
  produced. Existing explicit app-server production restore is unchanged.
  An unknown-origin resume is not evidence of either cross-backend path.
  Pin the legacy compatibility preflight as described above; native
  cross-backend success is not asserted by these fake routing cases. Pin
  exec-phase reset failure/rollback and the all-siblings nil-pointer boundary
  separately; a successful launcher return alone cannot prove detachment.
  Re-inventory at pin removal must catch an exec session created under the
  pin after the initial inventory. A non-nil pointer blocks removal; remove
  only the re-inventory and observe its refusal test fail. Peer input between
  reset and stop must require reset/stop repetition while keeping exec.
- **Policy separation:** stored off survives restore, restart, host-default
  changes and flag retirement. With ceiling true/default false, an
  explicit per-agent on may work; ceiling false prohibits the mechanism
  even for a stored on. Mutate the ceiling check and the seed-only
  assignment separately; corresponding tests must fail.
- **Mixed versions:** retain all four combinations; removing the
  old-wrapper no-ack exception must make its compatibility test fail. Mutate stale-ack owner
  binding and old-server fence retention separately. Supporting-wrapper
  on cannot grant before its ack; off refuses before an ack arrives.
- **Admission and commit:** mutate the server explicit-intent clamp,
  unreadable-store refusal and each engine's final fence check. Pin the
  single outcome for Claude submit and an already-started Codex RPC.
  Test both operator and inter-agent traffic; testing one does not prove
  the other is connected to the policy.
- **Retirement:** with old flags/lists absent, the new default works.
  Legacy flags/list presence cannot override a stored off or false
  ceiling. Warning/removal tests cover config keys and environment
  variants while preserving approval-axis readers. Restore a retired
  opt-in-only gate as a negative control: the absent-flag default test
  must fail. For C4B, restore an exec fallback at the runner relay and
  wrapper entry separately so both production paths are pinned.
- **Ordering:** derive allowed and blocked cases from the ordering rules
  in force at C1W/C4A's exact base. With policy on, the policy layer must
  preserve those results at admission and commit; with off, it must stop
  in-flight submission without duplicating delivery. Cover queued operator /
  synthetic input, peer/root ownership, same-CID and same-sender cases,
  cap exhaustion, and arrivals between admission and commit according to
  that base. If 548 permits an own-running-root steer, preserve that allowed
  case rather than reinstating bf02a928's blanket guard. Remove each still
  applicable ordering check at its real entry point and observe the relevant
  blocked-case test fail. Run this with the base's caps and authority rules;
  enabling policy must not bypass them. No relative landing order with 548
  is required by this wording.
- **C1S server authorization:** a viewer's direct `set_delivery_policy`
  channel message is refused with no policy write, revision increment or
  wrapper push, even with an operator-like payload. An authenticated
  operator can write with correct CAS. Remove only the server role gate:
  the direct-viewer refusal test must fail. Exercise the actual channel
  handler, not a dashboard callback.
- **C2 UI authorization and display:** render launch/detail flows with a
  viewer session and observe no actionable policy write control; an
  operator session has it. Remove only the UI guard: that render/interaction
  test must fail independently of C1S. Pending is not shown as on;
  old-wrapper live limitations, Codex yield downgrade, exec and Antigravity
  unsupported state remain visible. Mutate ack-to-display wiring separately.
- **Persistence:** default/runtime/manifest/compose agreement tests,
  close/reopen persistence, cross-store backup coverage, and a mutation
  removing the new store from the canonical list. Deploy branch tests
  use fake Docker/process/file observations: good ordinary match after the
  store already has a volume override, approved new-store mismatch, missing
  approval, present/undetermined old file, and old-store mismatch. Both
  consistency branches must pass the target path/mount gate. Negative
  controls include compose declaring the temporary fallback and producing
  `match: true`, target startup consuming the temporary fallback despite a
  correct compose entry, nested tmpfs through both the service `tmpfs:` key
  and long-form `volumes`, image-declared anonymous-volume shadowing, nested bind or
  different-volume mounts, and an unknown mount table. A non-shadowing sibling mount is a positive control.
  Remove the match-branch gate, longest-prefix selection, service-`tmpfs`
  union member and image-volume union member separately;
  each corresponding entry-point test must fail, with no maintenance/stop
  call reached. Unknown observations must not authorize the stop window.
  No real Docker/deploy runs in automated tests or this plan-update task. Prepare/effective-path observation is a later
  separately authorized operation. C1S measures `.Mounts` versus
  `HostConfig.Tmpfs` reporting for service-key tmpfs on the approved pin.
- **Native controls:** before claiming the new live policy works, run
  approved, artifact-bound on/off comparisons for Claude and Codex
  app-server with operator and peer input, checking off causes zero
  folds/steers/cuts while input still queues. Exec and Antigravity remain
  zero in-turn submissions under policy on. Native SDK behavior is not
  established by a handwritten fake. Antigravity later-turn evidence
  belongs to C4D; additional live runs require the director/operator's
  budget and authorization. E3 removes only the old Claude flip gate,
  not these new implementation checks.

Do not run real-host process enumeration/kill code or its mutations.
Any relevant cleanup/process-table tests use synthetic tables; owned
test children may only be addressed by their directly known positive
PID/PGID under the host rules. Production delivery settings, deploy and
Docker were not exercised for this artifact.

Gates for each implementation child: server `mix test` / `mix format`;
wrapper and runner typecheck/test; dashboard check/test. Transcribe actual
counts, exit codes, warnings and unhandled errors. Run native measurements
through production composition, with director/operator allocation; the
retired Claude first-flip checklist is not a new-policy gate.

Docs updated by implementation: ADR-0063 phasing, ADR-0058 default-backend
status, runner/wrapper and server configuration/persistence references,
inter-agent delivery, protocol channels, and server update/rollback. Store
wiring includes generated environment, compose and backup surfaces. C4B's
runbook records the explicit-exec compatibility pin, deliberate new-session
boundary and absence of reverse-resume evidence. Delivery documentation
tracks its current base's ordering contract and distinguishes capability,
grant and actual outcome.

## Operator decisions and scope

Latest accepted decision: **E3 = A**, [issue 463 comment 6063194859](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-6063194859),
2026-10-08. Full production enablement since October 3 was intentional.
Stages 4a–4c retire opt-ins and normalize defaults. E3 treats the six Claude
4c enablement conditions as satisfied; they are excluded from the C0 and
C4C prerequisites.

The still-current decisions from [October 2](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-5946655166)
are host ceiling/default as separate keys, host-wide explicit exec opt-out,
4b immediately before 4c, Antigravity queue/false ceiling until separate
activation, Codex yield downgrade, and legacy environment precedence over
runner config while those flags still gate. New policy guards retain their
own tests, mutations and approved native measurements. Approval-axis
controls are outside 463. No production deployment or native run is
implicitly authorized by this plan's approval.

Server rollback after stage 2 loses the opt-out for agents freshly spawned
under the old server. The independent stop remains `enabled: false` at
next spawn. C4B does not approve exec-to-app-server resume; unknown session
origin blocks that host's migration until launch evidence is obtained.

## Dependency on issue #469

- **Stage 3 prerequisite already satisfied.** The issue #469 flag-key
  group landed in `5b78697d`; the whole issue's closure is not required.
  Until stage 4, `claude_code.phase2_delivery` and
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

## Proposed child issues

These titles and acceptance boundaries are filed as issues 558 to 567
([mapping](https://github.com/sakuraiyuta/kaoiro/issues/463#issuecomment-6066094342)); the table assigns no writers. Hisui is the decision owner for partition
and landing. Each eventual mutable artifact has one named writer; each
code child receives its own design and independent implementation review.
Stage 1 is split because the server/persistence contract and native
wrapper commit points require different checks, with one integration
boundary owned by the director.

| Proposed child | Stage / scope | Dependency | Acceptance and required evidence |
|---|---|---|---|
| C0: Refresh delivery baseline and audit remaining Codex evidence | 0, docs and artifact-bound evidence inventory | E3 and the approved design | Current-state table separates configured behavior/defaults; 346/489 closed and 469 keys shipped; Claude checklist removed; Codex evidence gaps enumerated; phase-4 tracking linked |
| C1S: Persist per-agent delivery policy and enforce server admission | 1, protocol/server/store/compose/runbook | Reviewed wire contract; 489 already satisfied | Server-authenticated operator-only write gate and direct-viewer refusal/mutation; CAS, durable revisions, missing-row backfill, unknown refusal, explicit-intent clamp, incarnation ack and old-wrapper no-ack matrix; store registration/mutation and unconditional target-path/longest-prefix-mount prepare gate over volumes/tmpfs/image-VOLUME union; both tmpfs syntaxes and image shadowing; measured `.Mounts`/`HostConfig.Tmpfs` reporting |
| C1W: Enforce live delivery policy at Claude and Codex commit points | 1, wrapper/core and engine wrappers | C1S contract pinned; supporting server path available for integration | Fence-before-ack, one outcome per item, old-server history, rejoin/revision safety; production constructor path; native off controls and ordering regression tests |
| C2: Add launch and live per-agent delivery controls | 2, dashboard and its server client API | C1S + C1W integrated | UI guard: no actionable write controls for viewers, independently tested from C1S server authorization; CAS conflict/pending/unknown states; honest old-wrapper/exec/Antigravity unsupported states; existing stored off survives hide/restart/restore |
| C3: Relay host delivery ceilings and defaults through runner config | 3, registry/runner/register/config docs | 469 flag-key group already landed; C1S register consumer | Canonical engine mapping; enabled next-spawn path; default new-row/launch seed; hot reload/re-register; existing rows untouched; Antigravity ceiling false |
| C4A: Retire Codex operator-steer opt-ins in favor of delivery policy | 4a, legacy gate retirement | C0, C1S/C1W, C2, C3 | App-server supported/on by default; explicit off and ceiling honored; exec queues; warning coverage; policy does not bypass admission or commit-time ordering rules in force at its pinned base, regardless of 548 landing order |
| C4B: Make app-server the omitted-setting Codex backend | 4b, all default-adapter sites | C0 ADR-0058 backend evidence and C4A | Full default sweep, default production composition; independent runner/entry/replay/getter/status mutations; legacy exec sessions including those created while pinned; host pin before restore and fresh inventory/nil-pointer boundary at pin removal; explicit exec fallback and consistent reported/history backend; pin evidence; land adjacent before C4C |
| C4C: Retire Claude phase-2 opt-ins in favor of delivery policy | 4c, legacy gate retirement | C1S/C1W, C2, C3; C4B immediately preceding | Supported/on by default; stored off/ceiling respected; warnings; new fence controls. No six-case first-flip checklist |
| C5: Remove deprecated in-flight environment/list readers | 5, coordinated parser/docs cleanup | C4A/C4C plus one released version with warnings; coordinate 469 | Reader/config/example sweep; only in-flight flags removed; approval-axis controls preserved; opt-out and explicit exec behavior retained |
| C4D: Measure and implement Antigravity phase-4 delivery, then activate | 4d, separate measured engine work | 541 landed; 416 and the 412 boundary; its own reviewed native evidence/implementation design | Later-turn delivery and negative controls measured before activation; until then queue/unsupported/ceiling false; later activation has its own review and operator-controlled timing |

C0/C3 can proceed with coordinated contract ownership once reviewed;
code landing order still respects the stages and mixed-version matrix.
C4D measurement may be tracked alongside those children but does not
block the Claude/Codex policy integration. Do not close the parent as
"all engines delivered" merely because those two engines are done.
Retain Antigravity's unresolved scope or obtain an explicit operator
decision to move that acceptance boundary to its own parent/follow-up.
Do not duplicate 416's turn-identity work in a new measurement issue.
