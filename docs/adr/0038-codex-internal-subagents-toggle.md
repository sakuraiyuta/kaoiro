---
title: Codex internal sub-agent's   toggle and hard-knownerer-routing contract
status: accepted
date: 2026-07-15
opened: 2026-07-15
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, plugin-model]
related_adrs: [32, 33]
---

# ADR-0038 — Codex internal sub-agent's   toggle and solid nameerer-routing contract

## Status

Accepted (2026.-15, Master decision. delegation between kaoiro er,
Fuji is in charge of review.
[phase-19-codex-internal-subagents-toggle](../plans/phase-19-codex-internal-subagents-toggle.md).

## Context

A well-known and collaborative agent (Codex engine)
kaoiro er (`send_to_agent` / `list_agents`)
**inCode with Codex `collaboration.spawn_agent`
**rate sub-agents** andHomeer’s same solid name (`kuroe`)
I recurred a mistake.

The root cause is a solid-famous instruction, "to examine with ~", two different semantics
primitive:

| primitive |Home|Contact Us|
|---|---|---|
|address existingerer|kaoiro er| `list_agents` → `send_to_agent` |
|Create a new subcontractor|engine internal sub-agent (not registered)|engine specific spawn mechanism|

`list_agents` because internal sub-agent is not registered to kaoiro server
Don’t appear, and Dashboard can’t directly reflect fakes. So kaoiro is the only
authoritative registry(`list_agents`)
[protocol-inter-agent](../specs/protocol-inter-agent.md)
“Guide  for Addressing” has already been written as MUST. Recurrence is only the "prompt terms"
It is a proof that it cannot be protected.

On the other hand, the master is the in  sub-agent itself, and the
Risks showed acceptable decisions. "Default remains valid and the operator is
option can be explicitly disabled. Structure only when disabled
Soft guard(prompt / provenance)

Codes PreToolUse in Codex 0.144.1 cannot block the tool call,
kaoiro doesn't implement hard guard on the side.
side issues).

## Decision

### F1 — runner config `codex.internal_subagents`(boolean,effective default true)

`internal_subagents`(boolean)
Add. Unspecified / `true` = valid (Codex default), `false` = disabled.  effective
default. bot boolean and non boolean is
(`runner/src/config.ts`, `wrapper/core/src/persona.ts`).

### F2 — effective (= configured ?? true)`features.multi_agent`Contact Us

Codex per-run config
`config.codex.internal_subagents`(file, nested)→   relay
(`resolveWrapperConfig`, `configured ?? true` is solved by codex engine)→
WrapperConfig `codex_internal_subagents`(wire,flat)→
`wrapper/codex/src/host.ts` per-run `config`. host**Always**
`features.multi_agent` `internal_subagents`
`true` is explicitly enabled (force-enable) and `false` is disabled and not specified
explicitly inject `true` of effective default.

**precedence**: config option is SoT and user-global
`[features] multi_agent`**Top Page**
By always writing effective to per-run config, it is not based on global configuration
precedence. Structural action that actually stops in  sub-agents `false`
`true` is also explicitly injected for the establishment of precedence. Global Settings
Respecting tri-state (unspecified = delegate to global) will not be collected this time
key / contract required).

**live reload**: config**Only for the next spawn**Contact Us In operation
The wrapper process holds the value of launch and does not change immediately
`Supervisor.updateRuntimeConfig` only runstime config for future spawn
replace and kill existing child).

### F3 — soft guard: hard-known guarder-routing contract

In order to prevent mistakes even if internal sub-agent is enabled, the following three aspects are
Sync a short routing contract (soft guard):

- **common footer**(`persona_assets.ex`) — all persona (including default)
system prompt `list_agents`
1 send / multiple operator confirmation / 0 absence report), 0 same name internal
Don't generate an alternative, in  will be created by the role name when explicitly indicated, jointly before sending and receiving
Don’t report it.
- **inter-agent tool description**`list_agents` /
`send_to_agent`) — the same contract is expressed in the description that the model reads.
- **spec**(`protocol-inter-agent.md`"Guide  for Addressing")—Mechanical of the same contract


### F4 — hard guard(PreToolUse block) does not implement to kaoiro

Codes PreToolUse in Codex 0.144.1 cannot block the tool call,
kaoiro repo
Not implemented. This is a codex harness-side issue.
authoritative registry and routing contract.

### F5 — provenance backstop does not support existing mechanisms and implement new

"Who is the conversation, and who is actually sent and received?"
already meets the existing `inter_agent_message` envel :

- sender `agent_id` and `persona` envel  are stamp(`makeInterAgentMessage`)
`conversation_id` / `turn_number`
- Dashboard sends and receives by operator only observation path
([protocol-inter-agent](../specs/protocol-inter-agent.md) observation route)

`wrapper/agent-common/test/inter_agent.test.ts`: sender
agent id / persona / conversation id / turn number
The new provenance mechanism is not added, and you can use this ADR and test to “feed”
Contact Us

## Consequences

### Positive

- operator can disable codex internal sub-agent in one   option,
(`false`).
- Do not leave existing behavior because the default is set.
- soft guard(footer / description / description)
Identify the resolution path of the solid-famous instructions.
- kaoiro repo is the same route as the existing chatgpt plan.
Relay + host + close to the description layer.

### Negative

- Only soft guard is allowed.
- common footer is slightly longer to all prompts.

### Neutral

- Hard guard is the responsibility of Codex harness. Codex
block Appraisal when enabled.
- No new implementation (F )

## Alternatives Considered

| Option | Decision |
|--------|----------|
|host`false`Only when`features.multi_agent=false`Inject (true/unspecified is non-injected and delegate to Codex default)|Reject. positive boolean`true`is no-op. Constantly injecting effective for global higher ranks (Fuji Review, 2026 -15)|
|global tri-state (unspecified = delegate to global / false = invalid / true = valid)|Reject. The positive boolean precedence becomes ambiguous. global Respect requires separate key/contract (adopt)|
|materialise default=true when parse|Reject. parse maintains raw(undefined) and performs`?? true`reload chat is clean and consistent with chatgpt plan|
|PreToolUse hard guard on kaoiro side|Reject. Codex 0.144.1 Codex Harness|
|hard block|Reject. Allows the risk when the master is active. Default Disabling Existing Behavior|
|stamp/display|Reject. Delicate implementation with existing envel  + observation path|

## Implementation

[phase-19-codex-internal-subagents-toggle](../plans/phase-19-codex-internal-subagents-toggle.md).
kaoiro repo
settings repo(`dotfiles/codex` tracked source + `install.codex.sh`)
Implement with responsibility separation.
