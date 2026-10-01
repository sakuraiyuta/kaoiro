---
title: Isolate the production Codex home from agent tool processes
status: proposed
last_updated: 2026-10-01
related: [issue-464, issue-454, issue-468]
---

# Isolate the production Codex home from agent tool processes

## Problem and measured baseline

[Issue #464](https://github.com/sakuraiyuta/kaoiro/issues/464) records three
accidental writes to the production Codex home on 2026-10-01. Its proposed
direction was a hypothesis; the observations below were made independently on
`develop` at `3f35d77f`. The issue had no comments when read. This plan changes
no production home, credentials, or running peer.

| Boundary | Measurement | Consequence |
| --- | --- | --- |
| Runner to wrapper | `makeLauncher()` in `runner/src/spawn.ts` calls Node `spawn` without `env`. A temporary `NODE_OPTIONS` preload on the real built launcher, with a disposable `CODEX_HOME`, observed `CODEX_HOME` in each of the three built wrapper entry points: Codex, Claude Code, and Antigravity. Each child was stopped through its own `ManagedChild` handle. | The runner's `runner.env` value reaches every wrapper, regardless of engine. |
| Codex tool | This Codex peer's actual tool shell reported `CODEX_HOME` present, with `codex` as its parent process. With the pinned 0.156.1 native binary (SHA-256 `0b2e9301d6100dddda3b9d5c80ebaeaa3a2f1962388f2f36f6b96a9f08b1f33f`), a local provider caused a real `exec` tool command to report `present` through both `codex exec` and `codex app-server`; both turns reached a final response. All CLI state lived in separate disposable homes and no account authentication was used. | Filtering only the runner's non-Codex children cannot protect Codex tool commands: the native CLI itself needs the state home. |
| Claude tool | Ao's Claude Code peer reported `CODEX_HOME` present from its actual Bash tool, with `claude` as the parent process and the variable present in that parent's environment (IA conversation `559b864e-af0b-4e59-a861-7af17c8f4361`, turn 2). Independently, the host passes SDK `SpawnOptions.env` to its bounded CLI spawner; the installed SDK type contract says omitted `Options.env` inherits `process.env`. The peer did not reveal the value or prove which ancestor introduced it. | Filter the final SDK child environment and verify the absent result after implementation. |
| Antigravity tool | Hiiro's Antigravity peer reported `CODEX_HOME` present in its actual `run_command` tool (IA conversation `891d018f-828a-4078-a6dc-1f0087ed1c51`, turn 2), without revealing the value. Independently, the host spreads `process.env` into the CLI launch and its default spawner passes that map to Node `spawn`. | Filter the Antigravity child environment and verify the absent result after implementation. |
| Reproduced fixture write | Under `env -u CODEX_HOME CODEX_HOME=<disposable home>`, `permission_compaction.test.ts` exited 1: three of seven cases failed because the child chose `<disposable home>/sessions` rather than its isolated `HOME/.codex/sessions`. Two rollout files appeared there, with SHA-256 `e94f9d9c…` and `348edf53…`, equal to the checked-in fixture manifest. Under `env -u CODEX_HOME`, all seven cases passed with exit 0. | A test-level leak exists independently of agent tool isolation. |

The native policy comparison also rules out a tempting implementation mistake.
On 0.156.1, `[shell_environment_policy] exclude = ["CODEX_HOME"]` removed the
variable from `exec` and app-server tool shells, while `"^CODEX_HOME$"` did not.
An upper-layer `exclude = ["CODEX_HOME"]` replaced a lower-layer exclusion of
`FUJI464_CANARY`: the tool then saw the canary. By contrast, setting only
`shell_environment_policy.set.CODEX_HOME` to a disposable path made the tool
see that path while retaining the lower-layer exclusion and a distinct
lower-layer `set` key. The app-server local-provider turn likewise saw the
disposable value and retained the other exclusion when the policy was in its
scratch config file. The app-server **per-thread override** and the eventual
0.159.x pin remain implementation gates, not measured conclusions here.

## Decision and boundaries

Use two process boundaries and one test boundary:

1. `runner/src/spawn.ts` must pass an explicit child environment for every
   wrapper. It removes `CODEX_HOME` for Claude Code and Antigravity. It retains
   the variable, unchanged, for Codex. The runner process itself retains it for
   launch validation and the resume scanner. If it was unset, do not invent a
   value. Use a fresh environment map, not a mutation of the runner's own
   `process.env`. This covers initial spawn, restart, reset, and resume because
   all use `makeLauncher()`.
2. Claude Code's final SDK `Options.env` must omit `CODEX_HOME`, including when
   a caller supplied `queryOptions.env`. If that option exists, filter *that*
   map; otherwise filter `process.env`. Do not merge in process variables that
   the caller deliberately omitted: the SDK's provided `env` replaces the
   subprocess environment. Antigravity must omit `CODEX_HOME` from its main
   CLI launch environment and from its other CLI probe spawns. These wrapper
   boundaries also protect direct wrapper launches outside the runner.
3. For each Codex child, `makeLauncher()` creates a private, empty tool home
   (mode 0700) under its existing private temporary root. It overwrites any
   inbound `codex_tool_home` with this path in the local 0600 wrapper config;
   this field is runner-owned, never a server or dashboard setting. A Codex
   wrapper started outside the runner creates its own private fallback home.
   Reject a missing, non-directory, or realpath-equal-to-state-home value
   before starting a turn. `CodexHost` injects only
   `shell_environment_policy.set.CODEX_HOME = <tool home>` into the native
   `codex exec` configuration and app-server `thread/start` configuration.
   Preserve all other shell policy fields, especially existing `exclude` and
   `set` entries. The runner removes the home on that child's exit or spawn
   error, after the native child and tool calls have stopped; standalone
   wrappers remove their own home on close. An abrupt runner death can leave
   its existing temporary root behind until host cleanup, so the native gate
   must report this residual. The tool home has no copied auth. A bare `codex`
   command inside an agent tool can write there or fail for lack of auth, but
   cannot select the production home by inheritance.
4. At the Vitest configuration boundary, fail before test files load whenever
   the suite inherits a nonempty `CODEX_HOME`. Apply one shared assertion from
   the runner, all wrapper test configurations, and the dashboard test
   configuration, including direct
   `pnpm exec vitest`, while leaving `vi.stubEnv("CODEX_HOME", <scratch>)`
   inside intentional tests available. A direct `CODEX_HOME=<path> pnpm test`
   is expected to exit nonzero without touching that path. Test-specific child
   processes must independently omit the inherited value or set a disposable
   one explicitly; the preflight is a last-resort stop, not their substitute.

The Codex wrapper and both native backends still receive the production
`CODEX_HOME`. The runner's session scan, wrapper rollout readers, auth,
`config.toml`, native session storage, and resume therefore retain their
current path contract. The tool policy changes only the environment given to
shell-like commands. The existing model-profile hooks depend on the native
CLI's home; their environment must be checked separately before deployment.
An agent can explicitly set `CODEX_HOME` in a command, so this is an accidental
state-isolation contract rather than a defense against a malicious agent.

Passing the home only to the Codex child was considered. On this baseline the
Codex wrapper itself reads rollouts and sidecars from `codexHome()`, while the
SDK exec child and app-server child have separate launch paths. Moving the
home to a private config field would require changing those readers and every
native probe path, then still applying a shell policy within the native CLI.
The measured `set` policy closes the agent-tool path without changing those
state and resume readers. A simple top-layer `exclude` was rejected because
the native comparison showed it erases an existing exclusion.

## Test and command audit

The source sweep covered `...process.env`, `env: process.env`, and implicit
environment inheritance in `runner/test`, `wrapper/*/test`, and the Codex
native probes. Implementation must repeat the sweep after edits.

| Test sites | Required handling |
| --- | --- |
| `wrapper/codex/test/permission_compaction.test.ts` | Remove `CODEX_HOME` from the child environment before setting the fixture `HOME`; keep the compiled production reader assertion. This is the reproduced writer. |
| `wrapper/codex/test/approval_config.integration.test.ts`, `cli_sigterm_process_exit.integration.test.ts`, `stderr_production_default.test.ts` | Retain their explicit disposable `CODEX_HOME` override; assert it wins over a hostile inherited value. The saved environment in `cli_operator_steer.test.ts` is restoration state, not a spawn. |
| `wrapper/codex/test/cli_sigterm_exec_real_process.integration.test.ts`, `cli_sigterm_process_exit.integration.test.ts` | Replace the diagnostic `codex --version` through `PATH` with the pinned absolute binary and an explicit disposable home; audit every other implicit-env native spawn. |
| `runner/test/codex_app_server_supervision.test.ts` | Keep the explicit disposable home. `launchShimVersion.test.ts`, `releaseFixture.ts`, and `releaseUpdate.test.ts` forward inherited environments to children or scripts; strip `CODEX_HOME` unless the fixture deliberately supplies its own disposable value. Audit `cli-entrypoint.test.ts` and other spawns without `env` as inheritance sites. |
| `wrapper/claude-code/test/bounded_spawn.test.ts`, `cli_sigterm_process_exit.test.ts`; `wrapper/antigravity/test/bridge.test.ts`, `cli.test.ts`, `hook.test.ts`, `ssh_agent_probe.test.ts` | Use a sanitized child map for inherited environments. Tests specifically checking environment forwarding must use a disposable `CODEX_HOME` and assert the new boundary removes it. The probe fixtures still keep required `PATH`, SSH, gate, and bridge values. |

Do not rely on a source-pattern scan alone: native SDKs, `execSync`, and
`spawn` without an `env` option inherit the test process environment. The
preflight protects the full suite while targeted tests pin the actual child
boundaries.

## Verification and release plan

- Use `env -u CODEX_HOME` on all development tests. Use only an absolute pinned
  Codex executable with an explicit disposable `CODEX_HOME` for native probes;
  never read or write the production home. Record the binary SHA and repeat
  the tool-policy probes on the final pin after issue #468 lands.
- With a disposable production-like home injected into a real built runner
  launcher, trace runner → wrapper → engine CLI → tool command for all three
  engines. Claude and Antigravity tool commands must see no `CODEX_HOME`;
  Codex tool commands must see only the private tool home under both exec and
  app-server. Assert the Codex native process itself selects the injected
  state home, including `auth.json` lookup, a written session, and a resumed
  session. Use local providers and isolated credentials where needed. A mock
  `spawn` argument alone is not sufficient evidence for the tool command.
- In the Codex native fixture, keep a separate pre-existing exclusion and
  `set` entry. Assert both survive the tool-home injection. Verify a
  production-equivalent model-profile hook still resolves from the native
  state home while the shell tool sees the tool home. Test normal close and
  forced-child-exit cleanup without signalling another agent's process.
- Run the complete runner, wrapper, protocol typecheck/build/test gates and
  the Codex native integration gates. Run `CODEX_HOME=<production-like
  disposable dir> pnpm test` in `wrapper/codex`: preflight must exit nonzero
  before any case and the directory manifest must remain unchanged. Run the
  full suite with `CODEX_HOME` unset and expect exit 0. For the targeted
  fixture, permit a disposable canary only in an isolated negative-control
  invocation; after the child-env repair it must leave the canary unchanged.
- Mutate one boundary at a time and require a red test: remove the runner's
  non-Codex strip (Claude/Antigravity tool sees the canary); remove Codex's
  tool-home `set` in each backend (a shell tool writes a marker into the
  production-like canary); remove the fixture's child-env filter (the two
  fixture rollouts appear in that canary); disconnect the Vitest preflight
  (its invocation no longer stops before tests). Also remove the runner's
  override of an inbound `codex_tool_home` and the wrapper's realpath
  inequality guard separately: a supplied path or symlink to the
  production-like canary must then make the corresponding test fail. Restore
  every mutation and
  repeat the corresponding positive test. Assert both invocation exit code
  and the canary manifest, not a warning line alone.
- Deploy the tested runner/wrappers together and restart existing peers in a
  controlled idle window; already-running wrappers retain their old
  environment and cannot satisfy this contract. Record no production paths or
  credentials in test output.

Update the [runner configuration reference](../reference/configuration/runner.md#codex-home),
[wrapper configuration reference](../reference/configuration/wrapper.md),
[Codex home runbook](../operations/codex-home.md), Codex
[exec](../reference/engines/codex-exec-events.md) and
[app-server](../reference/engines/codex-app-server.md) references, and
[deployment troubleshooting](../operations/deployment-troubleshooting.md).
Record the final-pin, path-redacted measurements under `docs/evidence/` and
update issue #464 when implementation lands.

Out of scope: changing the Codex pin (issue #468), changing auth or copying
credentials, repairing the three historical writes (already handled by the
operator), disabling shell tools, and protection against a deliberately
specified `CODEX_HOME` in an agent command. This design does not implement the
change; it awaits independent design review and implementation authorization.
