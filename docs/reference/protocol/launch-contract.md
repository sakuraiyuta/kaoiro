---
title: Launch contract between the runner and a wrapper
description: How the runner finds, starts, configures, supervises and stops a wrapper process ("contract 1"), the engine-specific work the runner does outside that contract, and the paths a wrapper hands to its engine.
status: accepted
last_updated: 2026-11-20
related: [protocol, architecture]
---

# Launch contract between the runner and a wrapper

The runner starts one wrapper process per agent. This page states the
contract between the two processes. The page calls this shape
**contract 1**. No version field carries it: the bundled wrappers always run
from the same release as the runner. The decisions about this contract are in
[ADR-0075](../../adr/0075-runner-engine-launch-contract.md), and the single
entry and the `run` verb in
[ADR-0076](../../adr/0076-single-kaoiro-entry-point.md). The rest of stage 1 of
[issue #140](https://github.com/sakuraiyuta/kaoiro/issues/140) changes the
paths in the last section.

The `runner:<host_id>` messages that trigger a launch are in
[Runner control and launch](runner-control.md). The fields of the launch
file are in [Wrapper configuration](../configuration/wrapper.md).

## Contract 1

| Element | Contract |
|---|---|
| Finding the wrapper | The runner starts the kaoiro entry it was itself started from. The path is the real path of that entry, taken from the entry module's `import.meta.url` when the process starts and kept for the runner's lifetime, so a later move of the `current` link does not change which release a wrapper comes from. One table (`runner/src/engines.ts`) maps the four engine names (`claude-code`, `codex`, `antigravity`, `grok`) to their verbs and the wrapper module each verb imports. A checkout runs the same entry. |
| Command | For each bundled engine the runner resolves a command vector consisting of its own Node binary (`process.execPath`), its unfiltered Node options (`process.execArgv`), the registered entry, `wrapper`, and the engine name. The production shim gives node no options. The child is not detached, so it stays in the runner's process group. |
| Arguments | The launcher appends `run <launch file>` to the resolved command. The initial prompt and the resume target are fields of the launch file. The entry exits 64 on an unknown engine or verb, and the wrapper on any other argument shape, in both cases before the wrapper connects. |
| Launch file | One JSON file per launch, `<agent_id>-<n>.json`, written with mode 0600 into a temporary directory that the runner creates once with `mkdtemp` (`kaoiro-runner-*`). It holds one flat `WrapperConfig`, with engine-specific fields mixed in, including the wrapper's own `server_token` and the `transition_id` of the launch. The runner adds `recovery_checkpoint_path`, `resume_session_id` when the launch continues a session, and `initial_prompt` only on the launch that a `spawn` starts (no relaunch carries it again), and for Codex only creates a private `codex-tool-*` directory and sets `codex_tool_home`; for the other engines it removes that field. |
| Environment | The child inherits the runner's whole environment, with one change: `CODEX_HOME` is removed for every engine except Codex. The runner's own credential variables (`KAOIRO_RUNNER_TOKEN`, `KAOIRO_RUNNER_TOKENS`, `KAOIRO_LAUNCHER_RUNNER_TOKENS`) are not inherited, because the runner deletes them from its own environment right after it reads its token at startup, before any child starts. |
| Working directory | The `cwd` of the `spawn`, which must be an exact member of the host's `cwd_allowlist`; otherwise the spawn fails with `cwd_not_found` and nothing starts. Each wrapper takes its workspace from `process.cwd()`. |
| Readiness | There is no readiness signal towards the runner. The runner sends `spawn_result` with `ok: true` as soon as its launch call returns without throwing; it does not wait for the wrapper. The wrapper is ready when it joins `wrapper:<agent_id>` with the `transition_id` from its launch file, and the server confirms the connection by that id. |
| Recovery checkpoint | Before the child starts, the runner writes `{ "version": 1, "state": "initial" }` to `<launch file>.recovery`. The wrapper then keeps the record there in the states `unbound`, `live` and `blocked`, each write going through `<path>.tmp` and a rename, with mode 0600. When the child exits, the runner reads the record and selects the next launch from it, as described in [Wrapper-exit session recovery](runner-control.md#wrapper-exit-session-recovery). |
| Exit codes and relaunch | Exit code 79 means that the wrapper could not write its checkpoint. After an unexpected exit the runner runs recovery selection before anything else. Selection refuses automatic recovery on exit code 79, on a checkpoint that is unreadable, invalid or `blocked`, and when the session it would resume is already owned by another agent; the agent is then removed, whatever the exit code. Only an exit that selection allows counts against the relaunch budget of five relaunches per 60-second window; an exit that arrives more than 60 seconds after the window started opens a new window. Past the budget the agent is left down. A deliberate cycle (`restart`, session switch, session reset) resets the budget. |
| Stopping | `stop`, `restart`, session switch and runner shutdown send SIGTERM and do not escalate. Only a session reset escalates: SIGTERM, then SIGKILL after 5 seconds, and if no exit follows within another 5 seconds the reset reports `timeout` and the old wrapper stays supervised. |
| Standard streams | Inherited from the runner. The runner never reads or parses them. |

The launch file, its checkpoint, the checkpoint's `.tmp` file and the Codex
tool directory are removed when the child exits or fails to spawn, after the
runner has read the final checkpoint. A launch that throws before the child
starts removes them at once. The temporary directory itself is removed when
the runner process exits, on a best-effort basis.

## Engine work the runner does outside contract 1

Besides starting the process, the runner itself knows each engine. These
responsibilities are not part of contract 1
([ADR-0075](../../adr/0075-runner-engine-launch-contract.md) D5).

| Responsibility | What the runner does today |
|---|---|
| In-process imports | Imports code from all four wrapper packages: model catalogs, the behaviour settings grammar, `agy` executable resolution, the Codex home check, and the Claude probe client. |
| Pre-launch checks | Refuses a Codex launch when `CODEX_HOME` is unusable, an Antigravity launch when the `agy` executable is no longer available, and an initial Antigravity launch whose permissions exceed the host's Antigravity ceiling. |
| Session existence | Answers "does this session exist" per engine. For Claude Code, Codex and Antigravity it reads the engine's native session store. For Grok it asks the engine over ACP (`session/list`, paged) and does not read Grok's files. |
| Engine probes | Runs `agy models`, `agy --version`, the Claude probe script and a Grok ACP `initialize` itself. |
| Catalog in the register | Builds the per-engine catalog entry of the runner's register message. |
| Release and deploy tooling | Carries update and rollback tooling for Codex state, and release verification requires each `node_modules/@kaoiro/<engine>/dist/cli.js`. |

## Paths a wrapper hands to its engine

Some wrappers give their engine a command that starts code from the wrapper
package. These commands are built from `selfCommand()`: the Node binary, its
options and the kaoiro entry that the wrapper process was started from,
followed by `wrapper <engine> <verb>`.

| Engine | Path handed over |
|---|---|
| Codex | The MCP server `kaoiro`: `command` and `args` are `selfCommand()` (`[process.execPath, ...process.execArgv, entryPath]`) followed by `wrapper`, `codex`, `bridge`; `command` is the first item and `args` the rest. The socket is passed in `KAOIRO_BRIDGE_SOCKET`. |
| Antigravity | The PreToolUse hook command `<node> ['<execArg>' ...] '<entry>' wrapper antigravity hook`, and instructions to run `<node> ['<execArg>' ...] '<entry>' wrapper antigravity bridge list` or `call <tool> <payload>`, built by one helper (`antigravitySubcommandPrefix`) from `selfCommand()` (`[process.execPath, ...process.execArgv, entryPath]`). Each `execArgv` item (if any) and `<entry>` are unconditionally shell single-quoted (`'` escaped as `'\''`). The wrapper checks hook registration by matching that exact hook command string. The gate builds its bridge regex from the same helper, canonicalising only `<node>` and `<entry>` as paths while preserving and regex-escaping `execArgv`. The runner dispatches `antigravity hook` / `bridge` to exported functions, where `bridge` validates its argument count after the entry and subcommand dispatch (`list`: 1 trailing arg; `call <tool> <payload>`: 3 trailing args); no standalone script existence check is performed. |
| Claude Code | None to the engine. The runner and the Claude wrapper, through the probe client, start `<entry> wrapper claude-code probe` with the command of contract 1. |
| Grok | None. The wrapper serves an HTTP MCP endpoint on loopback and hands its URL to Grok. |

## Related

- [Runner control and launch](runner-control.md).
- [Wrapper configuration](../configuration/wrapper.md).
- [ADR-0075](../../adr/0075-runner-engine-launch-contract.md).

### Configured commands

The runner invokes a configured argv followed by `describe` from the config
file's directory. Return one UTF-8 JSON object on stdout and exit zero within
2 seconds. The runner limits stdout to 16,384 raw bytes and ignores stderr.
Discovery uses a private process group. On timeout, overflow or shutdown the
runner sends TERM, allows one second, sends KILL if needed, and allows one
more second for cleanup. Do not leave background processes.

```json
{"version":1,"id":"sample-engine","models":[],"operations":{"version":1,"spawn":true}}
```

The four top-level keys are required. The ID must match the configured row.
Operations require version 1 and spawn true. The only other keys are
`resume`, `enumerate_sessions` and `refresh_engine_catalog`, each absent or
false. Provide up to 32 models with unique nonempty `value` and nonempty
`display_name` (256 UTF-8 bytes each). Optional `effort_levels` contains
1–16 distinct nonempty strings of up to 64 bytes. Optional `default_effort`
must occur in this model's levels. Unknown keys invalidate the declaration.

Launch appends `run` and the private launch-file path to the same fixed
argv, with the selected working directory. Neither verb receives the
runner credential variables or CODEX_HOME. The file supplies the dedicated
wrapper token and transition ID. The ordinary wrapper join, recovery
checkpoint and turn contracts apply. A disconnected agent without a stored
session ID may fresh-restore under the same agent ID. Only the selected
model/effort pairs and their sources can be reapplied. A stored session ID
requires resume support. Install the receiving server and dashboard before
enabling external engines. To roll back, stop the external agents, remove
their configuration and restart the runner before reverting the server.
