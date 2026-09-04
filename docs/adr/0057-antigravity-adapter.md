---
title: Add a Google Antigravity adapter as the third engine, driving the agy CLI headless with a hook-based permission gate
status: proposed
date: 2026-09-04
opened: 2026-09-04
supersedes: []
superseded_by: null
related_specs: [antigravity-cli-events, plugin-model, protocol, codex-sdk-events]
related_adrs: [17, 23, 32, 33, 34, 35, 39]
---

# ADR-0057 — Add a Google Antigravity adapter as the third engine, driving the agy CLI headless with a hook-based permission gate

## Status

Proposed (issue #181). Implementation is
[phase-34-antigravity-adapter](../plans/phase-34-antigravity-adapter.md).
Q1 below is a HITL measurement that selects between two permission
substrates; everything else is decided.

## Context

Issue #181 asks for Google Antigravity as a third kaoiro engine next to
`claude-code` and `codex`, premised on the Antigravity SDK. Investigation on
2026-09-04 ([antigravity-cli-events](../specs/antigravity-cli-events.md))
established:

- The SDK is Python-only; there is no Node/TS SDK. Hosting it would need a
  Python child process and a bespoke event bridge, against
  [ADR-0023](0023-host-runner-architecture.md) D3.
- The CLI `agy` (1.1.8) has a headless print mode with a single NDJSON event
  stream (`init` / `step_update` / `result`), conversation resume by id,
  per-directory customization discovery (`--add-dir`), and lifecycle hooks
  whose PreToolUse decision can allow or deny any tool call.
- Headless `agy` auto-denies every tool that would need a prompt; hooks
  cannot lift that denial, but with prompts disabled
  (`toolPermission: always-proceed` measured; `--dangerously-skip-permissions`
  expected) the hook becomes the sole gate — which gives kaoiro a **real
  approval round trip**, something the Codex adapter never had
  ([ADR-0033](0033-permission-model-dual-axis.md) Context).
- MCP servers are not mounted in headless mode (measured three ways), so the
  Codex MCP bridge pattern ([ADR-0032](0032-codex-adapter.md) F5) cannot be
  reused as-is.

Correspondence to the two existing engines:

| Concept | Claude Agent SDK | Codex SDK | Antigravity CLI (this ADR) |
|---|---|---|---|
| Main API | `query()` resident | `codex exec` per turn | `agy --print` per turn, stream-json |
| Resume | `resume: sessionId` | `exec resume <id>` | `--conversation <id>` |
| Approval to caller | `canUseTool` | none (fixed at spawn) | PreToolUse hook → wrapper socket |
| System prompt | `systemPrompt.append` | `developer_instructions` | `.agents/rules/AGENTS.md` via `--add-dir` |
| kaoiro tools | in-process MCP | MCP bridge (stdio) | CLI bridge via `run_command` |
| Model | `claude-*` | account default / curated | `agy models` slugs, `--model` |
| Auth | env / subscription | env / ChatGPT login | OAuth in `~/.gemini`, env inherited |
| Usage / limits | SDK events | none | `-p /usage --output-format json` (quota-free) |

## Decision

### F1 — Engine id and package

Engine id `antigravity` (capabilities value, `SpawnMessage.engine`,
`ext.engine`, `EngineKind`). New package `wrapper/antigravity`
(`@kaoiro/antigravity`) built on `@kaoiro/wrapper-core` +
`@kaoiro/agent-common`, copying the `wrapper/codex` skeleton
(`cli.ts` composition root, `host.ts` EngineAdapter, `adapter.ts` pure event
translation, `catalog.ts`, `toolhost.ts`, `bridge.ts`, `history.ts`). The
wiring checklist is ADR-0032 F1/F4a applied a third time
(protocol union, runner `ENGINE_PACKAGES` / `BUNDLED_ENGINES` /
`P0_FIELDS_BY_ENGINE` / sessions / setup wizard, server `@engine_values` /
`wrapper_channel` engine guard, release manifest and verifier sentinels,
`wrapper/package.json` fan-out, `pnpm-workspace.yaml`).

### F2 — Process model: spawn `agy` per turn, closed stdin, SIGTERM to interrupt

Each turn spawns `agy --print <text> --output-format stream-json
--print-timeout 24h [--conversation <id>] [--model] [--effort] --add-dir
<agent dir>` with stdin closed. `interrupt()` terminates the child; the next
turn resumes by id. The resident `--input-format stream-json` mode is
recorded but not adopted: it offers no in-band interrupt or control channel,
so it saves only process start-up, at the cost of a second lifecycle.

### F3 — Persona injection through an always-on rules file in a per-agent customization dir

The wrapper owns a per-agent directory (`mkdtemp`, 0700, deleted on close)
passed with `--add-dir`, containing `.agents/rules/AGENTS.md` = kaoiro
preamble (working directory, bridge contract) + server-pushed personality +
footer. Persona packs stay engine-independent (ADR-0032 F3). Rewritten on
startup and on display-name sync.

### F4 — Permission: prompts disabled at the CLI, wrapper hook gate decides

`.agents/hooks.json` in the same dir registers one PreToolUse handler
(matcher `*`, long timeout) that runs `node <pkg>/dist/hook.js`. The hook
forwards `toolCall` to the wrapper's unix socket and prints the decision.
The wrapper applies the [ADR-0033](0033-permission-model-dual-axis.md) axes
itself, so both axes are **mid-session mutable** for this engine
(`setPermissionMode` succeeds, unlike Codex):

| sandbox \ approval | `never` | `on-request` | `untrusted` |
|---|---|---|---|
| `read-only` | reads allowed; writes / shell / browser / subagents denied | same as never | same as never |
| `workspace-write` | reads and in-cwd writes allowed; shell allowed; out-of-cwd writes denied | shell and browser ask the operator; in-cwd writes allowed | every non-read tool asks |
| `danger-full-access` | everything allowed | shell, browser and out-of-cwd writes ask | every non-read tool asks |

Read-class = `view_file`, `list_dir`, `grep_search`, `find_by_name`,
`read_url_content`, `command_status`, `list_permissions`, `list_resources`,
`read_resource`, `wait*`, `finish`, `manage_task`; the bridge invocation is
always allowed. Operator decisions reuse `PermissionBroker`
(`waiting_permission`, `ext.pending_permission`). The gate fails closed:
socket error, wrapper deadline, or malformed payload → `deny` with a reason
the model can read.

Default launch axes: `workspace-write` × `on-request` (same defaults as
Codex in LaunchDialog).

### F5 — kaoiro tools through a CLI bridge, not MCP

`ToolHost` (Codex, unix socket NDJSON) is reused verbatim; `dist/bridge.js`
becomes a CLI (`list` / `call <tool> <json>`). `inter_agent` descriptors and
`ask_user_question` are served exactly as on Codex; a pending question blocks
the bridge process, which holds the turn (`waiting_input`). The rules file
and a skill teach the invocation form. Switch back to MCP if a later `agy`
mounts MCP servers headless.

### F6 — Catalog: `agy models` at runner register, static snapshot fallback

The runner runs `agy models` (quota-free) when `antigravity` is in
capabilities and publishes the slugs as the engine catalog; on failure it
publishes the 1.1.8 snapshot and warns. Effort is hidden in Stage A (the
gemini slugs encode the tier); `ext.model_source` follows the phase-15
precedence with env `KAOIRO_ANTIGRAVITY_DEFAULT_MODEL`. No live-probe entry
in `LIVE_PROBE_ENGINES` (fail-loud `unsupported_engine` as for Codex).

### F7 — Session capabilities in Stage A

`supports_attachments: false`, `supports_model_switch: true` (per-turn
spawn, like Codex), `supports_context_usage: false`, `rate_limits`
supported via `-p /usage` mapped to the `seven_day` window
(`utilization = 1 - remaining_fraction`, group chosen by the active model's
vendor). Session enumeration reads
`~/.gemini/antigravity-cli/conversations/*.db`; history replay is Stage B.

## Open questions

- **Q1 (HITL, blocks Stage A merge)** — Confirm on the host that
  `agy --print … --dangerously-skip-permissions --add-dir <dir with the gate
  hook>` reports `init.permission_mode = "always-proceed"` and that the hook
  `deny` still blocks. If yes: the flag is per process and F4 needs no host
  setting. If no: the setup wizard writes `toolPermission: "always-proceed"`
  into `~/.gemini/antigravity-cli/settings.json` (host-wide, affects the
  operator's own `agy` sessions) and documents it in deployment.md.
- **Q2 (Stage A measurement)** — `--add-dir` workspace-root semantics: in
  one probe the model chose the added dir as `Cwd`. Verify with a trusted git
  repository as cwd; otherwise pin `Cwd` via the rules text and reject
  out-of-cwd `Cwd` in the gate.
- **Q3 (Stage A measurement)** — hook `timeout` upper bound and CLI
  behaviour on hook timeout; env inheritance from the `agy` process into
  `run_command` (bridge socket path).
- **Q4 (Stage B)** — transcript format for history replay; conversation db
  schema for enumeration metadata; per-model context window table for
  `supports_context_usage`.

## Consequences

- Third engine with better approval fidelity than Codex and no new language
  in the codebase.
- The wrapper writes files into a temp dir and relies on CLI customization
  discovery; both are vendor surfaces that can change without notice, so the
  spec is pinned to 1.1.8 and the runner reports the `agy` version.
- Tool calls cost one extra `node` process each (hook) plus one per bridge
  call; acceptable at kaoiro's turn rate.

## Alternatives considered

| Alternative | Reason for rejection |
|---|---|
| Python SDK hosted as a child process with a custom event bridge | Second language and a bespoke protocol; the CLI already provides an event stream and resume |
| Python wrapper speaking the kaoiro protocol directly | Violates ADR-0023 type sharing; duplicates the whole agent-common layer |
| Resident `--input-format stream-json` process | No interrupt / control channel; would still need kill-and-resume |
| `settings.json` `permissions.allow` rules per command | Host-wide, static, exact-match only; no operator round trip |
| Custom agent (`--agent`) for persona | Unknown whether it replaces default scaffolding; rules file is sufficient and measured |
