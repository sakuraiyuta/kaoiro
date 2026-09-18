---
title: Antigravity tools and permissions reference
status: implemented
last_updated: 2026-09-18
description: The Antigravity hook gate, bridge authorization, advisory sandbox, non-interactive child policy, and runtime permission-switch contract.
---

# Antigravity tools and permissions reference

## Authorization boundary

Headless `agy` cannot obtain an interactive approval. The host creates a
private customization directory with a `PreToolUse` hook and checks the hook
registration through `agy -p /hooks` before a turn. The hook forwards tool
requests to the wrapper permission broker and fails closed if the socket,
payload, or reply cannot be proven valid.

The observed headless permission outcomes were:

| Configuration | `run_command` needing approval |
| --- | --- |
| default (`request-review`) | auto-denied with `TOOL_ERROR … user denied permission to run command`, headless-prompt stderr, and `result.denied_actions` |
| `settings.json` `permissions.allow: ["command(ls -1)"]` | the exact command ran; other commands remained auto-denied |
| PreToolUse `{"decision":"allow"}` or `permissionOverrides` under `request-review` | still auto-denied; a hook cannot lift the headless denial |
| `settings.json` `toolPermission: "always-proceed"` plus a hook | hook `allow` ran the tool and `deny` returned `TOOL_ERROR: tool call denied by pre-tool hook: <reason>` |
| `--dangerously-skip-permissions` plus a hook | `init.permission_mode` became `always-proceed` for that process only; observed hook calls decided the commands |
| `--sandbox` with allow | a write outside cwd and `curl https://example.com` both succeeded on WSL2 |

The hook is `.agents/hooks.json` with matcher `*`. Its observed protojson
input and reply contract were:

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

`transcriptPath` is the observed history-replay path pattern. Its JSONL schema
is not established. The observed `stepIdx` matched the stream `step_index` in
four tool calls across three conversations; this is the correlation input used
by ADR-0057 F4b.

The generated rule directs kaoiro tool use through the wrapper CLI bridge. A
`run_command` is auto-allowed only when its complete command line matches the
bridge grammar; arbitrary shell input is classified by the gate. The bridge
uses a per-agent private Unix socket and a per-spawn nonce. Native headless
MCP is not the bridge transport.

The gate is conservative. Read-only core utilities and a constrained set of
local Git observations can be automatically allowed in `local` approval
mode; unknown commands, shell expansions, remote Git commands, path escapes,
and tool classes outside the allowlist require approval. `.git` is a protected
write location, including paths that reach it through a symlink. The document,
not source code, is the semantic contract; `gate.ts` implements the individual
command shapes.

The measured 1.1.26 inventory was classified as follows. Names outside this
table are unclassified and must not inherit an allow decision.

| class | tools |
| --- | --- |
| read (local, side-effect free) | `view_file`, `list_dir`, `grep_search`, `find_by_name`, `command_status`, `list_permissions`, `manage_task`, `wait`, `wait_5_seconds`, `finish` |
| write (local files) | `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit` |
| shell | `run_command`, `send_command_input`, `notebook_execution` |
| network | `read_url_content`, `search_web`, `open_browser_url`, `generate_image`, `read_browser_page`, `list_browser_pages`, `browser_*` (15 names), `capture_browser_console_logs`, `capture_browser_screenshot`, `click_browser_pixel`, `execute_browser_javascript`, `browser_subagent` |
| subagent | `define_subagent`, `invoke_subagent`, `manage_subagents` (`browser_subagent` is network so `network_access` can switch it off) |
| agent-internal (deny in headless) | `ask_question`, `ask_permission`, `ask_custom_permission`, `schedule`, `send_message`, `manage_inbox`, `delete_knowledge`, `call_mcp_tool`, `list_resources`, `read_resource` |

Hooks were also the only observed PostToolUse and Stop observation channel;
the adapter did not use them for that purpose in Stage A.

## Non-interactive child policy

Every child receives `GIT_TERMINAL_PROMPT=0` and
`SSH_ASKPASS_REQUIRE=never`. Unless the operator already supplied
`GIT_SSH_COMMAND`, the host sets it to `ssh -o BatchMode=yes`; preserving an
operator value produces a launch warning. If `SSH_AUTH_SOCK` is present but
has no identities, the CLI warns that SSH Git operations will fail in batch
mode. These controls make credential and passphrase prompts fail fast; they
do not grant credentials or authorize a network operation.

The tool wall-clock deadline is a separate last-resort guard. Its exact
settings and terminal projection are in
[the event reference](antigravity-events.md#watchdog-contract).

Hook timeout is seconds per handler. A `timeout: 3600` handler blocked for
100 seconds, kept `run_command` ACTIVE for 110 seconds, and then ran. The
CLI's complete timeout behaviour was not established, but the wrapper answers
deny before its deadline. The required ordering is:

```text
gate deadline < hook timeout < --print-timeout
```

A `sleep 70; echo …` command stayed ACTIVE for 77 seconds then completed;
`WaitMsBeforeAsync: 5000` did not detach it. A bridge question therefore holds
the tool step and the turn. The current watchdog tracks that tool separately
from the gate deadline. A blocked mock passphrase prompt had 22.6 seconds with
no stdout; the indefinite incident was not reproduced because the CLI
backgrounded the child and print timeout ended the turn.

`agy -p /hooks --add-dir <dir> --output-format json` listed the gate name,
source path, matcher, and `timeout_seconds` without a model turn; without
`--add-dir` the list was empty. This is the quota-free registration check. A
hook that outlived its configured timeout was killed and ended the tool step in
ERROR (`JSON hook "jsonhook__kaoiro-gate_PreToolUse_0_0" failed: command
failed: signal: killed`); the tool did not run.

## Sandbox is advisory

The Antigravity `sandbox` setting is represented in kaoiro state, but this
engine does not claim CLI sandbox enforcement. The effective enforcement point
is the wrapper's hook gate and permission broker. Operators must therefore
interpret `permission.enforcement: "advisory"` as a boundary statement, not as
a promise that `agy` blocks an operating-system escape.

## Runtime permission switching

The wrapper supports the common `set_permission` request with three axes:
`sandbox`, `network_access`, and `approval`. Existing `setPermissionMode`
requests are rejected in favour of this structured request. The initial
selection defaults to `workspace-write`, `on-request`, and network access
derived from the sandbox.

Runtime switching is advertised only when both conditions hold:

1. permission-sync negotiation with the server succeeded; and
2. the runner supplied every launch ceiling: `max_sandbox`,
   `max_network_access`, and `max_approval`.

The advertised `permission_switch_axes` contains the three maxima. Missing
sync or any missing maximum is fail-closed: the host advertises no permission
switch capability. The server clamps a request first; the host checks the
same ceiling again before accepting a control or its evidence. A value beyond
the ceiling leaves the current configuration intact and reports
`permission_failed` with `reason: "exceeds_launch_ceiling"` and
`rolled_back_to` equal to the current selection.

An accepted switch is staged and applied before the next turn's gate is
constructed. It never mutates the gate already serving a running child. The
host then reports `permission_applied`; Antigravity has no per-turn identity,
so that observation intentionally omits `turn_id` while retaining the session
and execution identities required by the common control contract.

The permission substrate is the per-process
`--dangerously-skip-permissions` flag; the adapter does not use a host-wide
`toolPermission` setting. The gate must fail closed on socket failure,
timeout, or malformed payload. Runtime switching does not make sandbox
enforcement non-advisory.

## CLI bridge

The wrapper reuses `ToolHost` (NDJSON over a per-agent Unix socket with
`list_tools` and `call_tool`) and ships `dist/bridge.js` as a CLI rather than
an MCP server:

```text
node <pkg>/dist/bridge.js call <tool_name> '<json input>'   # prints the tool result
node <pkg>/dist/bridge.js list                              # prints the tool list
```

The always-on rules file gives the model the tool names, one-line contracts,
and exact invocation; a skill has fuller examples. The child environment
passes its socket path and per-spawn nonce to `run_command`. The gate
auto-allows only the full bridge grammar from ADR-0057 F5: absolute paths,
tool name, base64url payload, and no shell metacharacters. `run_command`
executes under bash, so `;`, `&&`, and `$(…)` are otherwise interpreted.
`ask_user_question` uses the same bridge and blocks until the operator
answers. PreToolUse was observed for `write_to_file`, `view_file`, `list_dir`,
`manage_task`, `run_command`, `define_subagent`, and `search_web`; asked-for
`wait_5_seconds` and `finish` yielded no stream tool step.

## Recovery-oriented facts

If a switch remains pending, do not infer success from a CLI tool result.
Wait for the host's `permission_applied` or `permission_failed` observation.
For a tool prompt or a blocked child, recover through the operator permission
channel; do not attempt to enable a host-wide `agy` setting as a substitute
for the wrapper gate. A quota terminal projects as `rate_limit` and blocked
`seven_day` rate limit state; see
[the event reference](antigravity-events.md#rate-limit-projection).

## Related pages

- [Antigravity event reference](antigravity-events.md)
- [Antigravity adapter architecture](../../architecture/antigravity-adapter.md)
- [Permission protocol reference](../../specs/protocol.md)
