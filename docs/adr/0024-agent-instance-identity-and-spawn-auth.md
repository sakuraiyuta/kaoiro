---
title: Agent instance identity and spawn authentication — persona = type / agent id = instance, the relevant entry issuance authentication
status: accepted
date: 2026-06-24
opened: 2026-06-24
supersedes: []
superseded_by: null
related_specs: [protocol, threat-model, architecture]
related_adrs: [3, 11, 14, 18, 23, 29, 30]
---

# ADR-0024 — Agent instance identity and spawn authentication

## Status

Accepted

## Context

"I want to spawn multiple agents of the same nature" (e.g. two workers of the same persona)
If you try to meet the demand, the current authentication model becomes a wall.  issue
[#22](https://github.com/sakuraiyuta/kaoiro/issues/22)
The arguments were manifested in the discussion (2026-06-24) of (the scope of completion by spawn request).

### Current model

- **agent id is a stable identifier for one instance**Note Face, mood, session pointer
restore unit ([ADR-0003](0003-persona-identity-persistence.md)),
  **Same restart**[ADR-0014](0014-session-resume-and-restore.md)
  [protocol](../specs/protocol.md)).
- Double connection of the same agent id is collapsed in one state layer (last-write-wins +)
owner fen., `agent_states.ex`). ** Using the same agent id for two bodies
Identification and not possible**.
- wrapper authentication**agent id another pre-registration **(`:wrapper_tokens` =
`agent_id:token`, 1:1 , [ADR-0011](0011-phase3-reliability-and-auth.md)
D3). Token registration is required for each new agent.
- Results,**"How to connect unregistered agent id's wrapper with the qualification"**That's
The only failure of multiple instances. dashboard from spawn(#22)
The gap that can not return the wrapper  by the agent is the same.

### Design axis

The root of the confusion was the agent id to have two functions: type and instance. kaoiro is
spawn**real remote code execution**First priority on security (2026-06-24)
User decision). In this case, we will not get a draft to weaken separation.

## Decision

### D1 — concept: persona = type / agent id = instance

agent id
Position the unique ID of the instance. "Spawn" = same persona ×
Unique agent id**. spawn payload
register is already established on the data model, which has both Remaining failure is only authenticated.

### D2 — spawn spa path to Shot

**Unify all spawns via   launch**"  = resident daemon" assumes
like `kaoiro-runner spawn --persona … --cwd …`**One Shot**
[ADR-0018](0018-runner-distribution.md)
Single binary distribution and matching).

This converges into one trust:

- **per-host   Token**(`:runner_tokens`, [ADR-0023](0023-host-runner-architecture.md))
Host a host.
- For spawn via authenticated  , **server will issue per-agentInformationdentials
Inject**(D4).
- **pre-registration of per-agent s is not required for spawn routes**permission

### D3 — agent id`<scope>.<rand>`Stabilizing, once generated, restart

`"<scope>.<rand>"` `"<scope>.<rand>"`
unique suffix). `.`

- Number**server/ server "only once when instantiate"**.
-  **Supervised Restart**For
Conform with the "Identification in Reboot" requirements of ADR-0014 (not separating with crash reconnection).

### D4 — server injects server url + per-agent server to spawn payload

current relay only removes client payload (`agents_channel.ex`)
`handle_in("spawn")`. extend this and **CO is `server_url`
Inject per-agentthe relevant entry into spawn payload and then relay to the relevant entry.

- The per-agentthe relevant entry remains within the Note and does not retain the operator/client.
- This**#22 determining 1 = determining the completion of the program**

### D5 — Disable double join

The current cy  last-write-wins, and the agent id join with the already live owner is
Change to Denial**. A random suffix(D3) is actually zero, but even double
Visualize with explicit errors without overwriting the startup as invisible.

### Shelf raised / rejected alternatives

- **Wildcard wrapper **(`host-1.*:token` etc.):  -less
In case of “all agents in scope” (`*.*`) from “1 agent”
Expand to all wrappers (equivalent to wrappers) and contrary to the security priority policy.****.
-less As a consideration item when direct connection demand is noticeable
[#71](https://github.com/sakuraiyuta/kaoiro/issues/71)
- **hand shake**`POST /agent/allocate`
connection): separation is important, but the mechanism is to realize the same in
Duplicate. Notes to #71 as a reference for Note-less.
- **Same agent id**Identification (ADR 3). rejected.

## Undetermined subst tion (defined at implementation)

- **per-agentLifetime issuance approach and lifetime**: Signed short-lived  (at stateless due date)
Is it possible to revoke stateful or explicit stateful?
supervised restart reboots the child without returning back to the  , soken will restart
must be enabled (e.g. re-acquired via control channel)
Reissue mechanism). Book ADR**server is issued and delivered by  **"Determine the way
and the mechanism details are packed with #22 reroutes in phase-4.

## D4 supplement — per-agent id revoke path (2026-23-23, #72) (https://github.com/sakuraiyuta/kaoiro/issues/72)) [72](https://github.com/sakuraiyuta/kaoiro/issues/72)

`Phoenix.Token` signing approach with D4 is secret key base in stateless
Rotation was the only revoke means (full b  revoke weight)
option). Want to revoke individual agent id ── Especially after   release
Sign Required ── Therefore, **signed approach is unchanged additive
Add as extension**.

- **`KaoiroServer.TokenDenylist`**(New DETS store store):
`agent_id => {revoked_at_iso, ...}`CO1
the signature check**Note**`revoked?/2`
`{:error, :unauthorized}` dev mode
denylist is
not override.
- **`:dets.sync/1` fsync-gated**: operator
revoke ack and `agent_deleted` / `revoked` broadcast after permanent confirmation
ignition — revocation even if crash falls between revoke and disk
Fuji #72 M2 review advisory `ClearWatermarks`
Note #106 M7-a must-fix, 2026);-23);
`PermissionModes` remains lazythe relevant entry (operator)
fsync (equivalent to semantics)
- **store corruption**(Note #72 M2 must-fix,
2026 -23): Init if DETS open error or malformedthe relevant entry- isthe relevant entry
`{:stop, ...}` removes the original file and does not delete it.
The operator intentionally restarts rename + and starts with empty denylist.
- **`delete_agent` auto-revoke path**(Note #72 M3 must-fix):
`agents_channel.purge_agent_records/1`
  `revoke + fsync → wrapper:<id> revoked broadcast → live cut-off →
  store purge` Linearization.revoke First crash But
`AgentStates.delete`
rejoin live channel
instant cut.
- **revoke**`revoke_wrapper_token`
operator-only handler. live / disconnected
compromise) live channel is `wrapper:<id>` topic on
`revoked` intercept and `handle_out`
`{:stop, :shutdown, socket}` (not event with other events in the same topic)
reason field: `operator_revoke` / `agent_deleted`).
- **particle size is agent id unit**── ADR-0024 D3 `<host>.<rand>` 12 char
random suffixClash you to ignore the id and future spawn id crashes in the
"revoke = permanent" semantics. `TokenDenylist.restore/2`
`delete_agent`
ed.

`Auth.mint_wrapper_token/1` docstring also express 2 revoke channel,
The gap table of `docs/specs/auth-and-authz.md` has also been updated to "implemented".

## Consequences

### Positive

- One authentication path (per-host    + server issue per-agent )
and**Pre-registration of per-agent s is removed**
- separation (per-agent does not leak / does not create a scope sharing secret).
- **Revoked multiple instances of persona**(spawn).
- Single binary one-shot distribution ([ADR-0018](0018-runner-distribution.md) / #70) and
permission Because it is unnecessary to resident, it is also according to the demand "Do not want to put daemon".
- Fix #22 gap/url url supply gap with D4 (determined 1 = draft A).

### Negative

- Host binary + per-hostHost is required for the host you want to spawn
Unnecessary・One shot available. friction is less than per-agent registration).
- The `node wrapper` direct connection of the element disappears with first-class (conven  `agent_id:token`)
Manual operation is still possible.  -less #71
- Load to implement per-agentthe relevant entry issuance mechanism in server (life/reissue is the following dependent).
- Double live denied to join route (D. has increased).

### Neutral

- CO distribution and resident form follows [ADR-0018](0018-runner-distribution.md).
- Manual Directly connected existing spa operation (ADR-0011 D3) is installed (this ADR is spawn route)
Issued authentication**More**do not supersede D3).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|wildcard wrapper `<scope>.*:token`) |The leak damage spreads to the entire scope and is against the security priority policy. Raised to #71 as a consideration item at the time of demand|
|hand shake`POST /agent/allocate`) |The   route (D2) is the same and the mechanism is duplicated.  -less Note to #71 as a full-fledged reference|
|Same agent id|Iden  collision (ADR 3, face / mood / session / history)|
|generate per-agent  locally|server does not control allocation, and revoke/exa  is weak. Issuance on the server side|
|Random rethe relevant entrying agent id for each startup|restore(ADR-0014) The number is generated once|

## Related

- Compensation: [ADR-0011](0011-phase3-reliability-and-auth.md) D3(per-agent id)
Pre-registration  with  **Type**Added authentication route. supersede).
-CO ADR: [0003](0003-persona-identity-persistence.md)
[0014](0014-session-resume-and-restore.md) (restart stability / F4 local lock),
[0018](0018-runner-distribution.md)
[0023](0023-host-runner-architecture.md) (CO architecture / host ).
- server servers: [protocol](../specs/protocol.md)
control message), [threat-model](../specs/threat-model.md) (spawn = RCE plane,
operator only), [architecture](../specs/architecture.md).
- Shelf raised / Reference: [#71](https://github.com/sakuraiyuta/kaoiro/issues/71)
(Wild Card Token /.).
- Implement: #22 re-route of Phase 4 ([phase-4-host-runner](../plans/phase-4-host-runner.md)).
- Origin: issue [#22](https://github.com/sakuraiyuta/kaoiro/issues/22) Decision 1 (2026-06-24).
