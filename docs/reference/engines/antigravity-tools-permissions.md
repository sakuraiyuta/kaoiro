---
title: Antigravity tools and permissions
description: Current hook-gate, tool-child, bridge, and permission contract for the Antigravity CLI adapter.
status: provisional
last_updated: 2026-09-19
related: [protocol, antigravity-adapter]
---

# Antigravity tools and permissions

### Permission (hooks are the approval channel)

Headless `agy` cannot prompt. Measured behaviour by configuration:

| Configuration | `run_command` needing approval |
|---|---|
| default (`request-review`) | auto-denied: `TOOL_ERROR … user denied permission to run command`, stderr `jetski: … headless mode cannot prompt for, so it was auto-denied`, `result.denied_actions` |
| `settings.json` `permissions.allow: ["command(ls -1)"]` | exact command allowed and executed; other commands still auto-denied |
| PreToolUse hook returning `{"decision":"allow"}` or `permissionOverrides` under `request-review` | **still auto-denied** — hooks cannot lift the headless denial |
| `settings.json` `toolPermission: "always-proceed"` + PreToolUse hook | hook decides: `allow` → executed (`output` present); `deny` → `TOOL_ERROR: tool call denied by pre-tool hook: <reason>`; the model sees the reason and continues |
| `--dangerously-skip-permissions` + PreToolUse hook | `init.permission_mode = "always-proceed"` for that process only; the hook fired for both `run_command` steps (stepIdx 2, 4) and the commands ran *(measured by the operator, 2026-09-04; host `settings.json` untouched)* |
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
- The hook payload's `stepIdx` equals the stream's `step_index` of the
  matching `tool` step (4 of 4 tool calls across 3 conversations,
  *measured*), which is what the ADR-0057 F4b correlation invariant keys on.
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
  | network | `read_url_content`, `search_web`, `open_browser_url`, `generate_image`, `read_browser_page`, `list_browser_pages`, `browser_*` (15 names), `capture_browser_console_logs`, `capture_browser_screenshot`, `click_browser_pixel`, `execute_browser_javascript`, `browser_subagent` |
  | subagent | `define_subagent`, `invoke_subagent`, `manage_subagents` (`browser_subagent` is in network so the `network_access` toggle can switch it off) |
  | agent-internal (deny in headless) | `ask_question`, `ask_permission`, `ask_custom_permission`, `schedule`, `send_message`, `manage_inbox`, `delete_knowledge`, `call_mcp_tool`, `list_resources`, `read_resource` |

- Hooks are also the only PostToolUse / Stop observation channel; not used
  by the adapter in Stage A.

### `run_command` Cwd containment

The gate canonicalizes `Cwd` and treats an equal or descendant path as inside
the agent cwd. Inside paths use the ordinary sandbox and approval cell: `never`
allows, `on-request` asks, `local` consults the restricted command allowlist,
and `read-only` denies. For an outside, absent, non-string, or uncanonicalizable
`Cwd`, `workspace-write` asks for `untrusted`, `on-request`, or `local`, while
`never` denies with `kaoiro: command Cwd is outside the permitted workspace`.
The outside check precedes the `local` allowlist, so an observational command
cannot escape the agent workspace. `read-only` denies regardless of Cwd, and
`danger-full-access` applies its ordinary shell policy because this adapter's
sandbox axis is advisory. Bridge auto-allow remains restricted to its exact-cwd
grammar.

### Tool children: prompts disabled, absolute tool deadline (issue #350)

An `agy` tool child owns a PTY, so an interactive prompt inside a tool
(`ssh` passphrase, `git` credential, host-key confirmation) blocks there even
though the wrapper closes the parent's stdin; the CLI's own "waiting for
input" detection is model-backed and was unavailable in the incident. The
wrapper therefore does both of the following.

- **Prompts disabled through the environment.** Every `agy` turn is spawned
  with `GIT_TERMINAL_PROMPT=0` and `SSH_ASKPASS_REQUIRE=never`, and with
  `GIT_SSH_COMMAND=ssh -o BatchMode=yes` unless the operator already set a
  `GIT_SSH_COMMAND` (then it is left untouched and the CLI prints one
  launch-time line saying BatchMode was not injected). `BatchMode=yes`
  disables passphrase and host-key interaction (`man ssh_config`), so
  `git ls-remote` over SSH exits non-zero at once without an identity and
  succeeds unchanged with one *(measured against GitHub and Gitea)*. At
  launch, when `SSH_AUTH_SOCK` is set and `LC_ALL=C ssh-add -l` exits 1 with
  `The agent has no identities.` *(measured shape)*, the CLI warns once on
  stderr; a missing `ssh-add`, a dead socket, a timeout, or identities present
  stay silent.
- **Absolute tool deadline in the turn watchdog.** Every turn carries a
  watchdog token — an inter-agent delivery keeps its own, an operator
  instruction gets one synthesized by the host (Codex parity; the
  inter-agent bookkeeping ignores a token it never issued) — so both kinds
  are bounded. The single `TurnWatchdog` also tracks every parsed
  `step_update` `tool` step from `ACTIVE` to its `DONE` / `ERROR` (keyed by
  `step_index`); an `ACTIVE` step whose `step_index` or tool name cannot be
  correlated is fail-closed like an unprovable completion (SIGTERM, ADR-0057
  F4b) rather than left untracked. The oldest active step is bounded
  by `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS` (default 600000 = 10 minutes, the
  Claude Code Bash ceiling; minimum 1000). Stream progress extends only the
  inactivity bound, never this deadline. On expiry the wrapper logs
  `[kaoiro] antigravity turn watchdog tool timeout: … step=<n> tool=<name>
  elapsed=<ms> threshold=<ms>` plus a `[kaoiro][antigravity-lifecycle]`
  record `{"event":"tool_timeout",…}` (tool name and index only — never the
  raw tool input), SIGTERMs the child through the existing interrupt path,
  and reuses the existing abort grace (`…_ABORT_GRACE_MS`) and fail-stop.
  Whatever the CLI prints on the way out, the turn ends as
  `result{is_error: true, error_subtype: "error_during_execution",
  error_detail: "tool_timeout"}` (state `error` → `waiting_input`) and an
  inter-agent injection in that turn gets `peer_error.code = "timeout"`. No
  new wire type.

The deadline is the last safety net, not a scheduler: when `agy` keeps a step
`ACTIVE` while a long-running command works in the background, healthy work
past 10 minutes is also cut with the whole turn. A visible failure is
preferred to a silent `tool_running` that only an operator's `kill` ends.
The inactivity watchdog alone would have ended the incident's shape, but
only after its 30-minute default: a blocked tool emits no stdout events, so
inactivity does accrue *(measured: 22.6 s without stdout events during a
mock passphrase prompt; the indefinite hang itself was not reproduced because
the CLI backgrounded the child and the print timeout ended the turn)*.

### Operator interrupt: turn settlement (issue #371)

`interrupt()` closes the permission/question brokers, the gate server, and
the tool host, then sends the `agy` child one `SIGTERM` — killing the
process was already reliable *(measured on production: agy and every hook
child gone within tens of ms of the signal in all three reproduced cases)*.
What was missing was settlement: the state machine stayed at whatever the
last applied event left (`sending`, `tool_running`, `waiting_permission`)
indefinitely, `onTurnEnd` fired without a `cancellation`, so an inter-agent
sender's turn classified as `api_error` instead of `interrupted`, and nothing
reached the `[antigravity-lifecycle]` stream.

- **An operator-interrupted turn always ends at rest, including one still
  queued.** `#runTurn` returns a discriminated outcome (`stale` / `error` /
  `result`) instead of deciding its own terminal state, and `#drainTurns`'s
  `finally` converts a `stale` outcome to `"interrupted"` when
  `interrupt()`'s own record matches this turn and the host is still in
  normal admission (not `close()`d) — regardless of what the machine's
  CURRENT state happens to be. This matters for a turn that was only queued
  behind another one: it dequeues already at the PRIOR turn's at-rest state
  (its own `send()` never got the chance to move the machine to `sending`),
  so a state-based "already settled" check cannot tell that turn apart from
  a genuinely finished one. The dashboard never shows a stale `tool_running`
  / `waiting_permission` / `sending` after an interrupt, queued or active.
  `close()` and a watchdog fail-stop also produce `stale`, but with no
  matching interrupt record, so they keep the pre-issue-#371 behavior
  exactly (no fabricated result, no interrupt lifecycle event): the host is
  tearing down in both cases, so there is nothing left to settle for an
  observer.
- **Lifecycle events.** `interrupt_requested` (turn token, whether a
  permission/question was pending, child pid) logs when `interrupt()` runs;
  `interrupt_settled` (exit code, signal, elapsed ms) logs once the turn
  reaches the "interrupted" settlement above. An interrupt with no turn in
  flight (idle) produces neither.
- **`send()`'s silent non-start paths are now diagnosable.** `send()` on a
  closed, customization-tampered (`gate_broken`), or watchdog-fail-stopped
  host resolves without starting a turn and without throwing, so a caller's
  `.catch()` never sees it. That reason, and any other unclassified `send()`
  rejection, is now logged as `send_not_started` (turn token and delivery
  seqs only, never the inbound instruction text) before classification.
- **Out of scope.** Escalating past the single `SIGTERM` (process-group
  kill, a `SIGKILL` grace timer for a wedged hook) is tracked separately
  (issue #379); this only changes what settles after the existing kill.

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
  examples. The socket path and per-spawn nonce travel in the environment
  of the `agy` child, which `run_command` inherits *(measured)*.
- The gate auto-allows a `run_command` only when its `CommandLine`
  full-matches the bridge grammar of ADR-0057 F5 (absolute paths, tool
  name, base64url payload; no shell metacharacters possible). `run_command`
  runs through `bash` *(measured: `$0` = bash, `/proc/$$/exe` = bash)*, so
  `;`, `&&`, `$(…)` in a command line are interpreted *(measured)*.
- `ask_user_question` goes through the same bridge; the bridge blocks until
  the operator answers, which holds the `run_command` step and therefore the
  turn *(a 70 s tool call held the turn, measured)* — the same mechanism
  that makes `waiting_question` hold on Codex (ADR-0032 F6).
  `--print-timeout` and the hook timeout must both exceed the question wait.
- PreToolUse fired for every tool step observed so far: `write_to_file`,
  `view_file`, `list_dir`, `manage_task`, `run_command`, `define_subagent`,
  `search_web` *(measured; `stepIdx` matched `step_index` in all 9 cases)*.
  `wait_5_seconds` and `finish`, when asked for, produced no `tool` step
  in the stream.

## Constraints

- Every approval decision has to be made by the wrapper's hook gate — the
  CLI itself is run with prompts disabled. The gate must fail closed on
  socket failure, timeout, or malformed payload.

- The permission substrate is the per-process flag
  `--dangerously-skip-permissions` (ADR-0057 Q1, measured); the host-wide
  `toolPermission` setting is not used.

- The sandbox axis is advisory for this engine (`--sandbox` measured
  ineffective; enforcement is the wrapper's argument inspection only).
  The envelope must say so (ADR-0057 F4).

- When permission-sync negotiation succeeds and the runner supplies all three
  launch ceilings, the wrapper advertises `supports_permission_switch` with
  sandbox, network-access, and approval maxima. It applies an accepted
  `set_permission` at the next turn boundary and rejects an over-ceiling value
  again in the wrapper; this does not make sandbox enforcement non-advisory.
