---
title: Runner toggle for Codex internal sub-agents and the named-peer routing contract
status: accepted
date: 2026-07-15
opened: 2026-07-15
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, plugin-model]
related_adrs: [32, 33]
---

# ADR-0038 — Runner toggle for Codex internal sub-agents and the named-peer routing contract

## Status

Accepted (2026-07-15, approved by マスター. Delegated to クロエ through kaoiro
peer delegation, with 藤 as reviewer). Implementation is
[phase-19-codex-internal-subagents-toggle](../plans/phase-19-codex-internal-subagents-toggle.md).

## Context

An agent (Codex engine) asked to collaborate by a named identity again confused an
existing kaoiro peer (a separate process agent reached by `send_to_agent` /
`list_agents`) with an **internal sub-agent** created by Codex’s
`collaboration.spawn_agent`, even assigning it the same named identity as the peer
(`kuroe`).

The root cause is that a named request such as “investigate this together” can map
to two primitives with different semantics:

| primitive | entity | way to reach it |
|---|---|---|
| Address an existing peer | Registered kaoiro peer in another process | `list_agents` → `send_to_agent` |
| Create a new subordinate | Unregistered sub-agent inside the engine | Engine-specific spawn mechanism |

Internal sub-agents are not registered with the kaoiro server, so they do not
appear in `list_agents` and the dashboard cannot show them directly. Therefore,
kaoiro already has the single authoritative registry (`list_agents`), and named
identity resolution must start there, as required by the MUST in
[protocol-inter-agent](../specs/protocol-inter-agent.md) “Destination resolution
guidance”. The recurrence proves that a prompt convention alone is not enforced.

マスター has indicated that internal sub-agents themselves are useful and the
confusion risk while enabled is acceptable. Therefore, keep them enabled by
default but let the operator explicitly disable them with a runner option. Stop
them structurally only when disabled; while enabled, suppress confusion with a
soft guard (prompt / provenance).

Codex 0.144.1 hooks PreToolUse cannot block a tool call, so do not implement a hard
guard on the kaoiro side (responsibility split: a hard guard is a Codex harness
concern).

## Decision

### F1 — Runner config `codex.internal_subagents` (boolean, effective default true)

Add `internal_subagents` (boolean) to the `codex` block of `runner.config.json`.
Unspecified / `true` = enabled (Codex default); `false` = disabled. The effective
default is true. Validate strictly as boolean and make non-boolean values a loud
config error (`runner/src/config.ts`, `wrapper/core/src/persona.ts`).

### F2 — Always inject effective (= configured ?? true) into `features.multi_agent`

Reflect runner configuration in Codex per-run config through this path:
`config.codex.internal_subagents` (file, nested) → runner relay
(`resolveWrapperConfig`, resolve `configured ?? true` for the Codex engine) →
WrapperConfig `codex_internal_subagents` (wire, flat) → per-run `config` in
`wrapper/codex/src/host.ts`. The host **always** injects the effective value into
`features.multi_agent`. `internal_subagents` is a positive boolean: `true` is an
explicit enable (force-enable), `false` disables, and unspecified explicitly
injects the effective default `true`.

**Precedence**: Make the runner option the SoT and give it precedence over
user-global Codex config such as `[features] multi_agent` in
`~/.codex/config.toml`. Writing the effective value into per-run config every time
ensures that runner intent wins regardless of global configuration. The structural
effect of stopping internal sub-agents occurs only for `false`, but explicitly
inject `true` to establish precedence as well. Do not adopt a tri-state that
respects global configuration (unspecified = delegate to global); that would need
a separate key / contract.

**Live reload**: Apply config changes **only to subsequent spawns**. Keep the value
at launch time in a running wrapper process; do not change it immediately
(`Supervisor.updateRuntimeConfig` replaces only runtime config for future spawns
and does not kill existing children).

### F3 — Soft guard while enabled: named-peer routing contract

Synchronise a short routing contract in three surfaces to reduce confusion even
when internal sub-agents remain enabled (soft guard):

- **Common footer** (`persona_assets.ex`) — at the end of the system prompt for
  every persona (including default). Resolve named instructions as existing peers
  with `list_agents` (one result: send / multiple: ask the operator / zero: report
  absence); do not create a same-named internal substitute even when zero results;
  create an internal sub-agent with a role name only on explicit instruction; do
  not report collaboration as complete before actual send/receive.
- **Inter-agent tool description** (`list_agents` / `send_to_agent` in
  `inter_agent.ts`) — state the same contract in the description read by the model.
- **Spec** (“Destination resolution guidance” in `protocol-inter-agent.md`) — add
  the same contract to the mechanical specification.

### F4 — Do not implement a hard guard (PreToolUse block) on the kaoiro side

Codex 0.144.1 hooks PreToolUse cannot block tool calls, so do not implement the
structural guard that hard-rejects a reserved name before spawn in the kaoiro repo.
Separate this as a Codex harness responsibility (kaoiro remains responsible for
supplying the authoritative registry and routing contract).

### F5 — Existing provenance backstop is sufficient; add nothing new

Existing `inter_agent_message` envelopes already provide provenance for tracing
“who, in which conversation, actually sent and received”:

- The envelope stamps sender `agent_id` and `persona` (`makeInterAgentMessage`).
- `conversation_id` / `turn_number` link the dialogue in total order.
- An operator-only observation path shows both sides of send/receive in the
  dashboard ([protocol-inter-agent](../specs/protocol-inter-agent.md) observation
  path).

Existing tests (`wrapper/agent-common/test/inter_agent.test.ts`: assignment and
monotonicity of sender agent_id / persona / conversation_id / turn_number) already
prove these properties. Do not add a provenance mechanism; record only that the
existing mechanism is sufficient in this ADR and its tests.

## Consequences

### Positive

- The operator can disable Codex internal sub-agents with one runner option and
  structurally prevent confusion when it is `false`.
- Keep the default (enabled) unchanged, so existing behavior does not regress.
- The soft guard (footer / description / spec) applies uniformly to every engine
  and persona and makes named-identity resolution explicit.
- The kaoiro repo reuses the same path as the existing chatgpt_plan and confines
  changes to config relay + host + description layer.

### Negative

- While enabled, confusion risk remains with only the soft guard (accepted by
  マスター).
- The common footer becomes slightly longer for every prompt.

### Neutral

- Leave the hard guard as a Codex harness responsibility (F4); evaluate it
  separately if Codex hooks become able to block.
- Add no new provenance implementation (F5).

## Alternatives Considered

| Option | Decision |
|--------|----------|
| Inject `features.multi_agent=false` only when `false` (do not inject for true / unspecified and delegate to Codex default) | Reject. Positive boolean `true` becomes a no-op with inconsistent semantics. Always inject effective value so runner outranks global configuration (藤 review, 2026-07-15). |
| Respect global config with a tri-state (unspecified = global / false = disabled / true = enabled) | Reject. Precedence of the positive boolean becomes ambiguous. If global respect is needed, use a separate key / contract (not adopted here). |
| Materialise default=true during parsing | Reject. Keep raw undefined during parsing; resolve effective value with `?? true` in the relay, which gives clean reload diffs and consistency with chatgpt_plan. |
| Add a PreToolUse hard guard on the kaoiro side (block by reserved-name check) | Reject. Codex 0.144.1 hooks cannot block; responsibility belongs to the Codex harness. |
| Always hard-block named instructions from becoming internal | Reject. マスター accepts the risk while enabled; disabling by default would regress existing behavior. |
| Add new provenance stamping/display | Reject. Existing envelope + observation path is sufficient and a duplicate implementation is unnecessary. |

## Implementation

[phase-19-codex-internal-subagents-toggle](../plans/phase-19-codex-internal-subagents-toggle.md).
Separate responsibilities between the kaoiro repo (runner config relay + host
features + routing contract + tests) and the settings repo (`dotfiles/codex`
tracked source + `install.codex.sh`).
