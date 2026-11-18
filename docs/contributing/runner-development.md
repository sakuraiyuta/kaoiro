---
title: Runner development
description: Building, testing, and running the runner package locally, including the dev stack and how the runner starts its own children.
status: accepted
last_updated: 2026-11-18
related: [deployment]
---

# Runner development

```sh
pnpm -C runner typecheck
pnpm -C runner test
pnpm -C runner build
```

Every test process runs under the shared isolation guard; see
[Test isolation](test-isolation.md).

For the local stack, [`scripts/dev.sh`](../../scripts/dev.sh) launches the
server / dashboard / runner together. The runner runs under `tsx watch`. A
wrapper is not hot-reloaded: it runs the built wrapper packages, so rebuild
them and restart the agent to pick up a wrapper change.

## One entry and the self-start command

Everything starts through `runner/src/kaoiro.ts`
([ADR-0076](../adr/0076-single-kaoiro-entry-point.md)):

```sh
node runner/dist/kaoiro.js runner [config]
node runner/dist/kaoiro.js --version [--json]
node runner/dist/kaoiro.js setup
node runner/dist/kaoiro.js wrapper <engine> run <launch file>
```

The runner starts a wrapper, and the Claude catalog probe, as
`[process.execPath, ...process.execArgv, <entry>]` followed by a subcommand.
`<entry>` is the real path of the entry the runner itself started from.

- **Every node option is passed on as written.** This is what lets a runner
  under `tsx` start its children. It also means that a debugging option such
  as `--inspect-brk` given to the runner reaches every wrapper, where the
  second process fails to bind the same port. Attach a debugger to a wrapper
  by starting that wrapper by hand instead.
- **A child runs in the agent's directory.** An option that names a module by
  a bare or relative specifier, such as `--import tsx`, does not resolve
  there. The `tsx` command passes absolute paths, so `tsx src/kaoiro.ts` and
  `tsx watch src/kaoiro.ts` work; with plain `node`, give `--import` an
  absolute `file:` URL.
- **Do not delete the release directory of a running runner.** The runner
  keeps starting wrappers from its own release after `current` moves.

## Test tiers

`pnpm -C runner test` is the landing command: it runs every test file. Three
additional entries run a part of it for earlier feedback
([issue #706](https://github.com/sakuraiyuta/kaoiro/issues/706)):

| Command | Runs | Meaning of a pass |
|---|---|---|
| `pnpm -C runner test` | all files | The landing result. Nothing else replaces it |
| `pnpm -C runner test:fast` | files that start no process and open no socket | Early feedback only; the run says `INCOMPLETE for landing` |
| `pnpm -C runner test:integration` | files that start real processes or scripts, or listen on a socket | Same: a part of the landing result |
| `pnpm -C runner test:native` | files that need a real external provider | Same. The live run is an explicit act: `KAOIRO_LIVE_GROK=1 pnpm -C runner test:native`; without it the file's case is reported as skipped |

The union of the three tiers is exactly the landing selection. A fast pass is
never permission to land; a failure in any tier fails the landing command.

How a tier is selected: `runner/vitest.config.ts` reads `KAOIRO_RUNNER_TIER`
(`complete`, `fast`, `integration` or `native`; unset means `complete`; any other
value is an error) and takes the lists from `runner/test-tiers.json`. Each script
above sets the variable itself, so a value inherited from the shell cannot change
what `pnpm test` runs. `integration` and `native` list their files; **fast is every
other `test/**/*.test.ts`**, so a new test file runs in fast and in the landing
command until it is listed. The isolation canary
(`test/test-isolation.canary.test.ts`) is selected by every selector, even when a
list is empty, so the guard is proven in each one. The loader (`runner/scripts/tier-selection.mjs`) rejects, before
any selection, an entry that is not a literal `test/<name>.test.ts` path (a glob,
`..`, a subdirectory, a repeated entry, an entry in both lists, the canary or a
file that does not exist or is not a regular file). When a file is renamed or
deleted, change `runner/test-tiers.json` in the same commit.

`test/testTierSelection.test.ts` (an integration test, because it starts Vitest)
asks Vitest which files each selector selects and compares them with the manifest
in both directions: a declared file that its tier does not select (for example a
name Vitest excludes by default, such as `vite.config.test.ts`), an undeclared file
that `integration` or `native` selects, and any difference between `fast`, the
declarations and the complete selection fail by name. The union of the three tiers
must equal the complete selection in both directions: a file that a tier selects
and the complete selection does not, or the reverse, is also named. The same test
runs each of the four package scripts with a different selector inherited from
the caller and checks that it still selects its own tier, so the explicit selector
of `pnpm -C runner test` cannot be dropped silently.

A file belongs in `integration` when, during its run, it starts a real operating
system process or script (a `child_process` call that reaches the OS, including
the deploy shell scripts) or opens a listening socket. The measurements behind
the current lists are in
[runner test tiers](../evidence/runner-test-tiers-2026-10-23.md).

The test files added with the tiers start with the isolation module import as
their first import, which [issue #716](https://github.com/sakuraiyuta/kaoiro/issues/716)
makes the rule for every test file.

### Tier records

A tier run prints one JSON line and the `INCOMPLETE` notice at the end (the
values below are illustrative):

```json
{"tier":"fast","commit":"<sha>","runId":"123","attempt":1,"files":33,"tests":210,"passed":210,"failed":0,"skipped":0,"errors":0,"outcome":"pass","wallMs":2400,"counted":true}
```

`outcome` is `fail` when a case failed, a file failed without a failed case
(for example a collection error), or Vitest reported an unhandled error.
`runId` and `attempt` come from `KAOIRO_TEST_RUN_ID` and `KAOIRO_TEST_ATTEMPT`, or
from `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`; a record without both has
`counted: false` and takes part in no rate. Wall time is reported, never gated:
no job fails because a tier is slow.

To compute rates over a stated interval, take the `counted` records of one tier:
the number of `attempt` 1 records is the denominator; an initial failure is an
`attempt` 1 record with `outcome` `fail`; a rerun is a record with the same
`runId` and `commit` and a higher `attempt`. Example: 40 attempt-1 records, 3 of
them failed (initial failure rate 3/40); two of those 3 have an attempt-2 record
that passed (candidate flakes, confirmed only if the code is unchanged) and one an
attempt-2 record that failed again (a persistent failure). A failure rate is not a
flake rate, and a short sample is not a reliability claim.

## See Also

- [Runner install and distribution](../operations/runner-install.md).
- [Multi-host deployment architecture](../architecture/deployment.md).
- [High-risk change release](../operations/high-risk-change-release.md): read it
  before changing the runner start path or the wrapper turn lifecycle.

The Claude managed-delivery native test also runs from the wrapper suite.
Build both wrapper and runner before invoking it; the wrapper CI job does this
in that order. It starts the built runner and observes its actual child config
and environment, rather than constructing a second wrapper configuration.
