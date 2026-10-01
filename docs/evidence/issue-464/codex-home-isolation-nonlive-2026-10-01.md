---
title: "Issue 464 Codex home isolation: non-live implementation evidence"
status: recorded
last_updated: 2026-10-01
---

# Codex home isolation: non-live implementation evidence

Tracking: [issue #464](https://github.com/sakuraiyuta/kaoiro/issues/464).
Design: [issue-464-codex-home-tool-isolation.md](../../plans/issue-464-codex-home-tool-isolation.md).
Writer: Fuji. Baseline: `a070b22c`. Code commit: `079888c67091c77b4c92347ab9cce11e90e80cfc`.
No test command received the production `CODEX_HOME`. Deliberate Codex-home
fixtures used disposable directories; no production credential was copied.

## Child-process inventory

A TypeScript import/call scan of `runner/test` and `wrapper/*/test` found 57 direct
`node:child_process` call sites at baseline and 58 after implementation. The
one added direct call is the bounded-spawn test. Manual review added two
`promisify(execFile)` call sites at baseline and three after implementation
(the new Vitest preflight test), plus four spawns embedded in generated
fixture scripts on both sides: **63 sites before, 65 after**. SDK callback
aliases and dynamic imports were inspected with their callers. Import-only
type references and mocked `child_process` imports create no child. The table
records each after-site; `guarded Vitest env` means the package preflight
requires the suite to start with `CODEX_HOME` unset. It is not a substitute
for the explicit production boundary.

| Site | Executable | Environment source | Disposition |
| --- | --- | --- | --- |
| `runner/test/buildIdentityScript.test.ts:28` | `"git"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:112` | `"git"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:185` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:221` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:243` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:261` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:289` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:305` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:316` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:346` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:359` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/buildIdentityScript.test.ts:371` | `"node"` | inherits guarded Vitest env | git or build-identity script only |
| `runner/test/cli-entrypoint.test.ts:17` | `process.execPath` | inherits guarded Vitest env | runner version/build only; no agent launch |
| `runner/test/cli-entrypoint.test.ts:28` | `"pnpm"` | inherits guarded Vitest env | runner version/build only; no agent launch |
| `runner/test/codex_app_server_supervision.test.ts:45` | `Node fake app-server` | inherits explicit scratch home from wrapper | fixture cannot invoke native Codex |
| `runner/test/codex_app_server_supervision.test.ts:60` | `process.execPath` | explicit disposable home | Codex fixture only; native cases deferred |
| `runner/test/launchShimVersion.test.ts:92` | `join(tmpDir, "deploy", "kaoiro-runner-launch.sh")` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `runner/test/launchShimVersion.test.ts:116` | `join(tmpDir!, "deploy", "kaoiro-runner-launch.sh")` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `runner/test/releaseBootstrap.test.ts:233` | `"sh"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseFixture.ts:109` | `script` | merged map removes CODEX_HOME by default | explicit disposable override remains possible |
| `runner/test/releaseFixture.ts:333` | `process.execPath` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseFixture.ts:450` | `"tar"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:165` | `process.execPath` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:170` | `"tar"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:193` | `process.execPath` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:198` | `"tar"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:219` | `process.execPath` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:224` | `"tar"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseInstall.test.ts:513` | `"tar"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseSwitch.test.ts:338` | `"/bin/sh"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `runner/test/releaseUpdate.test.ts:331` | `"sh"` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `runner/test/releaseUpdate.test.ts:760` | `"sh"` | inherits guarded Vitest env | release shell/build/tar fixture; no agent tool |
| `wrapper/antigravity/test/bridge.test.ts:9` | `process.execPath` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `wrapper/antigravity/test/cli-path.test.ts:69` | `resolved.path` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/cli.test.ts:54` | `process.execPath` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `wrapper/antigravity/test/cli.test.ts:402` | `"ssh-agent"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/cli.test.ts:410` | `"ssh-agent"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/cli_sigterm_subtree_termination.test.ts:98` | `Node grandchild` | inherits sanitized AG child env | fixture only |
| `wrapper/antigravity/test/gate.test.ts:268` | `"git"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/gate.test.ts:278` | `"git"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/gate.test.ts:279` | `"git"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/gate.test.ts:282` | `"git"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/gate.test.ts:285` | `"git"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/hook.test.ts:33` | `process.execPath` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `wrapper/antigravity/test/live_agy_stream_input.test.ts:108` | `command` | options.env from AG host | host strips CODEX_HOME; live AG fixture deferred |
| `wrapper/antigravity/test/ssh_agent_probe.test.ts:57` | `"ssh-agent"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/ssh_agent_probe.test.ts:66` | `"ssh-agent"` | inherits guarded Vitest env | fake AG, git, ssh-agent, or Node fixture; no Codex CLI |
| `wrapper/antigravity/test/subtree_termination_real_process.test.ts:107` | `Node grandchild` | inherits sanitized AG child env | fixture only |
| `wrapper/antigravity/test/subtree_termination_real_process.test.ts:188` | `command` | options.env from AG host | host strips CODEX_HOME; live AG fixture deferred |
| `wrapper/antigravity/test/tool_prompt_fail_fast.test.ts:43` | `tool shim` | inherits guarded Vitest env | fake tool command, no Codex CLI |
| `wrapper/claude-code/test/bounded_spawn.test.ts:16` | `options.command` | options.env from bounded spawner | bounded spawner strips CODEX_HOME |
| `wrapper/claude-code/test/bounded_spawn.test.ts:50` | `process.execPath` | inherits guarded Vitest env | Node fixture; no Codex CLI |
| `wrapper/claude-code/test/cli_sigterm_abort_real_process.test.ts:303` | `spawnOptions.command` | spawnOptions.env from SDK callback | host filters, callback forwards unchanged |
| `wrapper/claude-code/test/cli_sigterm_process_exit.test.ts:148` | `tsxBin` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `wrapper/claude-code/test/cli_sigterm_process_exit.test.ts:213` | `tsxBin` | inherited map with CODEX_HOME removed | fixture cannot select production Codex home |
| `wrapper/codex/test/cli_sigterm_exec_real_process.integration.test.ts:59` | `ps -eo pid,ppid,args` | inherits guarded Vitest env | process listing only; no Codex CLI |
| `wrapper/codex/test/cli_sigterm_exec_real_process.integration.test.ts:239` | `command` | inherits guarded Vitest env | unshare diagnostic, no Codex state |
| `wrapper/codex/test/cli_sigterm_exec_real_process.integration.test.ts:259` | `process.execPath` | explicit disposable home | Codex fixture only; native cases deferred |
| `wrapper/codex/test/cli_sigterm_process_exit.integration.test.ts:59` | `ps -eo pid,ppid,args` | inherits guarded Vitest env | process listing only; no Codex CLI |
| `wrapper/codex/test/cli_sigterm_process_exit.integration.test.ts:74` | `process.execPath` | explicit disposable home | Codex fixture only; native cases deferred |
| `wrapper/codex/test/cli_sigterm_process_exit.integration.test.ts:81` | `"ps -eo pid,ppid,args"` | inherits guarded Vitest env | process listing only; no Codex CLI |
| `wrapper/codex/test/cli_sigterm_process_exit.integration.test.ts:212` | `process.execPath` | inherits guarded Vitest env | process listing only; no Codex CLI |
| `wrapper/codex/test/codex_home_preflight.test.ts:17` | `pnpm nested Vitest` | explicit disposable hostile home | guard rejects before test body |
| `wrapper/codex/test/permission_compaction.test.ts:40` | `Node compiled rollout reader` | child map deletes CODEX_HOME; HOME disposable | canary remains empty |
| `wrapper/codex/test/stderr_production_default.test.ts:50` | `Node + native Codex` | explicit disposable home | native test deferred |

Production call-path audit: `runner/src/spawn.ts:152` passes an explicit
environment to each built wrapper and retains the state home only for Codex.
`runner/src/codex-auth.ts:15` invokes the Codex doctor against the state home
by design; the runner session reader keeps the same state home.
`wrapper/codex/src/app_server_rpc.ts:114` and the SDK child spawned from
`wrapper/codex/src/host.ts` retain it for auth and resume, while the exec
config and both app-server thread-open RPCs receive the private tool home.
`wrapper/claude-code/src/host.ts:2493`, `bounded_spawn.ts:23`, and
`probe-client.ts:89` remove it before the SDK and probe children.
`wrapper/antigravity/src/host.ts:1808,2029,2098,2205` removes it from
turn, gate-probe, and model-probe children; `ssh_agent_probe.ts:31` removes
it from `ssh-add`. The runner’s AG catalog/version probes are not agent
tools and do not launch Codex; they inherit the runner environment.

## Verification

All commands below were invoked with `env -u CODEX_HOME` unless an isolated
negative-control child deliberately received a disposable canary.

| Gate | Cases | Exit |
| --- | ---: | ---: |
| Runner full suite | 795 | 0 |
| Wrapper core full suite | 308 | 0 |
| Agent common full suite | 499 | 0 |
| Antigravity full suite | 407 passed, 2 skipped | 0 |
| Claude Code full suite | 764 | 0 |
| Codex non-live suite (`--exclude **/*.integration.test.ts --exclude test/stderr_production_default.test.ts`) | 1176 | 0 |
| Dashboard full suite | 1075 | 0 |
| Workspace typecheck (7 packages) | 7 packages | 0 |
| Workspace build (6 packages; protocol is type-only) | 6 packages | 0 |
| Dashboard Svelte check | 0 errors, 0 warnings | 0 |

The Codex native integration suite and the default-production SDK test are
deferred under the no-live-turn instruction. The final 0.159.x pin needs
fresh and resumed real app-server shell-tool probes, auth/session/hook
verification, and the full native suite before deployment. A broad
`--exclude **/*.integration.test.ts` run was interrupted (exit 130) after
discovering the unsuffixed native test; its partial results are not counted.
Every executed process received `CODEX_HOME` unset or an isolated scratch
home. The broad run may have reached that test before interruption; it has
no production-home path.

## Negative controls

For each row below, only the named guard was removed in the worktree, the
corresponding targeted Vitest command exited 1 with a failed assertion, the
original bytes were restored, and the same command exited 0. No mutation
was committed. Mutation command output is summarized here; the disposable
command runner was removed after recording the result.

| Removed guard or wiring | Mutated exit | Restored exit |
| --- | ---: | ---: |
| `runner_child_strip` | 1 | 0 |
| `runner_owned_home` | 1 | 0 |
| `runner_home_cleanup` | 1 | 0 |
| `codex_exec_policy` | 1 | 0 |
| `codex_app_policy` | 1 | 0 |
| `codex_realpath` | 1 | 0 |
| `codex_fixture` | 1 | 0 |
| `claude_sdk_options` | 1 | 0 |
| `claude_bounded_spawn` | 1 | 0 |
| `claude_probe` | 1 | 0 |
| `agy_turn_child` | 1 | 0 |
| `agy_probe_children` | 1 | 0 |
| `agy_ssh_probe` | 1 | 0 |
| `vitest_shared_guard` | 1 | 0 |
| `vitest_dashboard_wiring` | 1 | 0 |
| `codex_tool_home` parser branch | 1 | 0 |

The preflight control was checked separately: with the shared guard
disconnected, the nested Vitest invocation reported **1 passed**, wrote its
execution marker, and left the disposable canary empty (exit 0). With the
guard connected, the parent test observed a nonzero startup failure, zero
executed cases, no marker, and an unchanged canary. The rollout fixture
also kept its hostile scratch canary empty; removing its child-env filter
failed all three targeted fixture cases.

## Remaining release gate

The final pin is not in this branch. A native `thread/resume` response may
accept the RPC while ignoring the tool-home policy; the mocked RPC test can
prove forwarding and rejection-before-turn only. Deployment must remain
blocked until the final-pin tool shell itself reports its newly created
private home B after resuming a thread created with home A, and auth,
session storage, and model-profile hooks still resolve from the state home.
Already-running peers need a controlled restart to receive the new boundary.
