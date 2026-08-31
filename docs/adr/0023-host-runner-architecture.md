---
title: Host resident   — supervisor dedicated 1 process=1 agent・TS/Node single binary
status: accepted
date: 2026-06-24
opened: 2026-06-23
supersedes: []
superseded_by: null
related_specs: [architecture, protocol, threat-model, setup-wizards]
related_adrs: [2, 14, 18, 24, 30, 31, 32, 39]
---

# ADR-0023 — Host resident   architecture

## Status

Accepted

## Context

Current topology ([ADR 2] (0002-local-wrapper-websocket-topology.md)) is "1 AI
Agent = 1 wrapper directly to kaoiro server. This is
where to move the wrapper and how to connect (topology) only, and
Lifecycle Management**. As a result:

- When the wrapper (agent) falls, the UI does not have a reboot method just by looking at disconnected.
- There is no route to add a new agent from the UI (persons enter the host by hand).
- There is no reason to summarize "how many people are working now / how to move".

Set one resident program (Host) for each host and host between wrapper and wrapper
A lifecycle of agents.  issue
[#23](https://github.com/sakuraiyuta/kaoiro/issues )
Converged in the decision of this ADR (D1-D4).

### Current Code (Ground, 2026-06-23)

- spawn / stop / restart**Unmounted**( client client→wrapper control instruction /
permission decision / interrupt / clear history / delete agent only).
- server**Host**」**Concept **(Management is agent id unit and SessionPointers
`agent_id => {session_id, cwd}`
- **Multi-start prevention is incomplete**(owner fen  only when re-join, the same process
agent id connection overwrites with last-write-wins →   local lock,
  [ADR-0014](0014-session-resume-and-restore.md) F4)。
- **1 wrapper = 1 process**(AgentHost is a complete process private state).

## Decision

### D1 — ↔ ↔ wrapper relationship = supervisor

is a ** process lifecycle (spawn / stop / restart / monitoring) and session
Enumeration**Become a management layer. wrapper**`wrapper:<agent_id>`
Directly connect to the server, and the data path (common event) does not pass 。.  
**[ADR 2](0002-local-wrapper-websocket-topology.md)**Home
This ADR is a supervisory layer****(not supersede).

D1=B is a case where wrapper ends connection and multiplexes the wrapper group.
To become a single point of failure of the data path and to strain the agent non-dependent principle and current transport


### D2 — Process Model = 1 wrapper = 1 agent = 1 process

CI is supervised by the N wrapper wrapper spawn. 1 body
Even if it crashes, the other is safe. D2=B
Don’t get it because it requires a large refurbishment of AgentHost.

### D3 — Implementing Language / Form = TypeScript / Node, Single `kaoiro-runner`

If D1=A/D2=A, wrapper is only supervised by the Node child.
config / control envel **Share Mold**High gain. Distribution
[ADR-0018](0018- - SEAbution.md)
etc.) `kaoiro-runner` Go/R 
Avoid loss of introduction and type sharing.

### D4 — NAME =  

`runner` `supervisor`
Supervisor is not allowed to collide. `kaoirod`

### Liability of   (Specification)

- Constant connection to the server, self-**Register a host**(Presen。 of survival and operable persona)
- In the host agent with the operator instruction via server**spawn / stop / restart**
execution.
- wrapper / agent group in host****Let's show the state together.
- wrapper continues to live even when hosts and wrappers fall,**Recovery**
survival unit of [ADR-0014] (0014-session-resume-and-restore.md).
- The session JSONL of the cwd substitute when returning or summoning****and start resume.
- **Dual-start-proof local lock**physical inhibition of simultaneous resume of the same session
  [ADR-0014](0014-session-resume-and-restore.md) F4)。

### Irregular conditions (threat-model) (../specs/threat-model.md)

Remote spawn from UI is real remote code execution(issue #22).  
spawn / instructions****,resume The target session id is
The agent binding under the cwd**Validation**(T1/T2/T3、ADR-0014 F6)。

### Control message schema (#66, 2026-06-24)

[#66](https://github.com/sakuraiyuta/kaoiro/issues/66)
[protocol](../specs/protocol.md)
Messages, book ADR records decisions).

- ****:Japanese termーJapanese term `runner:<host_id>` (data path `wrapper:<agent_id>` and separate lines).
`wrapper:` `wrapper:`
rejected to complicate.
- **Type**: Same as existing control**Channels**Home envel  `type`
rejected to use the data frame to control.
- ****: Host-specific s (env `host_id:token`,
[ADR-0011](0011-phase3-reliability-and-auth.md).
host id is fixed. 1 sharedHost is rejected because all host exchanges are required when leaking
(ADR-0011).
- **version**: Add new message type to `"0"`
  ([ADR-0015](0015-protocol-version-stamping.md))。
- **Double startup**: server owner fen  +   local lock
([ADR-0014](0014-session-resume-and-restore.md) F4). spawn conflicts
`spawn_result.reason = already_running`

### TS Package Topology (for #68, 2026-06-24)

D3's wrapper and type sharing**wrapper**Body wrapper
Claude Code CLI version only, but future codex version, host state acquisition / client version
Home**Package**as an additional plan. TS consumer speaks the same protocol / envel 
For more than three implementations, each implementation starts from protocol.md**Copy**Contact Us
(wrapper / dashboard keeps each) breaks the SSOT type-level without drift linear.

Determination:

- Minimum to the repository root**pnpm workspace**Japanese termーHome and sharing packages
  **`@kaoiro/protocol`**Cut out. Internal = envel / / control message / state agent type
  - **All wrapper common spawn / CLI contract**Home This is the TS side SSOT.
- current `@kaoiro/wrapper`(= Claude version) is transferred to a shared package
Switch to reference.**Rename is added to codex version**(Now only type extraction, no behavior).
  → **2026 -10 Update**: Codex adapter adds to [ADR-0032] (code2-codex-adapter.md) F1 and rename (`@kaoiro/wrapper` → `@kaoiro/claude-code`) is [phase-13-wrapper-multipackage-restructure] (../plans/phase-13-wrapper-multipackage-restructure.md)**execution**(completed)
- wrapper (`@kaoiro/runner`) and future wrappers consume this shared package.
- **Limited to Node**Home dashboard(`dashboard/`)
In this work, set up (in the future).
- Multiple wrapper bundles to a single binary ([ADR-0018] (0018- - bution.md)
The approach is packed in the distribution phase ([#70] (https://github.com/sakuraiyuta/kaoiro/issues/70) as aJapanese termacent point. This decision is only type/package structure.

## Consequences

### Positive

- Current transport No refurbishment,   keeps it pure management layer (no bottleneck).
- Crash iso  (others are safe even if one body falls). Use existing wrapper code.
- wrapper and type (config / control envel。) can be shared and the implementation cost is low.
- ADRJapanese termーJapanese term2 does not break, so the decision of the direct connection data path remains in one place.

### Negative

- server owner fen  +   local lock**Japanese term**
- Memory per Memory process is large for 1:1 model.
- control envel)(spawn / stop / restart / enumerate-sessions)
[protocol](../specs/protocol.md)

### Neutral

-   distribution and resident form follows [ADR-0018] (0018- -distribution.md)
CLI only).
- Host non-ephemeral/agent id ↔ cwd depend on fixed premise
  ([ADR-0014](0014-session-resume-and-restore.md))。

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|D1=B: pr finishes and multiplexes connection (proxy)|A single point of failure of the data path, transport, large refurbishment, agent, non-dependent principles and tension|
|D2=B: In  multiple agents into one process|1 Great Renovation and Isolation Loss of AgentHost|
|D3=b:Japanese termxir|BEAM Overloaded host resident|
|D3=c: Implemented with Go / Rust|No code-based third-language wrapper and type-sharing (rethinkable if the first priority is indirect)|
|Name`supervisor` |OTP Supervisor|
|ADR 2 supersede|Since direct topology is maintained with D1=A, supersede refers to the rejected draft D1=B. amend|

## Related

- Added: [ADR 2](0002-local-wrapper-websocket-topology.md)
Topology maintains and adds the supervision layer in this ADR).
-Japanese term ADR: [0014] (0014-session-resume-and-restore.md)
resume / Summon, [0018] (0018- - bution.md) ( bution).
-archtures: [architecture](../specs/architecture.md)
[protocol](../specs/protocol.md)(control message),
  [threat-model](../specs/threat-model.md)。
- control schema: #66 ( above "control message schema",
[protocol](../specs/protocol.md)[eーHome control message]
- : Phase 4 ([phase-4-host-host](../plans/phase-4-host-host.md)).
- Origin: issue [#23] (https://github.com/sakuraiyuta/kaoiro/issues。).
