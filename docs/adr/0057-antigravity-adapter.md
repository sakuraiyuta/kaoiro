---
title: Add a Google Antigravity adapter as the third engine, driving the agy CLI headless with a hook-based permission gate
status: proposed
date: 2026-09-04
opened: 2026-09-04
supersedes: []
superseded_by: null
related_specs: [antigravity-cli-events, plugin-model, protocol, codex-sdk-events, threat-model]
related_adrs: [14, 17, 23, 32, 33, 34, 35, 36, 39]
---

# ADR-0057 — Add a Google Antigravity adapter as the third engine, driving the agy CLI headless with a hook-based permission gate

## Status

Proposed (issue #181). Implementation is
[phase-34-antigravity-adapter](../plans/phase-34-antigravity-adapter.md).
Revised 2026-09-04 after design review (kuroe): version pin corrected to
1.1.26, gate self-verification (F4b), bridge argv validation (F5), advisory
sandbox and `network_access` (F4), tool-class source of truth (F4), and
axes fixed at spawn in Stage A (F4c). Q1–Q3 are closed by measurement.

## Context

Issue #181 asks for Google Antigravity as a third kaoiro engine next to
`claude-code` and `codex`, premised on the Antigravity SDK. Investigation on
2026-09-04 ([antigravity-cli-events](../specs/antigravity-cli-events.md))
established:

- The SDK is Python-only; there is no Node/TS SDK. Hosting it would need a
  Python child process and a bespoke event bridge, against
  [ADR-0023](0023-host-runner-architecture.md) D3.
- The CLI `agy` (1.1.26, self-updating) has a headless print mode with a
  single NDJSON event stream (`init` / `step_update` / `result`),
  conversation resume by id, per-directory customization discovery
  (`--add-dir`), and lifecycle hooks whose PreToolUse decision can allow or
  deny any tool call.
- Headless `agy` auto-denies every tool that would need a prompt; hooks
  cannot lift that denial, but with prompts disabled
  (`--dangerously-skip-permissions`, measured per process) the hook becomes the sole gate — which gives kaoiro a **real
  approval round trip**, something the Codex adapter never had
  ([ADR-0033](0033-permission-model-dual-axis.md) Context). A hook that
  blocked 100 s was honoured, and a 70 s tool call held the turn.
- MCP servers are not mounted in headless mode (measured three ways), so the
  Codex MCP bridge pattern ([ADR-0032](0032-codex-adapter.md) F5) cannot be
  reused as-is.
- `--sandbox` had no observable effect (writes outside cwd and network both
  succeeded), so there is no OS-level sandbox to lean on.

Correspondence to the two existing engines:

| Concept | Claude Agent SDK | Codex SDK | Antigravity CLI (this ADR) |
|---|---|---|---|
| Main API | `query()` resident | `codex exec` per turn | `agy --print` per turn, stream-json |
| Resume | `resume: sessionId` | `exec resume <id>` | `--conversation <id>` |
| Approval to caller | `canUseTool` | none (fixed at spawn) | PreToolUse hook → wrapper socket |
| Sandbox | none (tool allowlist) | OS sandbox | **advisory** (wrapper argument inspection) |
| System prompt | `systemPrompt.append` | `developer_instructions` | `.agents/rules/AGENTS.md` via `--add-dir` |
| kaoiro tools | in-process MCP | MCP bridge (stdio) | CLI bridge via `run_command` |
| Model | `claude-*` | account default / curated | `agy models` slugs + account default, `--model` |
| Auth | env / subscription | env / ChatGPT login | OAuth in `~/.gemini`, env inherited |
| Usage / limits | SDK events | none | `-p /usage --output-format json` (quota-free) |

## Decision

### F1 — Engine id, package, wiring

Engine id `antigravity` (capabilities value, `SpawnMessage.engine`,
`ext.engine`, `EngineKind`). New package `wrapper/antigravity`
(`@kaoiro/antigravity`) built on `@kaoiro/wrapper-core` +
`@kaoiro/agent-common`, copying the `wrapper/codex` skeleton
(`cli.ts` composition root, `host.ts` EngineAdapter, `adapter.ts` pure event
translation, `catalog.ts`, `toolhost.ts`, `bridge.ts`, `hook.ts`,
`gate.ts`, `history.ts`). Wiring checklist = ADR-0032 F1/F4a applied a third
time (protocol union, runner `ENGINE_PACKAGES` / `BUNDLED_ENGINES` /
`P0_FIELDS_BY_ENGINE` / sessions / setup wizard, server `@engine_values` /
`wrapper_channel` engine guard, release manifest and verifier sentinels,
`wrapper/package.json` fan-out, `pnpm-workspace.yaml`) **plus** the schema
additions of F4c (`approval` on spawn / snapshot / P0).

### F2 — Process model: spawn `agy` per turn, closed stdin, SIGTERM to interrupt

Each instruction turn spawns `agy --print <text> --output-format
stream-json --print-timeout 24h --disable-slash-commands [--conversation
<id>] [--model] [--effort] --add-dir <agent cwd> --add-dir <agent dir>`
with stdin closed. Both `--add-dir` values are mandatory: in print mode
the cwd is not a workspace root on its own (measured), and with only the
customization dir added the model operates inside it.
`--disable-slash-commands` keeps operator text out of the CLI control plane
([ADR-0036](0036-session-lifecycle-commands.md) only filters
literal `/new` / `/clear`). `interrupt()` terminates the child; pending gate
requests for that turn are resolved as `deny` and `waiting_permission` /
`waiting_input` are cleared; the next turn resumes by id. The resident
`--input-format stream-json` mode is recorded but not adopted (no in-band
interrupt or control channel).

### F3 — Persona injection through an always-on rules file in a per-agent customization dir

The wrapper owns a per-agent directory (`mkdtemp`, 0700) passed with
`--add-dir`, containing `.agents/rules/AGENTS.md` = kaoiro preamble
(working directory pinned to the agent cwd, bridge contract, "never touch
this directory") + server-pushed personality + footer. Persona packs stay
engine-independent (ADR-0032 F3). The wrapper rewrites the files before
**every** spawn from in-memory content, verifies their SHA-256 after
writing, and verifies them again after every turn: a mismatch marks the
session `error` (`antigravity_customization_tampered`) and refuses further
turns. This is **tamper detection, not prevention** — the agent runs as the
same uid and a shell can rewrite the directory; the per-spawn regeneration
bounds the damage to the remainder of one turn. It deletes the directory
on close and on startup sweeps stale
`kaoiro-agy-*` directories left by a SIGKILL (content is persona text and
the gate config, low sensitivity, but the sweep keeps `/tmp` bounded).

### F4 — Permission: prompts disabled at the CLI, wrapper gate decides

`.agents/hooks.json` registers one PreToolUse handler (matcher `*`,
`timeout` = gate deadline + margin) running `node <pkg>/dist/hook.js`. The
hook forwards `toolCall` to the wrapper's unix socket and prints the
decision; on any failure (socket, deadline, malformed payload) it prints
`deny` with a reason the model can read. The wrapper's `gate.ts` applies:

**Tool classes** — the classification table in the spec is the source of
truth (read / write / shell / network / subagent / agent-internal). Every
`init` event's `tools` list is diffed against it; unknown names are logged
loudly (vendor drift detector) and treated as *unclassified*:
`never` → `deny`, otherwise → ask. Agent-internal tools are always denied
(they need the TUI or MCP). `command_status` is read-class.

**Axes** (ADR-0033 vocabulary, `sandbox` × `approval`, plus
`network_access` with the effective-value normalisation of ADR-0033 F3
addendum — `danger-full-access` → always true, `read-only` → always false,
`workspace-write` → the toggle — shared with Codex through the same helper
so `ext.effective.network_access` means one thing across engines; resume
re-applies all three per [ADR-0014](0014-session-resume-and-restore.md)
F1 addendum). The sandbox axis is **advisory** on this engine: it is
enforced by argument inspection (`AbsolutePath` / `DirectoryPath` /
`TargetFile` / `Cwd` resolved and compared with the agent cwd), never by the
OS. The envelope stamps `ext.permission.enforcement`, a field every engine
fills so the dashboard never branches on its absence: `"os"` for Codex
(OS sandbox), `"mode"` for Claude (the sandbox value is a projection of
`permissionMode`, ADR-0033 F2), `"advisory"` for this engine. Only
`"advisory"` renders a permanent badge next to the sandbox value, the same
device ADR-0033 F4 addendum uses for Codex's host-fixed approval.

Rows are ordered strict → permissive, columns likewise:

| sandbox \ approval | `untrusted` | `on-request` | `never` |
|---|---|---|---|
| `read-only` | read allowed; everything else denied | same | same |
| `workspace-write` | read allowed; write in-cwd, shell, subagent ask; write out-of-cwd denied | read and in-cwd write allowed; shell and subagent ask; out-of-cwd write denied | read, in-cwd write, shell, subagent allowed (shell is not sandboxed — badge) |
| `danger-full-access` | read allowed; every other class asks | read and write allowed; shell and subagent ask | everything allowed |

`network` class: denied when the *effective* `network_access` is false;
when true it follows the shell column of the row (`browser_subagent` sits
in the network class rather than subagent because it exists to reach the
network, so the toggle must be able to switch it off). `on-failure` is rejected at spawn for
this engine (LaunchDialog offers three values). The gate also denies,
regardless of cell, any file-tool call whose resolved path (every
path-bearing key, realpath of the longest existing ancestor) lies inside
the customization dir; for `run_command` the string check is best-effort
only (a bash command line cannot be canonicalised), and the real protection
is the post-turn SHA verification of F3. A
`run_command` whose `Cwd` is outside the agent cwd is escalated to ask
regardless of cell (not denied — if the rules text fails to steer the model
the fallback is one approval, not a dead engine; the write-target check
still applies). Operator decisions reuse
`PermissionBroker` (`waiting_permission`, `ext.pending_permission`).

Default launch axes: `workspace-write` (the Codex sandbox default) ×
`on-request` (approval is selectable for the first time on this engine) ×
`network_access = false`.

### F4b — Gate self-verification on the production path

Because the hook is the only enforcement point and a hook that silently
does not fire means unlimited execution, the wrapper verifies the gate
before and during every session. F4b is a **detector of vendor-mechanism
failure**, not a defence against an adversarial model (the nonce and the
correlation map are readable by any shell the agent runs); it detects, it
does not prevent — a tool that ran without a gate request has already run.

1. Smoke test (not an execution gate): before the first turn, and after
   every `agy` version change or customization-dir regeneration,
   `agy -p /hooks --add-dir <cwd> --add-dir <dir> --output-format json`
   (quota-free, measured) must list exactly the kaoiro gate with the
   expected `source`; otherwise the spawn fails with `error`
   (`antigravity_gate_not_registered`). It runs on a different invocation
   path from `--print`, so passing it never excuses item 2.
2. Correlation invariant (the gate): a `step_update` with `step_type =
   "tool"` reaching `DONE` or `ERROR` must have a gate request observed
   for the same `stepIdx` (measured equal to `step_index`, 9 of 9 tool
   calls across 4 conversations). `ACTIVE` arrives before the hook
   decision returns (a 100 s hook showed `ACTIVE` first and `DONE` 110 s
   later), so the check is order-independent and keyed on completion. A
   completed tool step without a gate request terminates the child and
   marks the session `error` with `antigravity_gate_unobserved_tool`
   carrying the tool name; the session refuses further turns until item 1
   passes again. Scope: tool names in classes where hook firing is
   measured (write, read, shell, subagent, network — `write_to_file`,
   `view_file`, `list_dir`, `run_command`, `define_subagent`,
   `manage_task`, `search_web` fired; `wait_5_seconds` and `finish` did
   not appear as tool steps at all); an unmeasured name only logs loudly.
   Optional tightening (Stage B, needs a measured Δ): `ACTIVE` without a
   gate request after Δ → kill before completion.
3. The gate socket is **separate** from the `ToolHost` socket of F5 (two
   unix sockets, two nonces, two protocols): a gate decision and a tool
   execution must never share a trust role, and a shell reaching the
   `ToolHost` socket must not thereby be able to answer gate questions.
   A gate request without its nonce is answered `deny`. The nonce only
   rejects unrelated same-uid processes that guessed the socket path.
4. Gate socket lifecycle: if the hook connection closes before the wrapper
   answers (the CLI killed the hook on `timeout`, measured; interrupt;
   crash), the pending `PermissionBroker` entry is resolved as deny and
   `waiting_permission` is cleared — the Codex `ToolHost` habit of
   ignoring socket errors is not inherited on the gate path.

### F4c — Stage A fixes both axes at spawn; mid-session change is Stage B

`approval` is added next to `sandbox` in `SpawnRequest` / `SpawnMessage`,
`ResolvedSnapshotExt`, and `P0_FIELDS_BY_ENGINE["antigravity"] =
["sandbox", "approval", "networkAccess"]`; `ext.permission.enforcement`
(F4) is added to `PermissionAxesExt` (resume re-applies them; the
phase-15 D8 rule of dropping a stale `danger-full-access` to the safe
default applies to `approval = never` as well). `setPermissionMode` rejects
in Stage A exactly as on Codex. Mid-session mutation needs a new two-axis
control message plus dashboard controls and is scheduled as Stage B0.
Precondition for B0: the threat-model MUST that the server cannot widen a
wrapper's execution ceiling still holds — on this engine the cell matrix
*is* the ceiling — so B0 adds wrapper-config clamps (`max_sandbox`,
`max_approval`, `max_network_access`) and server-originated changes apply
only in the narrowing direction beyond the launch values.

### F5 — kaoiro tools through a CLI bridge, not MCP

`ToolHost` (Codex, unix socket NDJSON) is reused; `dist/bridge.js` becomes
a CLI (`list` / `call <tool> <json>`). `inter_agent` descriptors and
`ask_user_question` are served exactly as on Codex; a pending question
blocks the bridge process, which holds the turn (measured: long tool calls
hold). The rules file and a skill teach the invocation form.

The gate's automatic allow for bridge calls is a **whole-string match on
a metacharacter-free alphabet**, not a parse. `run_command` executes
through `bash` (measured: `$0` = bash), so any tokenizer of our own would
be betting on parity with bash's grammar. Instead the bridge accepts only
`node <abs> <bridge abs> list` or `node <abs> <bridge abs> call <tool>
<base64url payload>` and the gate auto-allows a `CommandLine` only when
it full-matches

```text
^<node abs path> <bridge abs path> (list|call [a-z_]{1,64} [A-Za-z0-9_-]{1,N})$
```

with N = 87 KiB (64 KiB of JSON, base64url-encoded), the tool name known
to the `ToolHost`, `Cwd` equal to the agent cwd, `WaitMsBeforeAsync` at
or above the wrapper's floor, and no unknown keys in `toolCall.args`.
Anything else falls through to the normal cell decision (cost of a false
negative = one operator approval). The bridge decodes and validates the
payload itself. The `ToolHost` socket carries no authentication beyond
the per-spawn nonce; a shell the agent runs can reach it directly, which is
inside the agent's own privilege — the bridge rule is a convenience, not a
security boundary, and the whole-string match is what protects the
*auto-allow*.

### F6 — Catalog: `agy models` at runner register, static snapshot fallback, account default entry

The runner runs `agy models` (quota-free) when `antigravity` is in
capabilities and publishes the slugs plus one explicit entry
`{ value: "", display_name: "account default" }` meaning "pass no
`--model`" (the measured account default `gemini-3.8-flash-high` was
absent from the list). On failure it publishes the 1.1.26 snapshot and
warns. Effort is hidden in Stage A; `ext.model_source` follows the phase-15
precedence with env `KAOIRO_ANTIGRAVITY_DEFAULT_MODEL`. No entry in
`LIVE_PROBE_ENGINES`.

### F7 — Session capabilities in Stage A

`supports_attachments: false`, `supports_model_switch: true`,
`supports_context_usage: false`; `rate_limits` (Stage B1) via `-p /usage` mapped to the
`seven_day` window (`utilization = 1 - remaining_fraction`); the group is
"Claude and GPT models" when the active slug starts with `claude-` or
`gpt-`, otherwise "Gemini Models" (unknown slugs and the account default
fall into the Gemini group, which is where the account default lives).
Session enumeration
(Stage B3) reads `~/.gemini/antigravity-cli/conversations/*.db`; history
replay is Stage B2. Stage A ships with enumeration returning an empty list.

### F8 — Documents that change with the trust story

threat-model.md gains a section for this engine (engine prompts disabled,
wrapper as sole enforcement point, advisory sandbox, bridge auto-allow
rule, possible host-wide setting under Q1); auth-and-authz.md gets the new
boundary (hook → unix socket with nonce); deployment.md documents the Q1
fallback if taken. These are acceptance items of phase-34, not follow-ups.

## Open questions

- **Q1 — closed 2026-09-04 (operator measurement)**:
  `--dangerously-skip-permissions` yields `init.permission_mode =
  "always-proceed"` for that process only, and the PreToolUse gate still
  fires for every tool step. F4 uses the flag; no host-wide setting is
  written and the setup wizard fallback is dropped.
- **Q2 — closed 2026-09-04**: the cwd is not a workspace root in print
  mode; passing `--add-dir <cwd>` as well restores it as the model's `Cwd`
  (F2). The gate's `Cwd` pin and the customization-dir deny stay as
  defence in depth.
- **Q3 — closed 2026-09-04**: environment variables reach both the hook
  and `run_command`; a hook exceeding its `timeout` is killed and the tool
  step fails without running (fail-closed on the CLI side too).
- **Q4 (Stage B)** — transcript format for history replay; conversation db
  schema; per-model context window table.

## Consequences

- Third engine with better approval fidelity than Codex and no new language
  in the codebase.
- The wrapper is the only enforcement point; F4b makes its absence
  detectable on every tool call instead of trusting the vendor mechanism.
- Vendor drift is expected (the binary self-updated mid-measurement); the
  runner reports the version, and a change re-triggers the registration
  check and the `init.tools` diff.
- Tool calls cost one extra `node` process each (hook) plus one per bridge
  call; acceptable at kaoiro's turn rate.

## Alternatives considered

| Alternative | Reason for rejection |
|---|---|
| Python SDK hosted as a child process with a custom event bridge | Second language and a bespoke protocol; the CLI already provides an event stream and resume |
| Python wrapper speaking the kaoiro protocol directly | Violates ADR-0023 type sharing; duplicates the whole agent-common layer |
| Resident `--input-format stream-json` process | No interrupt / control channel; would still need kill-and-resume |
| `settings.json` `permissions.allow` rules per command | Host-wide, static, exact-match only; no operator round trip |
| Prefix match for the bridge auto-allow | Trivially bypassed by shell chaining (`; curl … \| sh`) |
| `--sandbox` as the sandbox axis | Measured ineffective; would present a guarantee that does not exist |
| Custom agent (`--agent`) for persona | Unknown whether it replaces default scaffolding; rules file is sufficient and measured |
