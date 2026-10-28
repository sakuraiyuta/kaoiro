---
title: Pre-gate — a fast environment check before a full suite
description: What scripts/pre-gate checks (pinned toolchain, offline frozen install, clean builds, a CI-like pnpm layout), how to run a suite through it, and how to read the run record.
status: accepted
last_updated: 2026-10-28
related: [runner-development]
---

# Pre-gate

A full suite takes 10-22 minutes. Many failures that end one early are not test
failures: a wrong pnpm version, a lockfile that no longer matches, a build that
produced nothing, or a build step that loses the toolchain `PATH` (the
`spawnSync pnpm ENOENT` CI failure of [issue #571](https://github.com/sakuraiyuta/kaoiro/issues/571)).
The pre-gate finds these in about 40 seconds, before the suite starts
([issue #578](https://github.com/sakuraiyuta/kaoiro/issues/578)).

## Run a suite through it

```sh
node scripts/pre-gate/pre-gate.mjs --exec -- pnpm -C wrapper/core test
```

`--exec` runs the command **inside the tree the gate just verified**, and only
if every step passed. A failed step means the command is never started. Use
this form for any suite you rely on. The dependencies must already be in the
local pnpm store, because the gate installs with `--offline`.

Without `--exec` the gate is only a diagnostic: it describes the scratch tree
it built, not the tree you work in, so its success says nothing about another
checkout.

The gate checks a **commit** (`--rev`, default `HEAD`), never the working tree;
uncommitted changes are reported as a warning and are not covered. To check
edits that are not committed yet, commit them (or send a snapshot commit to
the environment that runs the suite). Options: `--repo DIR`, `--rev REV`,
`--record FILE`, `--keep` (leave the scratch tree and print its path).

## What it checks

Each step runs in a scratch `git worktree` of the commit, so a "clean build" is
clean by construction and your own `node_modules` and `dist` are untouched.

| Step | Stage name | Fails when |
|---|---|---|
| Resolve the commit, add the worktree | `revision` | `--rev` does not resolve |
| `pnpm --version` in the tree equals the root `packageManager`; Node satisfies `engines.node` | `toolchain` | another pnpm or an old Node is picked (kind `toolchain_mismatch`) |
| `pnpm install --offline --frozen-lockfile` | `install` | the lockfile drifted or the store is cold |
| `pnpm -C wrapper build`, `pnpm -C runner build`, then every workspace package with a `build` script must have a non-empty `dist/` | `build` | a build exits non-zero (`step_exit`) or leaves no output (`artifact_missing`) |
| Delete the `dist/` directories and rebuild with pnpm reachable only through a `PNPM_HOME`-style directory | `ci-layout` | the nested `pnpm` call of `scripts/with-build-identity.mjs` did not resolve through that directory (`marker_missing`), or a build fails or leaves no output |
| The command after `--exec` | `suite` | it exits non-zero |

The CI-like step puts a small `pnpm` script in the `PNPM_HOME` directory. It
logs its arguments and runs the real pnpm. The gate starts the outer build with
the real pnpm by absolute path, so only the nested call can reach the logging
script, and it requires the expected nested argument list in the log. A build
whose exit code is 0 but whose nested call found pnpm somewhere else (for
example in `/usr/bin`, which the fixed child `PATH` always contains) is
therefore still rejected.

## The run record

Every gate run and every `scripts/pre-gate/run-recorded.mjs` run writes one JSON
line to stderr (prefix `KAOIRO_TEST_RUN`, then a space) and appends it to
`tmp/test-runs.jsonl` (gitignored), or to the file given by `--record`.

| Field | Meaning |
|---|---|
| `revision`, `dirty` | the commit checked (the gate resolves `--rev` to a full SHA) and whether the source tree had tracked changes |
| `command`, `cwd_relative` | what ran |
| `started_at`, `ended_at`, `duration_ms` | timing of the whole run, including the suite |
| `precheck_ms`, `over_budget` | gate only: the time spent on the checks before the suite starts, and whether it passed 2 minutes (a target, not enforced) |
| `exit_code`, `signal`, `error` | the result; a signal is `128 + its number`; a command that cannot start is 127 with `error` set |
| `stage_failed` | `null`, or the stage where the run stopped (`revision`, `toolchain`, `install`, `build`, `ci-layout`, `suite`) |
| `failure` | `null`, or `{kind, detail}` with `kind` one of `toolchain_mismatch`, `step_exit`, `marker_missing`, `artifact_missing`, `internal_error` (an exception the gate did not plan for; the exit code is 2) |
| `steps` | one `{name, exit, elapsed_ms}` per executed step |
| `counts` | summed test counts for vitest, `node:test` and `mix` summaries found in the output, read line by line per stream (stdout and stderr are never joined); `null` if none |

The record states **where** a run stopped and what was detected. It does not
say whether the environment or the code under test was at fault: a type error
fails `build`, and an incomplete environment can fail `suite`. Read the log to
decide. Failing to write the record only prints a warning; the command's exit
code is never changed by recording.

## Tests

- `node --test scripts/test/pre-gate.test.mjs` runs in a few seconds against a
  fixture repository and a stand-in pnpm. It also removes each of the gate's own
  checks in turn and requires the matching scenario to go red.
- `KAOIRO_PREGATE_REAL=1 node --test scripts/test/pre-gate-real.test.mjs`
  commits a defect into a scratch clone of the real repository and runs that
  clone's gate on the new SHA. The canonical `test-isolation` CI runner enables all six cases under the isolation guard. Direct developer invocation remains opt-in.

## Real-suite fixture lifecycle

All six cases use the same owned runtime: a byte-identical copy of the current
Node executable and a launcher forwarding to the real pinned pnpm. Node must be
copied: `process.execPath` resolves a symlink back to the original directory,
so the fixed child PATH would miss the owned bin. P reaches the suite with this
runtime; N1 drops PATH passthrough and must reach `ci-layout/marker_missing`
after successful builds. The fixture does not fabricate install/build results.

The test owns a base clone, mutation clones and gate TMPDIR beneath one temporary
root, including Git worktree metadata. It asynchronously spawns each gate in
its own process group. Normal teardown and a single SIGINT/SIGTERM stop any
active owned gate group, await its close, then remove the root. Signals target
only the group captured from a successful spawn; no host process discovery is
used. Signal acceptance observes the real N1 CI-build and checks paths/processes
from an external probe after cancellation, including cancellation of `node --test`.

A second same-kind signal during cleanup, uncatchable termination or machine
loss can interrupt cleanup; the enclosing disposable test slot or CI temporary
root owner must recover it. Those cases are not covered by the single-signal
claim. `PNPM_MAX_WORKERS` is not set by this fixture; acceptance uses the normal
package-manager worker selection.
