---
title: Test isolation
description: What a test may not reach on the host, how the shared isolation guard enforces it, and how to add a suite or an opt-in native probe.
status: accepted
last_updated: 2026-10-24
related: [runner-development]
---

# Test isolation

No test may reach the real user service manager, `gh`, `docker`, or the
outbound network ([issue #577](https://github.com/sakuraiyuta/kaoiro/issues/577)).
A test's own fake is not a safety boundary: when product code changes the
child `PATH` or environment, a fake can silently stop applying. The boundary
is the shared module
[`scripts/test/fixtures/test-isolation.mjs`](../../scripts/test/fixtures/test-isolation.mjs),
(an ES module facade over the CommonJS implementation
[`test-isolation.cjs`](../../scripts/test/fixtures/test-isolation.cjs)),
and [`scripts/test-isolation/check.mjs`](../../scripts/test-isolation/check.mjs)
makes loading it mandatory.

## Where tests run

| Place | Host surfaces present | Role of the guard |
|---|---|---|
| Disposable test container (no network, no systemd, no `gh`/`docker`) | none | Keeps suites behaving the same; the place to run negative controls with the guard removed |
| Developer or agent host, CI runner, contributor machine | user manager, logged-in tools, network | The safety boundary |

## Layers

| Layer | Applies to | What it does |
|---|---|---|
| L1a root environment | the first test process | Removes `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `DOCKER_CONTEXT`. Points `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `DOCKER_HOST`, `DOCKER_CONFIG`, `GH_CONFIG_DIR` at a fresh owned directory |
| L1b spawn boundary | every `child_process` call | After product code has built `options.env`, replaces any of those pointers that is missing or not owned, removes `DOCKER_CONTEXT` unless `DOCKER_CONFIG` is owned, and adds the guard's preload to `NODE_OPTIONS` together with the internal child marker. Reaches non-Node descendants through the environment |
| L2 commands | Node processes | `systemctl`, `systemd-run`, `busctl`, `journalctl`, `loginctl`, `gh`, `docker` run only from an owned root. Otherwise they are refused with `ERR_TEST_HOST_SYSTEMD` or `ERR_TEST_HOST_TOOL`, including through `PATH`, symlinks, shells and launchers. A direct spawn is resolved as the child's `execvp` does: from the child's `PATH` (or `/usr/bin:/bin`) and its cwd, so relative and empty `PATH` elements count from there. A shell or launcher resolves its words again after it may have changed `PATH` or its cwd, so there the systemd tools are refused by name and `gh` and `docker` must be an absolute path to an owned program; a bare or relative `gh` or `docker` word is refused even when it would not run (`echo gh` too). Executing the real updater shell (directly, as a shell's script, or through a launcher) is refused unless its manager resolves to an owned program; passing its path to another program is not a launch. Privilege tools (`sudo`, `doas`, `pkexec`, `run0`, `su`) and login or interactive shells are refused (`ERR_TEST_ISOLATION`), because they rebuild the environment; a shell started by a launcher is checked like a direct one |
| L2c Node descendants | Node processes | For Node processes, `NODE_OPTIONS` is the propagation channel. It carries `--require` of the CommonJS implementation. It covers `fork`, `process.execPath`, any `node` on `PATH`, shebang scripts and Node under shells. `--import` is not used, because it routes every main entry through the ES module loader and breaks Node scripts named like `fake-docker.sh`. Loading an ES module with `require` is not used either, because it fails in processes with asynchronous loader hooks such as `tsx`. Workers receive a boundary environment and an explicit CommonJS guard preload before their entry; defined `env` or `execArgv` overrides (including `SHARE_ENV` and `[]`) are refused (`ERR_TEST_ISOLATION`). Nested workers reuse one explicit guard prefix |
| L3 network | Node processes | TCP (including `http`, `https`, `tls`, `fetch`), UDP and DNS to anything but loopback are refused with `ERR_TEST_NETWORK`. Unix sockets are allowed |

A child started through the boundary carries an internal marker. It keeps
the environment it was given, including fixture tokens and owned pointers,
instead of initialising again.

**Owned roots** are the OS temp directory plus directories passed to
`registerOwnedRoot(dir)`. Put fakes there; a fake named like a host tool
runs normally.

## Opt-in native and live probes

A test that deliberately needs a host surface calls

```js
permitHostAccess({ kinds: ["systemd"], optIn: "KAOIRO_RELEASE_UNIT_PROBE", reason: "..." });
```

The variable must be the probe's own `KAOIRO_` variable (not one of the guard's
`KAOIRO_TEST_ISOLATION_` variables), and the permission applies only when it is `"1"`. It covers that
process and its children, and only the listed kinds: their tools run, and the
root's own environment for them comes back (`systemd`: the session bus and
runtime directory; `docker`: `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`;
`gh`: its config directory and tokens; `network`: `SSH_AUTH_SOCK`). In a
reused Vitest worker the permission and that environment end with the test
file. The calling file and its kinds must be listed in
[`test-isolation-permits.cjs`](../../scripts/test/fixtures/test-isolation-permits.cjs):
the guard reads the caller from V8 call sites and throws `TypeError` for a
file that is not listed, a kind it is not allowed, or a caller without a
repository file (`node -e`, standard input). This is checked on every call,
also without the opt-in, so a module-scope call fails in an ordinary run. The
checker reports any other file that mentions `permitHostAccess`. An environment
variable alone never relaxes a root: the opt-in needs the call as well.

## Adding a test or a suite

Shared assertions such as `wrapper/agent-common/test/whoami_contract.ts` consume
observed results. Each engine's composition tests own their production entry,
tool path, fixtures, state transitions and cleanup.

- Every JavaScript or TypeScript source file with a static import declaration from Vitest or node:test must load the shared isolation module as its first import. The checker selects files by parsed module content, not by filename or launch command. Multiline, side-effect, aliased, escaped and type-only imports all select a file. Text in comments or strings does not. Syntax errors fail the scan.
- Export-from re-exports, CommonJS require, dynamic import and TypeScript import-equals acquisition of either test API are rejected. Use a static import so the checker can select and guard the file.
- The first import must resolve to scripts/test/fixtures/test-isolation.mjs. Dashboard test files instead use the extensionless `./isolation.setup` specifier, which resolves to `dashboard/test/isolation.setup.ts`; that local setup file starts with the shared module. This remains one hop.
- The three exact wrapper/codex helper files are exceptions because tests import them as helpers rather than run them: app_server_approval_harness.ts, fixtures/cli_app_server.ts and fixtures/notice_tap.ts. Their Vitest imports may name only vi and expect. A default or namespace import, a test-registration API (including an alias), unsupported acquisition, or a missing helper invalidates the exception. Other files, including siblings under test/fixtures, follow the first-import rule.
- Each declared package has a guard-free setup canary, and dashboard also has a guard-free jsdom canary. They assert isolation at module scope and in a test. They import only Vitest and the canonical canary helper; the helper imports only Node built-ins. Do not import the shared guard or dashboard setup in a canary. The checker requires all nine canaries to remain guard-free and verifies that the default package observations select them.
- The canonical node:test trees remain scripts/test and server/deploy/test. Every entry there is a *.test.mjs whose first import is the shared module. Other source files in those trees must be under fixtures or on the existing helper list. Every static `node:test` importer must be a canonical entry, including files under fixtures.
- setupOrder remains a source-level declaration check. It reads setupFiles only in a declared package's own vitest.config.* or vite.config.* file, accepts one readable list of string literals, requires the shared module first (through the dashboard hop), and requires sequence.setupFiles to be list when multiple files are declared. It reports setupFiles mentions in other files or unreadable declarations. A config with no readable setupFiles mention is not rejected by this check.
- The checker observes the default configuration of all eight declared Vitest packages using each package's own vitest list --json command. It requires one project and the selected canary files, including dashboard's jsdom canary. If default setup is missing or does not load the guard, the guard-free canary fails during collection. This observation needs installed dependencies and the wrapper and runner build outputs.
- The existing package-ownership check remains for Vitest configuration files outside the eight declared packages. Package script text and workflow command strings do not affect ownership. CI still pins the exact checker and self-test lines in the test-isolation job.

A first import protects ordinary module evaluation and test code that runs after it. Existing default setup and setupOrder remain the earlier initialization boundary. They do not make config-time code or every mode of an arbitrary configuration part of this guarantee.

## Running the checks

~~~sh
pnpm install --frozen-lockfile
pnpm -C dashboard install --frozen-lockfile
pnpm -C wrapper build
pnpm -C runner build
node scripts/test-isolation/check.mjs
node scripts/test-isolation/run-node-tests.mjs
node --test scripts/test/test-isolation.test.mjs scripts/test/check-test-isolation.test.mjs scripts/test/child-process-environment.test.mjs scripts/test/codex-backend-compatibility.test.mjs
~~~

These are the CI job's steps. The checker prints each problem on stderr and one JSON line, {"entries":N,"problems":N}, on stdout; it exits 0 only with no problems. The test-isolation job runs the checker once against the real repository. Its self-tests cover content selection, first-import enforcement, unsupported acquisition, canary and helper contracts, setupOrder, the checker CLI failure path, and CI wiring. The separate isolation and child-process-environment suites continue to cover runtime refusals, network rules, permits, and child environment handling.

The Node runner uses the canonical entries, runs them serially from the repository root and requires each file to report a real, non-skipped, non-todo test. It sets `KAOIRO_PREGATE_REAL=1` in the child environment, even when the caller omits it or sets `0` and does not add or change `NODE_OPTIONS`. Exceptions are exact entries with an issue and reason in `scripts/test-isolation/node-ci-exceptions.mjs`; their failures and missing events still fail the job, and a real test makes an exception stale. CI checks the issue number's shape, not whether it is open or relevant; reviewers must check that. There are currently no exceptions. The real pre-gate entry must report all six cases as real passing tests; retaining its obsolete exception fails with `stale exception`, and losing activation fails with `no real test ran`.

The job timeout is 15 minutes. Time the complete integrated job twice on a candidate that changes this workload, and assess headroom from the maximum duration. Do not set `PNPM_MAX_WORKERS` for acceptance to carry over a disposable probe's resource cap.

The workflow tests pin the CI commands exactly, including the complete four-file node:test list. Update them together with ciWiringProblems in the checker.

Workers preserve registered roots, inert pointers and scoped permits; they patch their own builtins before executing user code. Tests cover ordinary CJS-root loading with no outer preload, file/eval/ESM worker entries, nested workers, Node descendants and concurrent workers. Separate mutations pin each refusal and I1 (environment state), I2 (explicit startup-argument wiring), I3 (nested deduplication), and P0 (both preload routes removed). On the measured Node runtime the environment's `NODE_OPTIONS` can also preload the guard: removing I2 alone does not prove loss of protection, and P0 does not replace the individual I1/I2 tests.

The real suite owns a copied Node binary, a real-pnpm launcher and all gate clones/scratch. A symlink cannot supply the required fixed child PATH because `process.execPath` resolves it. See [pre-gate fixture lifecycle](pre-gate.md#real-suite-fixture-lifecycle) for interruption cleanup and its limits.

## Residual risks

- A first import does not retroactively guard hoisted callbacks that run before it, config evaluation, or environment construction. The default setup remains the earlier boundary for ordinary hoisted test callbacks; config-time and environment setup code remain outside this guarantee.
- The default observation detects a missing setup when a guard-free canary fails collection. setupOrder detects readable guard-order errors and parallel multi-file setup. The checker does not add a static rule requiring every config to declare setupFiles.
- Separate or alternate config files, Vite plugin `config` hooks, environment-dependent config code, wrapper functions, explicit undefined values, object spreads, duplicate or later keys, nested objects, inline projects without `extends: true`, and auto-discovered `vitest.workspace.*` or `vitest.projects.*` files can change setup or isolation. These mechanisms can affect default configs too. The existing canary catches a default setup that is missing or does not load the guard; setupOrder catches readable order errors. Changes to `isolate` or `pool` through these mechanisms are not detected. There is no audit of alternate configs or resolved values.
- Per-file reset under isolate:false is not guaranteed. Dashboard can carry roots between files even with its default setup, and Node's --experimental-test-isolation=none can cache the guard between files. Other pools and custom environments are not certified by the default observation.
- A runner can execute source without a static test API import, an exempt helper, or a git-ignored file outside the source inventory. Computed module names and acquisition hidden behind unrelated modules are outside the static import rule.
- Existing runtime residuals remain: a non-Node intermediate can clear the environment; hand-exported KAOIRO_TEST_ISOLATION_* variables are trusted; Unix sockets are not checked; and non-Node programs that open the network themselves are not stopped outside the disposable container.
- Playwright specs under dashboard/e2e/ use their own runner, are not in CI, and remain exempt.
