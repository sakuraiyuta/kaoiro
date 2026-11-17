---
title: Launch contract between the runner and a wrapper
description: How the runner finds, starts, configures, supervises and stops a wrapper process ("contract 1"), the engine-specific work the runner does outside that contract, and the paths a wrapper hands to its engine.
status: accepted
last_updated: 2026-11-18
related: [protocol, architecture]
---

# Launch contract between the runner and a wrapper

The runner starts one wrapper process per agent. This page states the
contract between the two processes as it behaves on `develop` at
`fda95f95`. The page calls this shape **contract 1**. No version field
carries it: the bundled wrappers always run from the same release as the
runner. The decisions about this contract, including the changes planned for
[issue #140](https://github.com/sakuraiyuta/kaoiro/issues/140), are in
[ADR-0074](../../adr/0074-runner-engine-launch-contract.md).

The `runner:<host_id>` messages that trigger a launch are in
[Runner control and launch](runner-control.md). The fields of the launch
file are in [Wrapper configuration](../configuration/wrapper.md).

## Contract 1

| Element | Contract |
|---|---|
| Finding the wrapper | A fixed table maps the four engine names (`claude-code`, `codex`, `antigravity`, `grok`) to the packages `@kaoiro/<engine>`. The entry is `require.resolve("@kaoiro/<engine>/dist/cli.js")`, resolved from the runner's own module the first time that engine is launched and kept for the runner's lifetime. When `KAOIRO_WRAPPER_DEV` is set, the entry is instead `tsx watch <package>/src/cli.ts`, run through the `tsx` binary. |
| Command | Always the runner's own Node binary (`process.execPath`). The child is not detached, so it stays in the runner's process group. |
| Arguments | `<entry> <launch file> [initial prompt] [--resume <session id>]`. The runner emits the prompt, when there is one, before `--resume`. The wrapper's parser reads the positionals and the `--resume` option separately and does not check their order. The initial prompt is passed only on the launch that a `spawn` starts; no relaunch passes it again. |
| Launch file | One JSON file per launch, `<agent_id>-<n>.json`, written with mode 0600 into a temporary directory that the runner creates once with `mkdtemp` (`kaoiro-runner-*`). It holds one flat `WrapperConfig`, with engine-specific fields mixed in, including the wrapper's own `server_token` and the `transition_id` of the launch. The runner adds `recovery_checkpoint_path`, and for Codex only creates a private `codex-tool-*` directory and sets `codex_tool_home`; for the other engines it removes that field. |
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
([ADR-0074](../../adr/0074-runner-engine-launch-contract.md) D5).

| Responsibility | What the runner does today |
|---|---|
| In-process imports | Imports code from all four wrapper packages: model catalogs, the behaviour settings grammar, `agy` executable resolution, the Codex home check, and the Claude probe client. |
| Pre-launch checks | Refuses a Codex launch when `CODEX_HOME` is unusable, an Antigravity launch when the `agy` executable is no longer available, and an initial Antigravity launch whose permissions exceed the host's Antigravity ceiling. |
| Session existence | Answers "does this session exist" per engine. For Claude Code, Codex and Antigravity it reads the engine's native session store. For Grok it asks the engine over ACP (`session/list`, paged) and does not read Grok's files. |
| Engine probes | Runs `codex doctor`, `agy models`, `agy --version`, the Claude probe script and a Grok ACP `initialize` itself. |
| Catalog in the register | Builds the per-engine catalog entry of the runner's register message. |
| Release and deploy tooling | Carries update and rollback tooling for Codex state, and release verification requires each `node_modules/@kaoiro/<engine>/dist/cli.js`. |

## Paths a wrapper hands to its engine

Some wrappers give their engine a command that starts code from the wrapper
package. These commands are built from the location of the wrapper's own
files.

| Engine | Path handed over |
|---|---|
| Codex | The MCP server `kaoiro`: `command` is `process.execPath`, `args` is `[<@kaoiro/codex>/dist/bridge.js]`, and the socket is passed in `KAOIRO_BRIDGE_SOCKET`. |
| Antigravity | The PreToolUse hook command `<node> <@kaoiro/antigravity>/dist/hook.js`, and instructions to run `<node> <@kaoiro/antigravity>/dist/bridge.js list` or `call <tool> <payload>`. `<node>` is the wrapper's `process.execPath`. The wrapper checks the hook registration by matching that exact command string. The same strings are used by the check that both scripts exist, by the gate's regular expression that lets a bridge call through, and by the bridge's own argument count check. |
| Claude Code | None to the engine. The runner, through the imported probe client, starts `<@kaoiro/claude-code>/dist/probe.js` with `process.execPath`. |
| Grok | None. The wrapper serves an HTTP MCP endpoint on loopback and hands its URL to Grok. |

## Related

- [Runner control and launch](runner-control.md).
- [Wrapper configuration](../configuration/wrapper.md).
- [ADR-0074](../../adr/0074-runner-engine-launch-contract.md).
