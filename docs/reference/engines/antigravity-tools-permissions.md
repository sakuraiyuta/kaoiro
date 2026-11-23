---
title: Antigravity tools and permissions
description: The permission mapping and hook gate, call verification and gate faults, the Stop hook answer, kaoiro tools over the shared HTTP tool host, retirement, and the known limitations of the Antigravity ACP host.
status: provisional
last_updated: 2026-11-23
related: [protocol, antigravity-adapter]
---

# Antigravity tools and permissions

How the `antigravity` engine decides tool calls and serves kaoiro tools. The
process model, turn lifecycle and outcomes are in
[Antigravity events](antigravity-events.md); the decision is
[ADR-0078](../../adr/0078-antigravity-over-acp.md); the threat model is in
[enforcement boundaries](../security/enforcement-boundaries.md#antigravity-engine--the-wrapper-is-the-only-enforcement-point).
Vendor behaviour marked as measured was measured with `agy` 1.5.14: hooks,
turn end and the Stop hook in
[hooks and turns](../../evidence/antigravity/agy-1.5.14-acp-measurements-2026-11-22-hooks-and-turns.md);
teardown, sandbox scope and subagents in
[sandbox and subagents](../../evidence/antigravity/agy-1.5.14-acp-measurements-2026-11-22-sandbox-and-subagents.md);
sessions and the kaoiro MCP server in
[setup and sessions](../../evidence/antigravity/agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md).

## Permission (hooks are the approval channel)

`agy acp` runs with `--dangerously-skip-permissions`, so `agy` never asks;
a PreToolUse hook asks the wrapper's gate, and that answer is the only
check. The status envelope carries `ext.permission.enforcement = "advisory"`.

| kaoiro sandbox | `--sandbox` | What bounds a command |
|---|---|---|
| `read-only` | yes | The gate denies shell tools |
| `workspace-write` | yes | The gate; under these launch flags the sandbox was measured not to confine writes in the home or outbound HTTPS |
| `danger-full-access` | no | The gate only |

Effective network access is `false` for `read-only`, `true` for
`danger-full-access`, and the configured value for `workspace-write`
(`wrapper/antigravity/src/network_access.ts`). Supported approvals are
`untrusted`, `on-request`, `local` and `never`; `on-failure` is refused when
the host is created.

### Evaluation order

`AcpToolPolicy` in `wrapper/antigravity/src/gate.ts` decides each hook
request. The first match decides:

1. `read_file` whose arguments are not exactly `Path` (non-empty string) and
   optional integer `StartLine` / `EndLine` and non-negative integer
   `ByteOffset`: deny.
2. A write-class tool with a path argument that is not a non-empty,
   canonicalizable string, or with no target path: deny.
3. Any path argument (`AbsolutePath`, `DirectoryPath`, `TargetFile`, `Cwd`,
   `Path`) inside the customization directory, a non-string path argument,
   or a `CommandLine` containing the directory's canonical path: deny.
4. An agent-internal tool: deny.
5. `mcp_kaoiro_<name>` for a registered kaoiro tool: allow, in every cell.
6. A network-class tool while effective network access is off: deny.
7. The cell of the tool's class:

| Class | `read-only` | `workspace-write` | `danger-full-access` |
|---|---|---|---|
| read | allow | allow | allow |
| write | deny | Every path argument inside the cwd, else deny; then `untrusted` asks, `local` asks for a target inside `.git`, others allow | `untrusted` asks, `local` asks for a target inside `.git`, others allow |
| shell | deny | Network off: deny. On: `never` denies, others ask | `never` allows; `local` allows a `run_command` whose command line passes the observational allowlist (`localCommandAllowed`) and asks otherwise; others ask |
| network | deny | As shell (network on) | As shell |
| subagent | deny | As shell | As shell |
| unclassified, including other `mcp_*` names | deny | `never` denies, others ask | `never` denies, others ask |

| Class | Tools |
|---|---|
| read | `view_file`, `read_file`, `list_dir`, `grep_search`, `find_by_name`, `command_status`, `list_permissions`, `manage_task`, `wait`, `wait_5_seconds`, `finish` |
| write | `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file`, `notebook_edit`, `write_file`, `edit_file` |
| shell | `run_command`, `send_command_input`, `notebook_execution` |
| network | `read_url_content`, `search_web`, `search_marketplace`, `open_browser_url`, `generate_image`, `read_browser_page`, `list_browser_pages`, the `browser_*` tools, `capture_browser_console_logs`, `capture_browser_screenshot`, `click_browser_pixel`, `execute_browser_javascript`, `browser_subagent` |
| subagent | `define_subagent`, `invoke_subagent`, `manage_subagents` |
| agent-internal | `ask_question`, `ask_permission`, `ask_custom_permission`, `schedule`, `send_message`, `manage_inbox`, `delete_knowledge`, `call_mcp_tool`, `list_resources`, `read_resource`, `list_plugin_accounts`, `run_workflow` |

The table in `gate.ts` is the source of truth; a name outside it is
unclassified. `browser_subagent` is in the network class so the network
setting can switch it off. `write_file` and `edit_file` name their target
in `Path`, the other write tools in `TargetFile` or `AbsolutePath`. The
`edit_file` hook requests of `agy` 1.5.14 carried `Path`, `Replacement` and
`Target`, all strings, and reached the hook under `read-only` and
`workspace-write` (4 runs, measured).

- A command's `Cwd` decides no cell; it counts only as a path argument for
  step 3. `BypassSandbox` is not read: a `run_command` with
  `BypassSandbox: true` is decided by the shell row and, once allowed, runs
  outside `agy`'s sandbox (measured).
- An ask goes to the operator through the permission broker. A rejection is
  answered `deny` with the broker's message, or `kaoiro: operator rejected`;
  the model sees the reason and the turn continues (measured).
- A hook request is decided only inside the prompt's window and before a
  stop latched. Otherwise it is denied without a dialog: `kaoiro: no turn is
  open for this tool call` (also recorded as an `out_of_turn_event`) or
  `kaoiro: the turn is stopping`.
- A hook request from a subagent's conversation is decided by the same
  cell; [call verification](#call-verification-and-gate-faults) treats it
  separately.

## Hooks and the hook list

- **Customization directory.** The host creates one private temporary
  directory (mode 0700, with an owner marker) and passes it with
  `--add-dir`. Before every start it rewrites `.agents/hooks.json` and
  records its SHA-256; when an input settles it compares the file with that
  hash. The directory is removed on close, and directories left by dead
  wrapper processes of the same uid are removed when a host is created
  (`wrapper/antigravity/src/customization.ts`).
- **Registrations.** One command, `<node> ['<execArg>' ...]
  '<kaoiro entry>' wrapper antigravity hook`, is registered for
  `PreToolUse` (matcher `*`, timeout 3600 s) and for `Stop` (timeout 30 s,
  no matcher; the JSON hook list gives a Stop row no `matcher` field,
  measured).
- **Hook list check.** Before every spawn the host runs
  `agy -p /hooks --add-dir <cwd> --add-dir <customization dir>
  --output-format json` (probe timeout 30 s by default). The start is
  refused unless the managed `hooks.json` is listed once, enabled, with
  exactly the two actions above (same command and timeouts, `*` for
  PreToolUse and no matcher for Stop), and no other
  enabled group has a Stop action; the refusal names the other group's file
  (`antigravity_hooks_refused:foreign_stop_hook:<file>`).
- **Hook protocol.** The hook reads the payload on stdin, adds the gate
  nonce, sends it as one JSON line to the gate socket and prints the answer.
  The gate reads only these fields:

```jsonc
// PreToolUse: toolCall.id is the ACP toolCallId, conversationId the session ID (measured)
{"hookEventName":"PreToolUse","conversationId":"<session id>",
 "toolCall":{"id":"<call id>","name":"run_command","args":{"CommandLine":"ls"}}}
// Stop
{"hookEventName":"Stop","conversationId":"<session id>",
 "terminationReason":"NO_TOOL_CALL","fullyIdle":false}
// answers printed on stdout
{"decision":"allow"}
{"decision":"deny","reason":"kaoiro: ..."}
{"decision":"continue","reason":"..."}  // Stop only
{}                                      // Stop: let agy's loop end
```

- **Failure answers.** Every failure the hook or gate can observe answers
  PreToolUse with `deny` and Stop with `{}`:

  | Failure | PreToolUse reason |
  |---|---|
  | Gate variables missing in the hook's environment | `kaoiro: gate environment is not configured` |
  | Payload not a JSON object | `kaoiro: malformed hook payload` |
  | Gate socket error, closed or late, or a malformed gate answer | `kaoiro: gate unavailable (<cause>)` |
  | Wrong nonce or missing request fields | `kaoiro: invalid gate request` |
  | A second request with the same key | `kaoiro: duplicate tool call` |
  | The gate's decision failed | `kaoiro: gate failure` |

- **Timeouts.** A PreToolUse hook waits for the gate up to
  `KAOIRO_GATE_DEADLINE_MS` (55 min), below its 60 min hook timeout. An
  operator ask is also bounded by the permission broker's timeout and by the
  per-tool deadline, which started at the call's `tool_call` update (that
  update precedes the hook request, measured). A Stop hook asks the gate for
  at most 25 s, below its 30 s timeout. A PreToolUse hook that exceeds its
  timeout is killed and its call fails; a Stop hook that fails or times out
  ends `agy`'s loop (measured).

## The Stop hook answer

`agy` runs its Stop hooks whenever its execution loop ends: at the end of
every prompt and when it re-invokes the model by itself. A `continue` answer
re-enters the loop. `agy` honoured at most 10 continuations per prompt, does
not call the Stop hook on `session/cancel`, and follows another enabled Stop
hook's `continue` over kaoiro's (measured).

The gate answers `continue`, with a fixed reason asking the model to wait for
its background command and reply with the result, only when all of these
hold (`wrapper/antigravity/src/stop_answer.ts`):

1. the request's `conversationId` is the generation's session ID;
2. the prompt's window is open and no stop route latched for the input;
3. `terminationReason` is `NO_TOOL_CALL`;
4. `fullyIdle` is `false`;
5. fewer than 10 continuations were granted for this prompt (the tenth is
   granted, the next request is answered stop).

Otherwise it answers stop, printed as `{}`. A Stop request from another
conversation is a subagent's own loop; it is answered stop and not counted.

A command `agy` promotes to the background lets the prompt return
`end_turn` while the command runs; its ACP tool call stays `in_progress`
until the command ends. Answering `continue` while `fullyIdle` was false kept
the prompt open until the output was in the reply (4 of 4 runs, measured).
The conditions and costs of this hold are listed under
[known limitations](#known-limitations).

## Call verification and gate faults

`wrapper/antigravity/src/call_verification.ts` joins each tool call that ACP
shows (C) to the PreToolUse request with the same key (H), per generation.

- **H** is keyed by (conversation ID, call ID) and holds the tool name and
  canonical arguments (object keys sorted). It is recorded as `received`
  before the request is decided, then becomes `allow` or `deny` once the
  answer was written to the hook socket without error, or `abandoned` when
  the hook connection closed first. A second H with the same key is a fault
  and is answered `deny`. Stop requests make no H.
- **C** is keyed by call ID for the generation's own session, with the name
  and `rawInput` of its first update. Its first terminal status settles it;
  repeats are ignored, and the first repeat leaves an `out_of_turn_event`
  record `repeated_terminal` with the call ID. When a stop route latches or the connection closes,
  every C still open is marked as stopped while open. A C first seen after
  that is not marked: still open at settlement with no H, it is a fault.
- **Check**, when a C reaches `completed` or `failed` (also after the input
  settled, while the generation's updates still arrive), and for each C
  still open when the input settles, before its result is published:

| C | H of the generation's session with the same call ID | Result |
|---|---|---|
| `completed` | `allow`, same name and arguments | ok |
| `failed` | `allow` or `deny`, same name and arguments | ok |
| `failed`, or open at settlement, and stopped while open | `received`, `abandoned` or none | ok |
| Open at settlement | `allow`, same name and arguments | ok |
| Any other | | gate fault |

- An H from another conversation (a call inside a subagent) keeps its record
  and duplicate check but needs no C. A C whose only H has another
  conversation ID is a fault.
- There is no pre-execution exception. Calls that `agy`'s argument
  validation rejected reached neither the hook nor ACP (measured).
- **Faults:** the last row and a duplicate H, reported as
  `antigravity_gate_unobserved_tool` with detail
  `antigravity_gate_unobserved_tool:<tool name>`, and a changed
  `hooks.json` at settlement, reported as
  `antigravity_customization_tampered`.
- **A fault latches at once** and writes a `gate_fault` lifecycle record.
  Queued input and every later `send()` are rejected as `gate_broken`, no
  generation starts, and state publications show `error`. A fault during an
  input stops it (route `gate_fault`) and fails it
  ([outcome rows](antigravity-events.md#turn-outcome)); a fault found after
  the input's result was published leaves that result. There is no
  automatic recovery; the latch lasts until the wrapper restarts or the
  session is reset.
- For a rejected inter-agent input the wrapper retires its deliveries
  through the server; if that retirement fails, the sender gets an
  `interrupted` notice and may retry
  ([delivery](../inter-agent/delivery.md#dispatch-confirmation-ledger-issue-237)).

## Tool children: prompts disabled, absolute tool deadline (issue #350)

A tool child of `agy` owns a PTY, so an interactive prompt inside a tool
(`ssh` passphrase, `git` credential, host-key confirmation) would block it.

- **Prompts disabled through the environment.** Every `agy` process gets
  `GIT_TERMINAL_PROMPT=0` and `SSH_ASKPASS_REQUIRE=never`, and
  `GIT_SSH_COMMAND=ssh -o BatchMode=yes` unless the operator set a
  `GIT_SSH_COMMAND`; then it is left untouched and the CLI prints one
  launch-time line saying BatchMode was not injected
  (`wrapper/antigravity/src/tool_child_env.ts`). At launch, when
  `SSH_AUTH_SOCK` is set and `LC_ALL=C ssh-add -l` exits 1 with
  `The agent has no identities.`, the CLI warns once on stderr; a missing
  `ssh-add`, a dead socket, a timeout or identities present stay silent.
- **Absolute tool deadline.** The turn watchdog
  (`wrapper/antigravity/src/turn_watchdog.ts`) starts at the ACK. Every turn
  carries a watchdog token: an inter-agent delivery its own, an operator
  instruction one the host creates. Each ACP tool call in the window is
  tracked from its first update to its `completed` or `failed` update; the
  oldest open call is bounded by `KAOIRO_ANTIGRAVITY_TOOL_TIMEOUT_MS`
  (default 600000 ms, minimum 1000), and progress never extends that bound.
  On expiry the wrapper logs `[kaoiro] antigravity turn watchdog tool
  timeout: … step=<n> tool=<name> elapsed=<ms> threshold=<ms>` and a
  `tool_timeout` lifecycle record (step index in order of first sight and
  tool name only), then stops the input through the `watchdog` route. The
  turn ends with `error_detail: tool_timeout`, and an inter-agent sender
  gets `peer_error.code = "timeout"`.
- **Inactivity.** With no progress (activity or control updates and hook
  requests in the window) for the inactivity timeout (default 30 min), the
  watchdog stops the input the same way. After the watchdog's cancel,
  progress does not resume monitoring; if the input has not settled when the
  abort grace ends, the watchdog fail-stops the host
  ([stop routes](antigravity-events.md#stopping-an-input)).

The deadline is the last safety net, not a scheduler: a background command
keeps its call open, so healthy work past the deadline is also cut with the
turn.

## kaoiro tools

- **Transport.** Each generation gets its own instance of the shared HTTP
  tool host of `@kaoiro/agent-common`, passed to `agy` as the `kaoiro` MCP
  server in `session/new` or `session/resume`, with a bearer minted for
  that instance. Listener, request checks and bearer handling are those of
  the shared tool host ([tool transport](grok-acp.md#tool-transport)). The
  host does not require `mcpCapabilities.http`. `agy` lists the tools before
  the attach response. It also sends two unauthenticated discovery `GET`s;
  when they are refused with 401 it continues (measured with a stub that
  applies the same checks).
- **Readiness.** The start waits up to 15 s for an authenticated
  `tools/list`, else it fails with `kaoiro MCP server did not connect`.
- **Gate.** A registered tool's hook request (`mcp_kaoiro_<name>`) is
  allowed without a dialog in every cell.
- **Signals.** A handler gets a signal that aborts when its HTTP request
  ends or the prompt's window closes; a call made while no window is open
  gets an already aborted signal. A `send_to_agent` result whose signal
  aborted is discarded as stale. The tool host closes when the generation is
  retired, aborting calls in flight, and a later request with that bearer
  is refused.
- **Operator-interactive tools.** `ask_user_question` opens a question
  dialog through the question broker (`waiting_question`).
  `request_session_reset` and `request_peer_session_reset` ask for approval
  through the permission broker (`operatorApprovalGated`), shown as
  `mcp__kaoiro__request_session_reset` and
  `mcp__kaoiro__request_peer_session_reset` (`waiting_permission`). Each
  wait closes when the call's signal aborts, and an approval that arrives
  after that reserves nothing.
- **The 180 s MCP limit.** `agy` aborts the HTTP request of a `tools/call`
  held for 180 s and sends `notifications/cancelled`; the call fails and the
  model sees a timeout (measured with a stub tool, not the real tool host).
  The aborted request aborts the handler's signal, so a question or approval
  closes at the cut, and at the latest when the turn's window closes.
  `notifications/cancelled` arrives as a separate stateless request and
  does not by itself abort the held call.
- **Session reset.** A reset reserved through `request_session_reset` is
  bound to the turn whose window was open; it is carried out only when that
  turn ends with a prompt response from `agy` and no interrupt, and any
  other end cancels it with a notice to the agent
  ([session tools](../inter-agent/session-tools.md#request_session_reset-phase-28-c2)).

## Retirement and command cleanup

- When an input settles, its generation is retired: the tool host closes
  (aborting calls in flight), the gate socket closes (a pending hook fails
  closed in its client), the hook-list probe stops and the child is ended
  through its process group ([stop routes](antigravity-events.md#stopping-an-input)).
  Tool updates that still arrive from it are checked by
  [call verification](#call-verification-and-gate-faults) and never
  projected.
- Work left when the input settles does not carry into another turn through
  the process, since no process is reused. A background command still
  running is ended by the process-group signals; nothing tracks descendants
  outside the group.
- With `--sandbox`, no command was left after SIGTERM with grace or after
  SIGKILL, and a cancel removed a promoted command (measured once per
  route). Commands run outside the sandbox can outlive `agy`
  ([known limitations](#known-limitations)).
- A subagent runs inside `agy`'s process, so its work ends with the
  generation (inferred).

## Known limitations

- **Commands outside the sandbox can outlive `agy`.** This covers every
  command under `danger-full-access` and an approved `run_command` with
  `BypassSandbox: true` under `workspace-write`. Without `--sandbox` a
  background command survived SIGTERM, and foreground and background
  commands survived SIGKILL to the process group; an approved bypass's
  background command survived SIGTERM of the group with grace (measured,
  one run each). An approved bypass under SIGKILL or cancel is not measured.
  This is accepted as is.
- **Holding a prompt for background work** (the Stop answer):
  - The hold ends after 10 continuations or when the model stops waiting.
    While waiting the model polls `manage_task status`; in one run it killed
    the task and the output was lost. Output that arrives after the prompt
    settled is lost: `agy` re-invokes the model outside any prompt, which is
    recorded, not projected, and the process is retired.
  - A timer the model scheduled kept `fullyIdle` false while it was pending
    (measured; inferred to be the only pending task), so it can hold the
    prompt up to the cap.
  - A Stop hook that fails or times out ends `agy`'s loop, and with it the
    hold.
  - Commands longer than a few minutes are not measured. The per-tool
    deadline still ends the turn while the command's call is open.
  - Held prompts used 126k to 286k tokens per prompt (5 runs) against 17.8k
    for the same prompt without the hook; the extra tokens are not metered.
- **Another Stop hook.** `agy` runs every enabled Stop hook it finds (the
  workspace's `.agents/hooks.json`, its global hook configuration, plugins
  with a manifest), and another Stop's `continue` overrides kaoiro's answer
  (measured). The start is refused while the hook list shows one. A Stop
  hook added after the list and before the spawn is not listed but is run
  (measured once); the check cannot see it.
- **Sandbox paths not measured.** Under `--sandbox
  --dangerously-skip-permissions`, a sandboxed `run_command` wrote to the
  cwd, the customization directory, the system temporary directory, the
  user's cache directory and another directory in the home, and reached
  HTTPS through `agy`'s proxy; the SSH directory was hidden, raw TCP failed,
  and a seccomp filter was set (one run per case). Not measured: the user's
  configuration directory and other sensitive paths, the proxy's rules,
  `agy`'s other modes, and an approved bypass under SIGKILL or cancel. The
  cells above do not rely on these paths.
- **Subagents.**
  - Waiting for a subagent is bounded like any background work by the
    Stop answer. The parent model may report before the subagent has, or
    stop it (measured).
  - `invoke_subagent` and `manage_subagents` follow the subagent row, which
    uses the shell column.
  - The parent may read a subagent's transcript under `agy`'s home
    (measured).
  - A subagent's work ends with its generation (inferred); a command it
    started outside the sandbox is covered by the first item.
  - The write targets of `invoke_subagent` with `Workspace` `branch` or
    `share` are not measured; the call follows the same row.
  - A call that neither goes through the hook nor appears in ACP cannot be
    found by call verification, which joins a hook to an ACP call. Calls
    inside a subagent have no ACP call to join.

## Constraints

- Every approval decision is made by the wrapper's hook gate; `agy`'s own
  prompts are off. The gate fails closed on a socket failure, a timeout or a
  malformed payload.
- The permission substrate is the per-process flag
  `--dangerously-skip-permissions`; the host-wide `toolPermission` setting
  is not used.
- The sandbox axis is advisory for this engine: `--sandbox` is passed, but
  the gate's cells are the enforcement, and the envelope says so.
- When permission-sync negotiation succeeds and the runner supplies all
  three launch ceilings, the wrapper advertises `supports_permission_switch`
  with sandbox, network-access and approval maxima. An accepted
  `set_permission` takes effect with the next input's generation, and the
  wrapper rejects an over-ceiling value again
  ([permission switch evidence](antigravity-events.md#permission-switch-evidence)).
  This does not make sandbox enforcement non-advisory.
- Resume checks for `reset_session` and `switch_session` compare effective
  network access on both sides. `danger-full-access` makes the effective
  value `true`, `read-only` makes it `false`, and `workspace-write` follows
  the configured network value. The ceiling uses the same mapping with its
  `max_sandbox` and raw `max_network_access`. Stored and relayed `max_*`
  values remain raw; spawn validation also checks raw launch values.
- **Troubleshooting: a session reset (`/new` / `/clear`) refused with
  `permission_ceiling_conflict`** means the agent's current live permission
  on the named axis is wider than the immutable ceiling pinned at its
  launch. The dashboard names the axis, its current value and the ceiling.
  Narrow that axis through the normal permission picker (`set_permission`),
  then retry the reset
  ([issue #397](https://github.com/sakuraiyuta/kaoiro/issues/397)). If both
  `sandbox` and `network_access` conflict while the current sandbox is
  `danger-full-access`, narrow `sandbox` first: that sandbox fixes effective
  network access to `true`, so changing `network_access` alone cannot lower
  it.

For permission synchronization deadlines and failed-input recovery, see
[permission state](../protocol/permission-state.md#synchronization-failure-visibility).
