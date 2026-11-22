---
title: Antigravity 1.5.10 ACP investigation
status: measured
last_updated: 2026-11-23
---

# Antigravity 1.5.10 ACP investigation

The first look at `agy acp`, on 2026-11-18, before the design of
[issue #1238](https://github.com/sakuraiyuta/kaoiro/issues/1238). It was
reported in
[issue #1181](https://github.com/sakuraiyuta/kaoiro/issues/1181#issuecomment-6969231322);
this page keeps that record. The measurements that the design relies on were
repeated with `agy` 1.5.14 and are in
[the 1.5.14 measurements](agy-1.5.14-acp-measurements-2026-11-22-setup-and-sessions.md).

## Conditions

The real `agy acp` (ACP protocol version 1, `agentInfo` "Antigravity ACP
Server" 1.5.10) was driven by a throwaway NDJSON client, with a stub MCP
server and a logging hook, signed in with cached credentials. 10
`session/prompt` requests, all with `claude-sonnet-5-5` at thinking level
`low`. No kaoiro source was changed. "Observed" means seen on the wire or on
disk in that run.

## Session lifecycle

- `initialize` succeeds with the cached credentials. Capabilities:
  `loadSession`, `sessionCapabilities` {`resume`, `close`, `load`, `list`,
  `additionalDirectories`}, `promptCapabilities` {`image`,
  `embeddedContext`}. `session/new` takes about 2 s (33 ms for a second
  session in the same process) and creates the conversation on disk
  immediately. There is no delete method; a reset is another `session/new`.
- A turn is `session/prompt` → `session/update` (`tool_call`,
  `tool_call_update`, `agent_thought_chunk`, `agent_message_chunk`,
  `usage_update`, `session_info_update`) → response `{stopReason, usage}`.
- `session/resume` from a new process keeps the context and the appended
  system prompt, but model, thinking level and mode fall back to the
  defaults and must be set again. `session/load` replays the history (user,
  tool, thought and agent updates). `session/list` ignores the `cwd` filter.

## Permission requests

- A request carries the tool name, `kind`, `rawInput` and two options only:
  allow once, reject once. For `run_command` the input is `CommandLine`,
  `WaitMsBeforeAsync`, `toolSummary`. The working directory is not visible:
  the tool has no such parameter and the model writes `(cd <dir> && …)`. The
  hook payload has the same arguments, so the `Cwd` rule behind
  [issue #1172](https://github.com/sakuraiyuta/kaoiro/issues/1172) cannot be
  rebuilt from arguments on ACP either.
- Rejecting a request ends the turn (`stopReason: end_turn`, no text,
  remaining steps not run). A PreToolUse hook `deny` instead returns the
  reason to the model and the turn continues.
- Hooks still run under ACP (`SessionStart`, `PreToolUse`, `PostToolUse`,
  `Stop`), and PreToolUse runs before the permission request. ACP requests
  cover only what `agy`'s own policy asks about: in the default mode, MCP
  tools, every command, and file access outside the workspace are asked;
  writes inside the workspace and under the system temp directory are not.
- With `--dangerously-skip-permissions` there are no requests at all, except
  when a hook answers `force_ask`.
- `--sandbox` has an OS effect: no network, directories outside the
  workspace are invisible to commands, and a request to leave the sandbox
  shows up as `rawInput.BypassSandbox: true`. In the default mode the
  workspace was read-only for commands; in `auto` mode it was writable and
  commands were not asked. File-writing tools are not sandboxed.
- Declaring client `fs` and `terminal` capabilities changes nothing: `agy`
  never called them.

## kaoiro tools without the bridge

- MCP servers passed in `session/new` or `session/resume` are connected
  before the first turn, over stdio or HTTP (the configured `Authorization`
  header arrives). HTTP worked without `--process-per-session`, but
  `mcpCapabilities.http` is advertised only with that flag.
- Tools are called natively as `mcp_<server>_<tool>` with structured
  arguments, and each call produces a permission request that names the
  tool.

## Streaming, interruption, model, rate limits, attachments

- Message and thought text arrive as small chunks.
- `session/cancel` during a command: the prompt returned `cancelled` within
  5 ms and the command's process group was gone 2.5 s later.
- A second `session/prompt` during a turn steers it: the first request
  returns `end_turn` at once and the turn continues under the second request.
- Model and thinking level are session config options (`model`,
  `thought_level`), switched in a few ms; the offered levels depend on the
  model. Claude and GPT-OSS models were offered to a client named
  `kaoiro-probe`, although the vendor docs say third-party models are offered
  only to a list of editors.
- No quota information on ACP: only context usage (`usage_update`) and token
  counts per prompt.
- Images reach the model. The text of an embedded `resource` does not; the
  model reads the URI from disk instead.
- The persona can be appended with `_meta.antigravity.systemPrompt.append`
  on `session/new`. The standard `systemPrompt` field is silently ignored.

## Re-checks on review

Two results were re-checked against the raw wire log: none of the 23
permission requests carries a working-directory argument, and the prompt
returned `end_turn` 4 ms after a `reject_once` answer.

## Not measured in this investigation

- Turns under `--process-per-session`; Gemini-family models; 429 and
  unauthenticated paths.
- `plan` and `accept-edits` modes; network, temp directory and bypass
  handling in `auto` mode; why the workspace is read-only for commands in
  the default mode with `--sandbox`.
- Workspace trust, `--add-dir` / `additionalDirectories`, background tasks
  after a turn or a cancel, long turns, process exit and recovery, several
  sessions in one process.
- Prompts that start with `/`, elicitation, hook decisions `ask` and
  `auto_approve`, self-update in `acp` mode.
