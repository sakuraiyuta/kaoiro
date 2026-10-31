---
title: CI before landing on develop
description: Run and record CI on the exact candidate before a director lands it on develop.
status: accepted
last_updated: 2026-10-28
---

# CI before landing on develop

Use a draft pull request (PR) to run the repository's `CI` workflow against a
candidate before it is landed. The director lands the reviewed commits directly
on `develop`; the PR is a CI entry and evidence record, not a merge path.

This procedure assumes the operator has approved branch pushes and draft PR
creation and that the active operator policy authorizes candidate CI as the
authoritative full suite. Until both conditions hold, the current reviewer
full-suite procedure remains in force; a PR CI run is supplementary. This page
does not change workflow triggers, required status checks, branch rules, or
deployment behavior.

## Open a draft PR for the candidate

1. Commit the candidate on an `issue-NNN-*` branch and push it to the repository:

   ```sh
   git push --set-upstream origin issue-NNN-short-description
   ```

2. Open a draft PR against `develop`:

   ```sh
   gh pr create \
     --draft \
     --base develop \
     --head issue-NNN-short-description \
     --title "Describe the candidate" \
     --body "Tracks issue #NNN. CI evidence for review; do not merge this PR."
   ```

   `ci.yml` runs on the `pull_request` event for `develop`, including a draft
   PR. Keep the PR open while the candidate is reviewed and landed.

3. Wait for the run and inspect its job results:

   ```sh
   gh pr checks PR_NUMBER --watch
   gh run view RUN_ID --repo sakuraiyuta/kaoiro \
     --json databaseId,headSha,event,conclusion,url,jobs \
     --jq '{runId: .databaseId, headSha, event, conclusion, url,
       jobs: [.jobs[] | {name, conclusion}]}'
   ```

   `RUN_ID` is the Actions run's database ID, not the PR number or the run's
   display name. Select the `pull_request` run for the current PR head; do not
   use an earlier run from the same branch.

## Reviewer evidence

The `test-isolation` job runs the canonical Node entries serially and checks the explicit exceptions in `scripts/test-isolation/node-ci-exceptions.mjs`. Reviewers verify that each exception issue remains open and relevant; CI cannot verify tracker state.

The real pre-gate entry has no exception and must run six cases. Its shared
runtime copies Node because a symlink resolves outside the owned bin, and its
single-signal teardown removes the owned clones and gate scratch (see
[fixture lifecycle](pre-gate.md#real-suite-fixture-lifecycle)). For changes to
this integration, verify activation/obsolete-exception negative controls and
time the complete `test-isolation` job twice; record both runs and the maximum
against the 15-minute budget (observed range 319 to 503 seconds across runs), with `PNPM_MAX_WORKERS` unset.

The implementation reviewer records this evidence for the reviewed candidate:

- PR URL and Actions run ID / URL.
- Full 40-character PR head SHA and reviewed commit SHA, with an explicit
  equality check.
- Workflow event and overall conclusion.
- Every job in `ci.yml` at that SHA and its conclusion. The current workflow
  declares `wrapper`,
  `runner`, `server-deploy`, `test-isolation`, `server`, `dashboard`, and
  `server-image`; the workflow file at the candidate SHA is authoritative if
  that list changes.
- Any native check required by the change, with its target SHA and result.

Check that the run belongs to the reviewed commit before accepting its result:

```sh
REVIEWED_SHA="$(gh pr view PR_NUMBER --repo sakuraiyuta/kaoiro \
  --json headRefOid --jq .headRefOid)"
RUN_HEAD_SHA="$(gh run view RUN_ID --repo sakuraiyuta/kaoiro \
  --json headSha --jq .headSha)"
test "$RUN_HEAD_SHA" = "$REVIEWED_SHA"
```

Every job must conclude `success`. A missing, queued, cancelled, skipped, or
failed job is incomplete evidence; investigate it and obtain a successful run
for the candidate before landing. A later commit changes the PR head SHA, so
reviewers use the new run for that new head.

Record the results in the review note or PR discussion, for example:

| Job from `ci.yml` | Conclusion |
| --- | --- |
| `wrapper` | `success` |
| `runner` | `success` |
| `server-deploy` | `success` |
| `test-isolation` | `success` |
| `server` | `success` |
| `dashboard` | `success` |
| `server-image` | `success` |

Include the run ID and both matching SHAs with the table. If `ci.yml` adds a
job, include it too; do not treat this example as a permanent job inventory.

## Carry evidence across the landing rebase

The director rebases the candidate onto `develop` and compares
`git patch-id --stable` for each original and rebased commit, in order. Record
the landed commit SHA and the matching original/rebased patch IDs alongside the
CI run ID, so the landed commits can be traced to the candidate run. CI
evidence may carry to the landed commits only when every patch ID matches and
the rebase has not changed the effective inputs used by `ci.yml`.

If a patch ID differs, a conflict resolution changes the candidate, or newer
`develop` commits change a workflow, dependency, source, test, fixture, or build
input used by a CI job, the previous run does not cover the rebased candidate.
Push the rebased candidate to the same draft PR, wait for every job to succeed
on its new head SHA, and record a new run ID, head SHA, and job table before
landing. This includes a newer `develop` commit that changes the same tests.
Do not use the post-landing `develop` run as a substitute for pre-landing
evidence.

## Native checks outside CI

All jobs in `ci.yml` run on `ubuntu-latest`. The `server-image` job builds and
probes the image, but CI does not validate behavior that depends on a live host
service manager, host kernel, installed native CLI, or deployment daemon.

The reviewer also runs and records the relevant native check when a change
depends on:

- `systemd`, `launchd`, or Linux unified cgroup behavior, including service
  lifecycle and process isolation;
- resolution or version reporting of a CLI installed on the actual runner host;
- a supported operating system or native runtime that the Ubuntu jobs do not
  exercise; or
- live Docker Compose / daemon behavior beyond the image build and probes in
  `server-image`.

Use the corresponding documented native procedure, such as
[runner service verification](../operations/runner-service-verification.md),
in a disposable or otherwise approved environment. Record the platform,
command, result, and tested commit. Do not use production state as a test
fixture. A native check supplements the CI run; it does not replace the workflow
jobs.

## Close after landing

After the director lands the candidate on `develop`, close the draft PR without
merging it through GitHub. Include the landed commit SHA in the close note:

```sh
gh pr close PR_NUMBER --repo sakuraiyuta/kaoiro \
  --comment "Landed on develop as LANDED_SHA; CI run RUN_ID covers it by matching patch IDs; closed without merging."
```
