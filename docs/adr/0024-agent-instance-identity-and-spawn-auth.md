---
title: Agent instance identity and spawn authentication — persona = type / agent_id = instance, runner-unified issuance-based authentication
status: accepted
date: 2026-06-24
opened: 2026-06-24
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model, architecture]
related_adrs: [3, 11, 14, 18, 23, 29, 30]
---

# ADR-0024 — Agent Instance Identity and Spawn Authentication

## Status

Accepted

## Context

Trying to satisfy the demand to “spawn multiple agents with the same characteristics” (for example, run two workers of the same persona in parallel) runs into the current authentication model. The issue surfaced in the 2026-06-24 discussion of decision 1 in issue [#22](https://github.com/sakuraiyuta/kaoiro/issues/22) (the scope of what the server completes in a spawn request).

### Reality of the current model (baseline)

- **agent_id is the stable identifier of one instance**. It is the unit of face, mood, session pointer, and restore ([ADR-0003](0003-persona-identity-persistence.md)), and **must remain the same across restarts** ([ADR-0014](0014-session-resume-and-restore.md), [protocol](../specs/protocol.md)).
- Two connections with the same agent_id collapse into one slot in the state layer (last-write-wins + owner fencing, `agent_states.ex`). **Using the same agent_id for two instances is an identity collision and is not allowed**.
- Wrapper authentication uses **pre-registered tokens per agent_id** (`:wrapper_tokens` = a 1:1 map of `agent_id:token`, D3 of [ADR-0011](0011-phase3-reliability-and-auth.md)). A token must be registered in server configuration every time a new agent is added.
- As a result, **“what credential should connect a wrapper for an unregistered agent_id?” is undefined**, and this is the sole obstacle to multiple instantiation. The same root cause creates the gap that an operator from a dashboard spawn (#22) cannot know the wrapper token for each agent.

### Design axis

The root of the confusion was making agent_id carry two roles: “type” and “instance.” kaoiro treats spawn as **effectively remote code execution** and prioritises security (user decision, 2026-06-24). Under this premise, do not adopt proposals that weaken separation (localising damage when a secret leaks).

## Decision

### D1 — Concept: persona = type / agent_id = instance

Position persona as the agent’s “characteristics / type” (id, display name, sprite), and agent_id as the unique ID of a running instance. **“Spawn multiple agents with the same characteristics” = one persona × separate unique agent_ids**. persona and agent_id are separate axes (both are already separate in the spawn payload and register), and this already works in the data model. Only authentication remains as an obstacle.

### D2 — Unify the spawn authentication path through the runner (resident or one-shot)

**Unify every spawn through runner startup**. Drop the premise that “runner = resident daemon,” and recognise **non-resident, one-shot** startup such as `kaoiro-runner spawn --persona … --cwd …` as another form of the runner (consistent with the single-binary distribution in [ADR-0018](0018-runner-distribution.md)).

This brings the trust root down to one path:

- Authenticate the host with a **per-host runner token** (`:runner_tokens`, [ADR-0023](0023-host-runner-architecture.md)).
- For a spawn through an authenticated runner, **the server issues and injects per-agent credentials** (D4).
- **Pre-registration of per-agent tokens is no longer needed on the spawn path**.

### D3 — Allocate agent_id as `<scope>.<rand>`, once at creation and stable across restart

Use the form `"<scope>.<rand>"` for agent_id (scope = host/group namespace, rand = unique suffix). The current character set `[A-Za-z0-9._-]` already permits `.`, so no change is needed.

- Allocate it **on the server/runner side exactly once, when the instance is created**.
- The runner **retains the same agent_id across a supervised restart**, satisfying ADR-0014’s requirement that it be “the same after restart” (a crash reconnect does not turn it into a different agent).

### D4 — The server injects server_url + per-agent token into the spawn payload

The current relay only passes through the client payload (`agents_channel.ex` `handle_in("spawn")`). Extend it so that **the server injects `server_url` (its own endpoint) and a per-agent token into the spawn payload before relaying it to the runner**.

- The secret value (the per-agent token) remains inside the server; the operator/client does not retain it.
- This **confirms #22 decision 1 = option A (server completion)**.

### D5 — Explicitly reject a duplicate live join

Change the current silent last-write-wins behaviour to **“reject a join for an agent_id that already has a live owner”** (defensive). A collision is practically zero with the random suffix (D3), but do not silently overwrite an accidental duplicate start; make it visible with an explicit error.

### Deferred / rejected alternatives

- **Wildcard wrapper tokens** (such as `host-1.*:token`): this would rescue runner-less direct connections with minimal changes, but a leak would expand the damage from “one agent” to “every agent in the scope” (`*.*` would amount to impersonating every wrapper), contrary to the security-first policy. **Not adopted this time**. Deferred to [#71](https://github.com/sakuraiyuta/kaoiro/issues/71) for when demand for runner-less direct connections becomes explicit.
- **Allocate handshake** (the wrapper obtains an id + short-lived token with `POST /agent/allocate` before connecting): separation is strongest, but the runner path (D2) already implements the equivalent internally, so the mechanism would be duplicated. Note it in #71 as a reference proposal for a serious runner-less approach.
- **Sharing the same agent_id**: an identity collision (ADR-0003). Rejected.

## Dependent points to be decided at implementation time

- **Issuance method and lifetime of the per-agent token**: a signed short-lived token (stateless, naturally expires) or a server-held registry (stateful, explicit revoke possible). Because a runner’s supervised restart restarts the child without returning to the server, the token must remain valid across restart (by setting its lifetime, or by a reissuance mechanism such as the runner reacquiring it through the control channel). This ADR decides only that **the server issues and the runner delivers** it; the mechanism details will be worked through in phase 4’s #22 rewiring.

## D4 addendum — per-agent_id revoke path (2026-07-23, [#72](https://github.com/sakuraiyuta/kaoiro/issues/72))

The `Phoenix.Token` signing method adopted by D4 is stateless, making secret_key_base rotation the only revoke method (a heavyweight option that invalidates the entire fleet). To revoke an individual agent_id—**needed especially for compromise response after the OSS release**—add the following as an **additive extension with the signing method unchanged**.

- **`KaoiroServer.TokenDenylist`** (new persistent DETS store): retain `agent_id => {revoked_at_iso, ...}`. `Auth.authorize_wrapper/2` checks `revoked?/2` **before** its existing signature check, and returns `{:error, :unauthorized}` for a listed agent_id. Keep the denylist active even in dev mode (`KAOIRO_WRAPPER_TOKENS` unset = anyone passes); do not let security operations be overwritten by dev convenience.
- **Writes are synchronous + `:dets.sync/1` fsync-gated**: the operator’s revoke ack and the `agent_deleted` / `revoked` broadcasts fire only after persistence is confirmed. Even if a crash occurs between revocation and the disk write, the revocation is not lost (ふじ #72 M2 review advisory). `ClearWatermarks` has already adopted the same synchronous+fsync policy (ふじ #106 M7-a must-fix, 2026-07-23); `PermissionModes` currently remains lazy sync (a record of operator preference, where returning “not reflected” after a crash before fsync is semantically equivalent).
- **Fail closed on store corruption** (ふじ #72 M2 must-fix, 2026-07-23): if a DETS open error or malformed row is detected, stop init with `{:stop, ...}` and retain the original file for forensics without deleting it. The operator intentionally renames it and restarts to begin with an empty denylist.
- **Auto-revoke in the `delete_agent` path** (ふじ #72 M3 must-fix): `agents_channel.purge_agent_records/1` linearises the sequence `revoke + fsync → wrapper:<id> revoked broadcast → live cut-off →
  store purge`. Because revoke is first, an intermediate crash cannot invert “the token is valid but the directory has disappeared,” and a live channel that rejoins in the gap between `AgentStates.delete` and revoke is immediately disconnected by the broadcast.
- **Explicit operator revoke**: an operator-only `revoke_wrapper_token` handler in `agents_channel`, covering both live / disconnected agents (for immediately cutting off an ongoing compromise). A live channel intercepts the `revoked` broadcast on the `wrapper:<id>` topic and uses `handle_out` to return `{:stop, :shutdown, socket}` (distinguish it from other events on the topic with the reason field: `operator_revoke` / `agent_deleted`).
- **Granularity is per agent_id**—the 12-character random suffix `<host>.<rand>` from ADR-0024 D3 makes collisions between a purged id and a future spawn negligible, allowing operation with the semantics “revoke = permanent.” Use `TokenDenylist.restore/2` only from an explicit UI (not implemented), and exclude it from the purge in `delete_agent`.

The docstring of `Auth.mint_wrapper_token/1` also specifies the two revoke channels, and the gap table in `docs/specs/auth-and-authz.md` was updated to “implemented” by this addendum.

## Consequences

### Positive

- The authentication path converges to one route (per-host runner token + server-issued per-agent token), and **pre-registration of per-agent tokens is eliminated**.
- Separation is strongest (per-agent secrets do not leak / no scope-shared secret is created).
- **Multiple instantiation of a persona is unlocked** (multiple agents with the same characteristics can be spawned).
- Consistent with single-binary, one-shot distribution ([ADR-0018](0018-runner-distribution.md) / #70). Because residency is not required, it also serves the demand to “not want to install a daemon.”
- Resolves the #22 token/server_url supply gap with D4 (decision 1 = option A confirmed).

### Negative

- A host that wants to spawn needs the runner binary + a per-host token (but residency is not required and one-shot use is possible; less friction than per-agent registration).
- Direct connection via plain `node wrapper` is no longer first-class (manual operation with the previous fixed `agent_id:token` remains possible; serious runner-less support is #71).
- Implementation load for the server’s per-agent token issuance mechanism (lifetime/reissuance are the dependent points above).
- A branch for duplicate-live rejection (D5) is added to the join path.

### Neutral

- Runner distribution and resident form follow [ADR-0018](0018-runner-distribution.md).
- Existing manually direct-connected token operation (ADR-0011 D3) remains unchanged (this ADR **adds** issuance-based authentication to the spawn path; it does not supersede D3).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Wildcard wrapper token (`<scope>.*:token`) | A leak expands the damage to the entire scope, contrary to the security-first policy. Deferred to #71 as an item to consider when demand becomes explicit |
| Allocate handshake (`POST /agent/allocate`) | The runner path (D2) already contains the equivalent, duplicating the mechanism. Note in #71 as a reference for serious runner-less support |
| Sharing the same agent_id | Identity collision (ADR-0003, mixing face/mood/session/history) |
| Generate the per-agent token locally in the runner | The server cannot control allocation and revoke/audit becomes weaker. Issuance belongs on the server |
| Randomly allocate a new agent_id on every start | Makes it a different agent after restart and breaks restore (ADR-0014). Allocate once at creation |

## Related

- ADR amended: [ADR-0011](0011-phase3-reliability-and-auth.md) D3 (add a runner-mediated **issuance-based** authentication path to the pre-registered per-agent_id token; not a supersede).
- Related ADRs: [0003](0003-persona-identity-persistence.md) (persona / agent_id identity), [0014](0014-session-resume-and-restore.md) (restart stability / F4 local lock), [0018](0018-runner-distribution.md) (distribution, single binary, one-shot), and [0023](0023-host-runner-architecture.md) (runner architecture / host token).
- Related specs: [protocol](../specs/protocol.md) (server injection into the spawn payload / control messages), [threat-model](../specs/threat-model.md) (spawn = RCE surface, operator-only), and [architecture](../specs/architecture.md).
- Deferred / reference: [#71](https://github.com/sakuraiyuta/kaoiro/issues/71) (wildcard token / allocate).
- Implementation: phase 4 ([phase-4-host-runner](../plans/phase-4-host-runner.md)) #22 rewiring.
- Origin: the discussion of decision 1 in issue [#22](https://github.com/sakuraiyuta/kaoiro/issues/22) (2026-06-24).
