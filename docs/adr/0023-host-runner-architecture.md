---
title: Host-resident runner — supervisor only, 1 process = 1 agent, TypeScript/Node single binary
status: accepted
date: 2026-06-24
opened: 2026-06-23
supersedes: []
superseded_by: null
related_specs: [architecture, protocol, threat-model, setup-wizards]
related_adrs: [2, 14, 18, 24, 30, 31, 32, 39]
---

# ADR-0023 — Architecture of the Host-Resident Runner

## Status

Accepted

## Context

The current topology ([ADR-0002](0002-local-wrapper-websocket-topology.md)) is “one AI agent = one wrapper, each connecting directly to the kaoiro server over WebSocket.” It decides only where and how to run and connect wrappers (the topology), and **does not define host-level lifecycle management**. As a result:

- When a wrapper (agent) goes down, the UI only sees disconnected and has no way to restart it.
- There is no path to start a new agent from the UI (a person must log into the host manually).
- There is no entity that aggregates, at the host level, “how many are running now / can be run.”

Place one resident program (runner) on each host and make it responsible for the lifecycle of the host’s group of agents between the server and wrappers. The alternatives were compared in issue [#23](https://github.com/sakuraiyuta/kaoiro/issues/23), converging on the decisions (D1–D4) in this ADR.

### Current code reality (baseline, investigated 2026-06-23)

- spawn / stop / restart are **not implemented** (server client→wrapper control currently includes only instruction / permission_decision / interrupt / clear_history / delete_agent).
- The server has no concept of a **host** (management is per agent_id, and SessionPointers abstracts away the host with only `agent_id => {session_id, cwd}`).
- **Prevention of duplicate starts is incomplete** (owner fencing applies only on re-join; a connection with the same agent_id from another process is overwritten by last-write-wins → a runner-local lock is the actual mechanism, [ADR-0014](0014-session-resume-and-restore.md) F4).
- **1 wrapper = 1 process is deeply embedded** (AgentHost has fully process-private state).

## Decision

### D1 — Relationship between runner and wrapper = supervisor only

The runner is a management layer responsible **only for process lifecycle (spawn / stop / restart / monitoring) and session enumeration**. Wrappers continue to connect directly to the server as before through `wrapper:<agent_id>`, and the data path (common events) does not pass through the runner. In other words, **the direct topology of [ADR-0002](0002-local-wrapper-websocket-topology.md) is maintained**, and this ADR adds a supervisory layer on top of it as an **addendum** (it does not supersede it).

Do not adopt option D1=B, in which the runner terminates connections and multiplexes wrappers (proxy): the runner would become a single point of failure for the data path, creating tension with the agent-independent principle and the current transport.

### D2 — Process model = 1 wrapper = 1 agent = 1 process

The runner spawns and supervises N wrapper processes (like a CI runner). If one crashes, the others remain safe (isolation). Do not adopt option D2=B, which embeds multiple agents in one process: it loses isolation and requires a major AgentHost rewrite.

### D3 — Implementation language / form = TypeScript / Node, single binary `kaoiro-runner`

With D1=A / D2=A, the runner “only supervises Node child processes,” so sharing **types for config / control envelopes** with the wrapper is a major benefit. Distribution follows [ADR-0018](0018-runner-distribution.md), as a single OS-specific binary (bun / Node SEA, etc.). The binary is named `kaoiro-runner`. Go/Rust is also an option when robustness is the top priority, but avoid introducing a third language and losing type sharing.

### D4 — Name = runner

Adopt the provisional name `runner` as the formal name (already established throughout the documentation). `supervisor` cannot be used because it conflicts with OTP Supervisor. Do not use `kaoirod`.

### Runner responsibilities (specification)

- Maintain a persistent connection to the server and **register its own host** (present living and runnable personas as a group).
- On operator instructions through the server, execute **spawn / stop / restart** for agents on the host.
- **Aggregate** wrappers / agents on the host and present their state to the server as a group.
- Keep running when the host or a wrapper goes down and become the **starting point for recovery** (the unit of survival in [ADR-0014](0014-session-resume-and-restore.md)).
- When restoring / summoning, **enumerate** session JSONL files under the relevant cwd and start a resume.
- Use a **local lock to prevent duplicate starts** (physically prevent concurrent resume of the same session, [ADR-0014](0014-session-resume-and-restore.md) F4).

### Invariants (threat constraint, [threat-model](../specs/threat-model.md))

Remote spawn from the UI is effectively remote code execution (issue #22). Since the runner is the execution point, spawn / instructions are **operator-only**, and the session_id targeted for resume must be **verified to exist under the cwd bound to that agent** (T1/T2/T3, ADR-0014 F6).

### Control-message schema (#66, 2026-06-24 addendum)

The runner ↔ server control messages were fixed in [#66](https://github.com/sakuraiyuta/kaoiro/issues/66) (the schema itself is in [protocol](../specs/protocol.md), “runner control messages”; this ADR records the decision).

- **Topic**: dedicated `runner:<host_id>` (separate from the data path `wrapper:<agent_id>`). Do not piggyback on the existing `wrapper:` family, because that would complicate the role gate / `agents:lobby` subscription invariant (#27).
- **Format**: the same **Channels event scheme** as existing control. Do not repurpose the envelope `type` addition, which is for observed data, as control.
- **Authentication**: a per-host token (env `host_id:token`, extending the per-entity token principle of [ADR-0011](0011-phase3-reliability-and-auth.md)). host_id is fixed in configuration. Reject one shared token because a leak would require replacing it on every host (the same judgement as ADR-0011).
- **version**: keep `"0"` for forward compatibility when adding the new message type ([ADR-0015](0015-protocol-version-stamping.md)).
- **Duplicate starts**: two stages, server owner fencing + runner-local lock ([ADR-0014](0014-session-resume-and-restore.md) F4). Return a spawn conflict as `spawn_result.reason = already_running`.

### TS package topology (#68, before work started, 2026-06-24 addendum)

Make D3’s “share types with the wrapper” concrete **assuming multiple wrappers**. For now the wrapper is only the Claude Code CLI version, but a codex version and versions for host-state retrieval / client provision are planned as **separate packages**. Once there are three or more TS consumers speaking the same protocol / envelope, the current practice of copying types **manually** from protocol.md into each implementation (wrapper / dashboard each maintain their own) increases drift linearly and violates the SSOT at the type level.

Decision:

- Introduce a minimal **pnpm workspace** at the repository root and split out the shared package **`@kaoiro/protocol`**. Contents = envelope / control messages / agent state types — **the common spawn / CLI contract for every wrapper**. Make it the SSOT on the TS side.
- Move protocol-related types from the current `@kaoiro/wrapper` (= the Claude version) into the shared package and switch to references. **Defer the rename until adding the codex version** (type extraction only for now, behaviour unchanged).
  → **2026-07-10 addendum**: The Codex adapter was decided in [ADR-0032](0032-codex-adapter.md) F1, and the rename (`@kaoiro/wrapper` → `@kaoiro/claude-code`) was **carried out** in [phase-13-wrapper-multipackage-restructure](../plans/phase-13-wrapper-multipackage-restructure.md) (completed the same day).
- The runner (`@kaoiro/runner`) and future wrapper family consume this shared package.
- **Limit the scope to the Node side**. The dashboard (`dashboard/`) uses a separate build system, so leave it unchanged in this work (continue its own `protocol.ts`; alignment is a separate future task).
- Bundling multiple wrappers into a single binary ([ADR-0018](0018-runner-distribution.md)) is an adjacent issue to work through in the distribution phase ([#70](https://github.com/sakuraiyuta/kaoiro/issues/70)). This decision covers only types / package structure.

## Consequences

### Positive

- No changes to the current transport are needed, keeping the runner a pure management layer (no bottleneck).
- Crash isolation (the others survive if one goes down). Existing wrapper code can be reused.
- Types (config / control envelope) can be shared between wrapper and runner, keeping implementation cost low.
- Because ADR-0002 is not broken, the direct data-path decision remains in one place (simple records).

### Negative

- Duplicate-start prevention requires two layers: server owner fencing + runner-local lock.
- Memory per runner process is relatively large because of the 1:1 model.
- New control envelopes (spawn / stop / restart / enumerate-sessions) must be defined (#66 fixed them, in [protocol](../specs/protocol.md), “runner control messages”).

### Neutral

- Runner distribution and resident form follow [ADR-0018](0018-runner-distribution.md) (single binary, CLI only).
- Depends on the assumptions that the host is non-ephemeral and agent_id ↔ cwd is fixed ([ADR-0014](0014-session-resume-and-restore.md)).

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| D1=B: runner terminates and multiplexes connections (proxy) | Single point of failure for the data path, major transport rewrite, and tension with the agent-independent principle |
| D2=B: embed multiple agents in one process | One crash kills all, major AgentHost rewrite, and loss of isolation |
| D3=b: implement in Elixir | Bundling BEAM is heavy and excessive for a resident host service |
| D3=c: implement in Go / Rust | Third language in the codebase and no type sharing with the wrapper (reconsiderable if robustness is the top priority) |
| Name it `supervisor` | Conflicts with OTP Supervisor |
| Supersede ADR-0002 | D1=A maintains the direct topology, so superseding would be misleading in the record (it points to rejected option D1=B). An amend is accurate |

## Related

- ADR amended: [ADR-0002](0002-local-wrapper-websocket-topology.md) (maintains the direct topology and adds a supervisory layer in this ADR).
- Related ADRs: [0014](0014-session-resume-and-restore.md) (runner as the unit of survival, resume / summoning), [0018](0018-runner-distribution.md) (runner distribution).
- Related specs: [architecture](../specs/architecture.md), [protocol](../specs/protocol.md) (control messages), and [threat-model](../specs/threat-model.md).
- Control schema: fixed in #66 (the “Control-message schema” section above, [protocol](../specs/protocol.md), “runner control messages”).
- Implementation: phase 4 ([phase-4-host-runner](../plans/phase-4-host-runner.md)).
- Origin: issue [#23](https://github.com/sakuraiyuta/kaoiro/issues/23).
