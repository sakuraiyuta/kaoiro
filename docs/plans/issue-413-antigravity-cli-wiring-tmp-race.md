---
title: Issue 413 — Make Antigravity CLI wiring test tolerate disappearing temp dirs
description: Prevent a shared-temp-directory scan in the runner test from failing when another process removes a listed directory.
status: approved
last_updated: 2026-09-26
issue: 413
---

# Issue 413 — Make Antigravity CLI wiring test tolerate disappearing temp dirs

This design starts from `origin/develop` at
`6afbfb322956be8cf0a1b3e027b9b7f2997a3641`. The worktree is
`worktrees/hiiro-413` on `issue-413-antigravity-cli-wiring-tmp-race`.

## Problem and evidence

Issue [#413](https://github.com/sakuraiyuta/kaoiro/issues/413) reports one
runner-suite failure with `ENOENT` in `test/antigravity-cli-wiring.test.ts`,
followed by a clean rerun; it has no comments. At the baseline,
`wrapperConfigPath` scans every `kaoiro-runner-*` entry under `tmpdir()` and
then calls `readdirSync` on each candidate (`runner/test/antigravity-cli-wiring.test.ts:79-93`).
The default launcher creates one private directory per process and removes it
on exit (`runner/src/spawn.ts:99-109`). A concurrent process can therefore
remove a directory after the outer listing and before the nested read.

An isolated filesystem probe performed that ordering: list a real temporary
directory, remove it, then call `readdirSync` on its former path. The actual
filesystem returned `ENOENT` (probe exit 0). The regression test will force
this ordering at the helper boundary rather than rely on concurrent timing.

## Proposed change

Catch only `ENOENT` from the per-candidate `readdirSync(base)` and continue
scanning. Let other errors propagate. This directly handles the confirmed
listing-to-read race while keeping lookup behavior for existing wrapper
config files.

Baseline `git grep` for `readdirSync(tmpdir())` plus `kaoiro-runner-` matching
found this helper as the only site under `runner/test`, `server/test`, and
`dashboard/test`. Removing the shared scan would require exposing
`makeLauncher`'s private `mkdtemp` path through a production API or injecting a
test-only launcher that no longer exercises the default launcher, so the fix
handles the race locally.

## Scope

- Change the helper and tests in `runner/test/antigravity-cli-wiring.test.ts`.
- Add a deterministic case with two listed matching directories: remove one
  immediately before its nested read, then assert lookup skips it and finds the
  surviving directory's config.
- Keep production runner and launcher behavior unchanged.

Out of scope: replacing the test's shared scan with a per-test temp root and
changing production temp-directory ownership. After lookup, callers also read
the returned file at `runner/test/antigravity-cli-wiring.test.ts:389,398,405`;
that separate theoretical lookup-to-read race is not changed by this fix.

## Validation

- Before the fix, the deterministic regression case must fail with `ENOENT`.
- After the fix, it must find the surviving config. The no-deletion control
  must still return the expected config path; an injected non-`ENOENT` read
  error must still reject.
- Remove the `ENOENT`-only handling as a mutation: the regression case must
  fail again; restore it and rerun the targeted test.
- Run runner typecheck and the full runner suite.

## Docs

Only this plan changes; the fix affects a test-only helper and does not alter
product behavior.
