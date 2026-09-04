---
title: Antigravity adapter — Antigravity CLI (agy) headless event specification
description: Measured behaviour of the Antigravity CLI (`agy` 1.1.26) in headless print mode — stream-json events, resume, customization discovery, hooks-as-permission-gate, and their derivation to kaoiro state. Third engine counterpart to agent-sdk-events / codex-sdk-events.
status: provisional
related: [protocol, plugin-model, architecture, agent-sdk-events, codex-sdk-events]
---
<!-- markdownlint-disable MD033 -->

# Antigravity adapter — Antigravity CLI (agy) headless event specification

## Purpose

Establishes the **measured** behaviour of the Antigravity CLI (`agy`) in
headless print mode as the substrate of the third engine `antigravity`
([ADR-0057](../adr/0057-antigravity-adapter.md)), and defines its derivation
to kaoiro state ([protocol](protocol.md)). Paired with
[agent-sdk-events](agent-sdk-events.md) (Claude) and
[codex-sdk-events](codex-sdk-events.md) (Codex).

**Status: provisional** — every claim below marked *(measured)* was observed
on 2026-09-04 with `agy` 1.1.26 (x86-64 Linux, OAuth personal login) on the
development host (the binary self-updated from 1.1.8 to 1.1.26 at the start
of the session, so vendor drift is a live risk and the adapter records the
version it measured against), using `--print` / `--output-format stream-json` runs in a
scratch directory. Claims marked *(unverified)* come from the vendor
changelog or docs and must be re-measured before relying on them. Promote
to `accepted` after the phase-34 Stage A dogfood.

## Why the CLI and not the Python SDK

The issue #181 premise was the Antigravity **SDK**. It is Python-only
(`google-antigravity` 0.1.16, no Node/TS SDK exists), which conflicts with
the TS in-process hosting premise of [ADR-0023](../adr/0023-host-runner-architecture.md)
D3. The CLI `agy` (Go binary, self-updating, already installed on hosts that use
Antigravity) exposes a single NDJSON event stream in headless mode that maps
onto kaoiro's state machine at least as well as `codex exec` does, so the
adapter drives the CLI as a child process and no Python bridge is needed.
The SDK route stays available as a future alternative
(`LocalAgentConfig(system_instructions=…, mcp_servers=[…])`,
`ask_user(handler=…)` policies) but is out of scope.

## Definition

### Main API and process model

```text
agy --print "<turn text>" \
    --output-format stream-json \
    --print-timeout <duration> \
    [--conversation <conversation_id>] \
    [--model <slug>] [--effort low|medium|high] \
    [--add-dir <per-agent customization dir>] \
    [--dangerously-skip-permissions] --disable-slash-commands \
    </dev/null
```

- **One `agy` process per turn** *(measured)*, the same spawn-per-turn model
  as `codex exec`. The first turn creates a conversation (its id arrives in
  the `init` event); every later turn passes `--conversation <id>`.
  Spawning from Node `child_process.spawn` with piped stdio works; running
  under `setsid` (no controlling tty) works *(measured)*.
- **stdin must be closed** *(measured)*: with stdin left open the run ends
  after ~3 s with `result.status = "ERROR"`, `error: "timeout waiting for
  response"`, and no assistant output. The conversation still persists.
- **Resident alternative** *(measured, not adopted for Stage A)*:
  `agy --print='' --input-format stream-json --output-format stream-json`
  keeps one process open and runs one turn per stdin line
  `{"event":"user","message":{"content":"<text>"}}`. Only the `user` event
  is recognised; any other `event` value is ignored with a stderr warning
  (`warning: ignoring unsupported stream input message event "…"`), so there
  is no in-band interrupt, permission, or model-switch channel. Each turn
  emits its own `result`.
- **`--disable-slash-commands`** *(flag present in 1.1.26)*: print mode
  otherwise expands slash commands and skills found in the prompt text, so an
  operator instruction starting with `/` would enter the CLI control plane.
  Every instruction turn passes the flag; the wrapper's own quota-free
  probes (`-p /usage`, `-p /hooks`) run without it.
- **Interrupt** = terminate the child (SIGTERM). The conversation remains
  resumable by id afterwards *(measured after ERROR-terminated turns)*. What
  the child prints on receiving a signal mid-stream is *(unverified)*; the
  adapter must treat child exit without a `result` as end of turn.
- **`--print-timeout`** is a Go duration; `24h` is accepted *(measured)*.
  Set it long because a turn can legitimately block on an operator decision
  (permission gate, ask_user_question) — see below.
- `--mode accept-edits|plan` and `--sandbox` are accepted but do not change
  `init.permission_mode` *(measured)*; their runtime effect is *(unverified)*
  and not used by the adapter.

### stream-json events (actual 1.1.8 shapes)

Three top-level `event` kinds, one JSON object per line *(measured)*:

```jsonc
{"event":"init","conversation_id":"<uuid>",
 "init":{"cwd":"/abs/path","permission_mode":"request-review",
         "tools":["ask_permission","ask_question","call_mcp_tool","run_command", "..."],
         "model":"gemini-3.6-flash-low",   // present only when --model was given
         "agent":"kaoiro"}}                // present only when --agent was given

{"event":"step_update","step_update":{
  "conversation_id":"<uuid>","step_index":1,
  "state":"ACTIVE|DONE|ERROR",
  "step_type":"user_input|agent_response|tool|system_message",
  "text_delta":"PONG",                       // agent_response only (may be absent)
  "tool_name":"run_command",                 // tool only
  "tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -1"},
               "output":"a.txt\r\n",         // DONE, some tools
               "error":{"type":"TOOL_ERROR","message":"…"}},   // ERROR
  "duration_seconds":4.8,
  "usage":{"input_tokens":5718,"output_tokens":34,"thinking_tokens":32,
           "cache_read_tokens":8130,"total_tokens":5752}}}     // DONE agent_response

{"event":"result","result":{
  "conversation_id":"<uuid>","status":"SUCCESS|ERROR|CANCELED",
  "response":"PONG\n","error":"…",           // error present on ERROR
  "duration_seconds":4.9,"num_turns":1,
  "usage":{…},
  "denied_actions":[{"action":"command","display_name":"RunCommand"}]}}  // optional
```

Observed details:

- `permission_mode` values seen: `request-review` (default) and
  `always-proceed` (when `settings.json` `toolPermission` is
  `always-proceed`). `init.tools` is the full tool inventory (57 names in
  1.1.8); it is not filtered by permission.
- `agent_response` steps stream `text_delta` fragments while `ACTIVE` and
  close with `DONE` + `usage`. A thinking-only step emits `DONE` with
  `thinking_tokens > 0` and no `text_delta`.
- `tool` steps go `ACTIVE` → `DONE|ERROR`; `tool_info.parameters` carries
  the raw tool arguments (`CommandLine`, `AbsolutePath`, `DirectoryPath`,
  `Query`, …). `output` is present on `DONE` for `run_command`, `grep_search`,
  `find_by_name`, `view_file` (summary), not guaranteed for every tool.
- `system_message` steps appear on resumed conversations.
- `result.status = "CANCELED"` was observed once together with
  `denied_actions` after a permission auto-deny; treat it as a normal end of
  turn, not an error.
- Non-ASCII in `text_delta` is passed through *(changelog fix, unverified)*.
- Per-turn baseline is ~5.7k `input_tokens` (system prompt) *(measured)*.

### State derivation

| Observation | kaoiro state / envelope |
|---|---|
| child spawned | `thinking` |
| `step_update` `agent_response` `ACTIVE` (+`text_delta`) | `thinking`; `text_delta` accumulates into the assistant text (log payload) |
| `step_update` `tool` `ACTIVE` | `tool_running`, `ext.tool_name = tool_name`, input = `tool_info.parameters` |
| `step_update` `tool` `DONE` / `ERROR` | back to `thinking`; ERROR logs `tool_info.error.message` |
| hook gate awaiting operator (see Permission) | `waiting_permission` with `ext.pending_permission` (ADR-0022) |
| bridge `ask_user_question` pending (see Tool definition) | `waiting_input` with `ext.pending_question` (ADR-0027) |
| `result` `SUCCESS` / `CANCELED` | `done`; `response` is the final text |
| `result` `ERROR` | `error` with `result.error` |
| child exit without `result` | `error` (`agy_exit_without_result`) |
| `init` (first turn) | session id = `conversation_id` (SessionPointers) |

### Permission (hooks are the approval channel)

Headless `agy` cannot prompt. Measured behaviour by configuration:

| Configuration | `run_command` needing approval |
|---|---|
| default (`request-review`) | auto-denied: `TOOL_ERROR … user denied permission to run command`, stderr `jetski: … headless mode cannot prompt for, so it was auto-denied`, `result.denied_actions` |
| `settings.json` `permissions.allow: ["command(ls -1)"]` | exact command allowed and executed; other commands still auto-denied |
| PreToolUse hook returning `{"decision":"allow"}` or `permissionOverrides` under `request-review` | **still auto-denied** — hooks cannot lift the headless denial |
| `settings.json` `toolPermission: "always-proceed"` + PreToolUse hook | hook decides: `allow` → executed (`output` present); `deny` → `TOOL_ERROR: tool call denied by pre-tool hook: <reason>`; the model sees the reason and continues |
| `--dangerously-skip-permissions` + PreToolUse hook | *(unverified — HITL; expected to equal the row above per process instead of host-wide)* |
| `--sandbox` (always-proceed, hook allow) | **no effect observed**: `touch` outside cwd and `curl https://example.com` both succeeded *(measured on WSL2; the terminal sandbox is advisory for this adapter)* |

Therefore the adapter's approval channel is a **PreToolUse hook** shipped in
the per-agent customization dir (`.agents/hooks.json`, matcher `*`). The
hook command receives the tool call on stdin and answers on stdout:

```jsonc
// stdin (camelCase, protojson)
{"conversationId":"<uuid>","workspacePaths":["…"],
 "transcriptPath":"~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl",
 "artifactDirectoryPath":"~/.gemini/antigravity-cli/brain/<uuid>",
 "modelName":"gemini-3.8-flash-high","stepIdx":2,
 "toolCall":{"name":"run_command","args":{"CommandLine":"ls -1","Cwd":"/…","WaitMsBeforeAsync":5000,
             "toolAction":"Listing directory contents","toolSummary":"List directory contents"}}}
// stdout
{"decision":"allow"}                                     // or
{"decision":"deny","reason":"kaoiro: operator rejected"}
```

- Hook `timeout` is per handler in seconds (default 30). `timeout: 3600`
  with a handler that blocked for 100 s was honoured: the `run_command` step
  stayed `ACTIVE` for 110 s and then ran *(measured)*. CLI behaviour on hook
  timeout is *(unverified)*; the wrapper fails closed (answers `deny`) before
  its own deadline, and the ordering **gate deadline < hook timeout <
  `--print-timeout`** is a hard constraint.
- A long `run_command` holds the turn: `sleep 70; echo …` stayed `ACTIVE`
  for 77 s, then `DONE` with output, and the model waited for it
  *(measured; `WaitMsBeforeAsync: 5000` in the args did not detach it)*. A
  bridge call that blocks on an operator answer therefore holds the turn.
- `agy -p /hooks --add-dir <dir> --output-format json` lists the gate
  (`name`, `source` path, `matcher`, `timeout_seconds`) without a model turn
  *(measured)*; without `--add-dir` the list is empty. This is the quota-free
  registration check the wrapper runs before the first turn.
- `PreToolUse` fires for every tool including reads. The 57 names in
  `init.tools` (1.1.26), classified for ADR-0057 F4 — the table is the
  source of truth and any name outside it is *unclassified*:

  | class | tools |
  |---|---|
  | read (local, side-effect free) | `view_file`, `list_dir`, `grep_search`, `find_by_name`, `command_status`, `list_permissions`, `manage_task`, `wait`, `wait_5_seconds`, `finish` |
  | write (local files) | `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` |
  | shell | `run_command`, `send_command_input`, `notebook_execution` |
  | network | `read_url_content`, `search_web`, `open_browser_url`, `generate_image`, `read_browser_page`, `list_browser_pages`, `browser_*` (19 names), `capture_browser_console_logs`, `capture_browser_screenshot`, `click_browser_pixel`, `execute_browser_javascript`, `browser_subagent` |
  | subagent | `define_subagent`, `invoke_subagent`, `manage_subagents` |
  | agent-internal (deny in headless) | `ask_question`, `ask_permission`, `ask_custom_permission`, `schedule`, `send_message`, `manage_inbox`, `delete_knowledge`, `call_mcp_tool`, `list_resources`, `read_resource` |

- Hooks are also the only PostToolUse / Stop observation channel; not used
  by the adapter in Stage A.

### Customization discovery (persona, hooks, skills)

*(measured)* A directory passed with `--add-dir <dir>` is scanned as a
customization root **without** being listed in
`settings.json.trustedWorkspaces`:

- `<dir>/.agents/rules/AGENTS.md` — always-on rule; verified as the persona
  injection point (the rule "begin every reply with BANANA-OK" was obeyed on
  every run). This is the `systemPrompt.append` / `developer_instructions`
  equivalent (ADR-0032 F3).
- `<dir>/.agents/hooks.json` — PreToolUse hooks fired from here. The same
  file placed under the **cwd**'s `.agents/` did not fire in two probes
  (once untrusted, once trusted + `git init`); root cause not isolated, so
  the adapter relies on `--add-dir` only.
- `<dir>/.agents/skills/<name>/SKILL.md` — progressive-disclosure skill
  (name + description always in context) *(format from the bundled
  `agy-customizations` docs; loading from `--add-dir` unverified)*.
- `<dir>/.agents/agents/<name>/agent.md` + `--agent <name>` — markdown
  custom agent with YAML frontmatter and an H1 system prompt; measured to
  take effect (`init.agent = "kaoiro"`, prompt obeyed). Not used: whether it
  replaces the default scaffolding is unknown.
- **Caveat (measured)**: with `--add-dir`, the model's `run_command` picked
  `Cwd = <dir>` and `hook.workspacePaths` listed only `<dir>`, i.e. the
  added directory became a workspace root the agent may operate in. Stage A
  must verify the behaviour when the real cwd is a trusted git repository,
  and the rules text must state the working directory explicitly.
- `.agents/mcp_config.json`, `.agents/plugins/<p>/mcp_config.json`,
  `.agents/permissions.json`, `.agents/settings.json` — **not loaded** in
  headless mode *(measured)*.

### MCP is not available in headless mode

*(measured)* No MCP server was ever spawned in print mode: a stdio server
registered via `agy mcp add` (global `~/.gemini/config/mcp_config.json`),
via a plugin under `--add-dir`, and via a custom agent with
`inheritMcp: true` never started (startup marker absent), and the CLI log
shows `declarative_config_loader.go: skipping component during resolution:
empty component: prompt section "mcp_servers"` on every run. `call_mcp_tool`
is listed in `init.tools` but the model reports no MCP tools. Consequently
kaoiro's tool surface cannot ride on MCP as it does for Codex
(ADR-0032 F5) and uses a CLI bridge instead (next section). Re-check on
each `agy` upgrade; an MCP path would simplify the bridge.

### Tool definition (CLI bridge over the wrapper tool host)

The wrapper reuses the Codex `ToolHost` (NDJSON over a per-agent unix
socket: `list_tools` / `call_tool`) and ships `dist/bridge.js` as a **CLI**
instead of an MCP server:

```text
node <pkg>/dist/bridge.js call <tool_name> '<json input>'   # prints the tool result
node <pkg>/dist/bridge.js list                              # prints the tool list
```

- The model learns the bridge from the always-on rules file (tool names,
  one-line contracts, the exact invocation form) and a skill with fuller
  examples. The socket path travels in the environment of the `agy` child
  (`KAOIRO_BRIDGE_SOCKET`), which `run_command` inherits *(inheritance is
  unverified — Stage A measures it; fallback is an absolute path baked into
  the rules text)*.
- The hook gate auto-allows a `run_command` whose `CommandLine` starts with
  the bridge invocation (exact prefix match on the absolute script path), so
  inter-agent calls never wait for the operator.
- `ask_user_question` goes through the same bridge; the bridge blocks until
  the operator answers, which holds the `run_command` step and therefore the
  turn — the same mechanism that makes `waiting_question` hold on Codex
  (ADR-0032 F6). `--print-timeout` and the hook timeout must both exceed
  the question wait.

### System-prompt equivalent (persona personality injection)

`<dir>/.agents/rules/AGENTS.md` is written by the wrapper at startup from
the server-pushed persona prompt (personality + footer, ADR-0029 F9) plus
the kaoiro operating preamble (working directory, bridge usage). It is
regenerated on every startup and on `display_name_sync`, and read by every
per-turn spawn. Persona packs stay engine-independent (ADR-0032 F3).

### Session / conversation resume and enumeration

- Resume: `--conversation <id>` *(measured)*; `--continue` resumes the most
  recent conversation (not used: ambiguous across agents on one host).
- Store: `~/.gemini/antigravity-cli/conversations/<id>.db` (sqlite, one per
  conversation) and `conversation_summaries.db` *(paths measured; schema
  unverified)*.
- Transcript for history replay:
  `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`
  *(path from the hook payload; format unverified — Stage B)*.
- A conversation opened in two processes at once is only advised against
  by a banner *(changelog)*; the wrapper serialises turns anyway.

### Models, effort, usage, rate limits

- `agy models` prints the slugs available to the account, one per line
  *(measured; 1.1.26 rejects `--output-format` on this subcommand)*:
  `gemini-3.6-flash-high|medium|low`, `gemini-3.1-pro-high|low`,
  `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.
  The account default (`-p /model`) was `gemini-3.8-flash-high`, which is
  **not** in the list — the list is not exhaustive.
- `--model <slug>` echoes into `init.model` *(measured)*; `--effort
  low|medium|high` is accepted *(measured; effect not separately
  observable — gemini slugs already encode the tier)*.
- Slash commands answered without a model turn or quota spend
  *(measured)*: `agy -p /usage --output-format json` →
  `command.data.groups[].buckets[]` with `window: "weekly"`,
  `remaining_fraction`, `reset_time` (two groups: "Gemini Models" and
  "Claude and GPT models"); `-p /model` → current model/effort;
  `-p /permissions`, `-p /hooks`, `-p /help`.
- Context window sizes are not exposed; `usage.input_tokens` of the last
  `agent_response` step approximates context in use.

### Authentication and host requirements

- OAuth personal login stored under `~/.gemini/` (`selectedAuthType:
  "oauth-personal"`); the child inherits the wrapper's environment and HOME,
  so no credential handling in kaoiro (ADR-0032 F7 convention).
  `GEMINI_API_KEY` is the API-key alternative *(docs, unverified)*.
- Requires `agy` on `PATH`. The runner probes `agy --version` and `agy models`
  at register time (both quota-free) and reports the version; this spec was
  measured against 1.1.26, and a version change is the trigger to re-run the
  measurements marked *(measured)* here, because the binary self-updates.

## Constraints

- Every approval decision has to be made by the wrapper's hook gate — the
  CLI itself is run with prompts disabled. The gate must fail closed on
  socket failure, timeout, or malformed payload.
- The permission substrate (`--dangerously-skip-permissions` per process vs
  `toolPermission: "always-proceed"` in the host-wide `settings.json`) is
  decided by the HITL measurement recorded in ADR-0057 Q1. The host-wide
  setting would also affect the operator's own interactive `agy` sessions.
- No attachments in Stage A (`--print` takes text only).
- No context-usage capability until a per-model window table exists.
- The sandbox axis is advisory for this engine (`--sandbox` measured
  ineffective; enforcement is the wrapper's argument inspection only).
  The envelope must say so (ADR-0057 F4).

## See Also

- [ADR-0057](../adr/0057-antigravity-adapter.md) — decisions
- [phase-34-antigravity-adapter](../plans/phase-34-antigravity-adapter.md) — implementation plan
- [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md)
- Vendor: https://antigravity.google/docs/cli/overview ,
  https://antigravity.google/docs/sdk/overview , bundled
  `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/*.md`
