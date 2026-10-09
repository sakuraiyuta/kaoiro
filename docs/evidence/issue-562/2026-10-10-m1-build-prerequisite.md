# Runner test build prerequisite — 2026-10-10

Follow-up to implementation review M1 for [issue #562](https://github.com/sakuraiyuta/kaoiro/issues/562), cumulative implementation must-fix count 1. Review baseline: `ed6a5164047b892c1cb380028a5ff0a7769ad802`; measured correction: `60a9635719ff093917fc3902b34825aafc1e3d17`. See the [machine-readable evidence](2026-10-10-m1-build-prerequisite.json) for commands, timestamps, log hashes and restoration hash. The later evidence commit changes documentation only.

## Change and rationale

`runner/package.json` runs `pnpm build && vitest run` for `test`. The package command makes its distribution a prerequisite before any Vitest file starts, including filtered test runs. Build failure prevents test execution. This preserves the distributed CLI entry points used by the composition tests and avoids relying on lifecycle-hook configuration or the build side effect of another test file. CI needs no separate runner build step because it calls the same command. `runner/README.md` states the workspace install and wrapper-build prerequisites and the runner test command's own build behavior.

## Fresh-checkout measurement

Two new detached worktrees were created at the measured correction, with no `runner/dist`. Each independently installed dependencies, built wrappers, and typechecked the runner. The positive worktree then ran exactly `pnpm -C runner test` (under `setsid -w`); no separate runner build was run. `runner/dist` was absent immediately before that command. The log shows the runner build before Vitest starts.

| Step | Result | Exit |
|---|---|---|
| `pnpm install --frozen-lockfile` | install completed | 0 |
| `pnpm -C wrapper build` | 5 wrapper packages built | 0 |
| `pnpm -C runner typecheck` | typecheck completed | 0 |
| `pnpm -C runner test` | 1,137 passed; 57 files | 0 |

This reproduces the CI command order on the local host with `CI=true`, Node v24.3.0 and package-pinned pnpm 10.20.0. CI itself declares Node 22; this is not a fresh GitHub-hosted CI run or a Node 22 measurement. Install logs include warnings about workspace bins whose dist files do not exist yet; installation exits 0 and the following wrapper build succeeds.

## Negative control

In the second clean worktree, only `pnpm build && ` was removed from the package test script. With `runner/dist` absent, `pnpm -C runner test test/delivery-composition.test.ts` produced **4 failed / 1 failed file, exit 1**. The errors identify missing `dist/cli.js` and `dist/runner-cli.js`. A focused run avoids the unrelated CLI entrypoint test building dist as a side effect and masking the missing prerequisite. No assertion or test body was changed.

After restoring the package file byte-for-byte, with dist still absent, the identical targeted command built the runner and produced **4 passed / 1 passed file, exit 0**. The restored package hash matches the measured commit. Both temporary worktrees and their build/dependency trees were removed; their small logs and JSON records remain under `tmp/reviews/issue-562/m1-kogane/`.

## Scope and remaining review

Runtime code and test assertions are unchanged. Prior wrapper/server/dashboard gates remain historical evidence for those unchanged paths; the new runner full-suite measurement replaces the runner test-command evidence for this correction. Independent review of M1 is pending. No production deployment or native model delivery is claimed.
