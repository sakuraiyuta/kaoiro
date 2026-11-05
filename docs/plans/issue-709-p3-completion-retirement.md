---
title: "P3: retire completion and enrollment"
status: implemented
last_updated: 2026-11-05
---

# P3: retire completion and enrollment

Implementation classification: L (server and runner launch paths, shared
safety checks and CLI/record consumers).
Source baseline: `2d3040de0b5213a622df6b5c75f64ba49325f1d3`.
Parent: [release reduction](issue-709-release-reduction.md), sections 3.4–3.6
and P3 in section 7. This document authorizes no production operation.

## 1. Contract and landing order

P3 removes the completion/enrollment system, including its admission checks,
receipts, retained workers and pinned tool copies. A release descriptor no
longer selects a different deploy/update path. The remaining commands deploy
and verify the chosen artifact through their ordinary paths.

Preserve ordinary deployment/update/link locks; prepare-before-stop ordering;
server health and complete SHA checks; runner artifact verification,
`--version --json` attestation and registration matching; source recovery on
failed switch; ordinary `--detach`; and all native Codex state protection.
In particular, do not remove a native-state guard merely because its caller
was near an enrolled branch. `acceptedForwardTransaction` loses its collector
consumer here, but its export and implementation retire in N2.

P1 is present at this baseline. The director reports C1 and C2 complete; this
design does not independently establish production enrollment or tag rules.
P3 implementation landed after P2, [issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695)
L1b/L4/L5, and issues [#711](https://github.com/sakuraiyuta/kaoiro/issues/711)
then [#713](https://github.com/sakuraiyuta/kaoiro/issues/713). [#711](https://github.com/sakuraiyuta/kaoiro/issues/711)
owns the child-environment CI step; [#713](https://github.com/sakuraiyuta/kaoiro/issues/713)
lands on [#711](https://github.com/sakuraiyuta/kaoiro/issues/711). P3 keeps their resulting child-process protections and CI wiring,
then recalculates its reduced scope/call counts on that integrated tree.
If the director changes this order, the later change must reconcile these
files and return the changed design for review before landing. Use their
integrated tree as the implementation base, or have the director transplant
the reviewed change onto it and reconcile the overlap before landing. Do not
reintroduce an old recovery table or replace the new L1b/L4/L5 tests with the
baseline versions. Re-enumerate affected cases on that tree and extend the
appendix for any new case. P2 owns workflow/landing/card deletion; P3 owns the
remaining completion consumers. P2 must split mixed test files as needed so
its own commit remains executable.

No deployment protocol, journal phase, service-manager lifetime or new lock
is introduced. Native-state reduction, allocation/tag policy, new child
environment profiles and unrelated deployment fixes are outside P3.

## 2. Delete the consumers and their implementation

Paths below are relative to the repository. Whole-file deletion includes all
private helpers; the named functions identify the responsibilities removed.
P2-owned `production-release-card.mjs`, `production-release-workflow.mjs` and
`release-automation-gate.mjs` are prerequisites, not additional P3 work.

| Delete file | Functions / entrance removed |
| --- | --- |
| `scripts/collect-production-release.mjs` | `collectRunnerBaseline`, `collectExecutedRunnerAudit`, `collectRunnerCompletion`, `collectServerCompletion`, `acknowledgeReleaseAttempt`, `enrolledCollectionContext`, `runCollectionCli` |
| `scripts/production-runner-worker.mjs` | `queueProductionRunner`, `cleanupProductionRunner`, `inspectProductionRunnerActivity`, `listRetainedProductionRunners`, `archiveRunnerWorkingCopy`, `runWorkerCli` |
| `scripts/production-release-authority.mjs` | `readReleaseAuthority`, `releaseSshArguments`, `releaseAuthorityRequest`, descriptor/path validation |
| `scripts/production-release-endpoint.mjs` | `validateReleaseRequest`, `validateNativeRunnerFact`, `importReleaseFact`, `releaseRequest`, `runReleaseEndpoint` |
| `scripts/production-release-files.mjs` | release-file IO, `acquireReleaseLock`, `releaseReleaseLock`, `withReleaseLock`, `withAsyncReleaseLock`, `releaseEntryInventory`, `recoverReleaseResidue`, `attemptDirectory` |
| `scripts/production-release-history.mjs` | evidence/row digests, `validateIncident`, `activityFor`, `readReleaseAttempt`, `readReleaseHistory`, `readArchivedReleaseIncidents`, `projectReleaseHistory` |
| `scripts/production-release-launcher.mjs` | `verifyLauncherClosure`, pinned CLI dispatch |
| `scripts/production-release-lifecycle.mjs` | `readLifecycleInspection`, `terminateReleaseAttempt`, `archiveReleaseAttempt`, `runLifecycleCli` |
| `scripts/production-release-plan.mjs` | runtime-host/authority/inventory/projection/plan validators, `enrolledHealthUrl`, `projectEnrollmentInventory`, `projectReleasePlan` |
| `scripts/production-release-reconciliation.mjs` | `validateReleaseSnapshot`, `selectOwnReleaseAttempt`, `assertReleaseUnresolved`, `preflightReleaseAuthority`, `reconcileProductionReleases`, `runReconciliationCli` |
| `scripts/production-release-record.mjs` | `receiptDigest`, `validateProductionRunner`, `validateProductionReceipt`, `startReleaseAttempt`, `assertCompletionEnrollment`, `completeReleaseAttempt` |
| `scripts/production-release-runner.mjs` | `resolveRunnerReleaseAlias`, `auditRunnerRelease`, `sealRunnerSwitch`, `verifyRunnerSwitch`, `cleanupRunnerRelease`, `runRunnerReleaseGate` |
| `scripts/production-release-runner-facts.mjs` | context/fact validators, `canonicalRunnerReleaseRow`, `recordExecutedRunnerRelease`, `runnerReleaseFact`, `importRunnerReleaseFact`, `recordRunnerReleaseActivity`, `installRunnerReleasePlan` |
| `scripts/production-release-state.mjs` | release grammar/constants, `releaseName`, `assertGrammarCoverage`, `classifyReleaseState`, `releaseStateTable`, `validateReleaseReason`, `validateReleaseContext`, `validateReleaseSkip`, `parseReleaseOptions` |
| `scripts/production-release-tags.mjs` | `readPublishedProductionRelease`, `publishProductionRelease` (completion publication, not build identity's retained schema-1 reader) |
| `scripts/production-release-tools.mjs` | `collectReleaseToolClosure`, `verifyReleaseToolClosure`, `stageReleaseTools`, `installReleaseTools`, `currentReleaseToolRoot` |
| `scripts/production-release-unit.mjs` | `unitSnapshot`, `unitCommandSnapshot`, `verifyRetainedUnitCommand` |
| `runner/deploy/release-gate.mjs` | descriptor-selected launcher CLI |
| `server/deploy/kaoiro-release-reconciliation.mjs` | `auditServerRelease`, `bindServerReleaseAudit`, `assertServerResumeContext`, `acquireServerReleaseActivity`, `releaseServerReleaseActivity` |

Change these surviving files narrowly:

| File | Removed branch / retained behavior |
| --- | --- |
| `runner/deploy/kaoiro-runner-common.sh` | Remove `kaoiro_release_gate` and `kaoiro_release_enrolled`; retain all ordinary and native-state helpers. Add the warning described below. |
| `runner/deploy/kaoiro-runner-update.sh` | Remove `release_audit`, release flag parsing/forwarding, both enrolled audits, pinned-launcher selection in detach, seal/proof reads and release-owner/runner-cleanup handling. Keep `.lock.update`, `.lock.links`, Codex owner/transaction cleanup and cleanup-failure lock retention. |
| `runner/deploy/kaoiro-runner-switch.sh` | Remove `release_manual`, release-only manual update-lock ownership/cleanup, audit/seal/proof verification before and after link-lock acquisition, and release flag parsing. Keep the link lock, artifact/identity/native-state guards and link ordering. |
| `runner/deploy/child-process-environment.mjs` | Remove only `KAOIRO_RELEASE_RETAINED_UNIT` from `RUNNER`: both its writer and reader retire here. Preserve all other profile entries and semantics from #711/#713. |
| `.gitignore` | Keep `/server/.kaoiro-release-authority.json`, and its copy in the recovery-property fixture. An ignored descriptor must not make the checkout dirty and block artifact identity checks. |
| `runner/deploy/kaoiro-runner-bootstrap.sh` | Remove enrolled `runner-audit` before install; retain argument/config validation, dry-run, wizard/install and optional service setup. |
| `scripts/build-runner-tarball.sh` | Remove only release-tools staging. Keep CLI/shim checks, runtime `MANIFEST.json`, source identity check and archive/staging cleanup. |
| `server/deploy/kaoiro-server-deploy.mjs` | Remove the two deleted-module imports, release value flags, `runUpdate` admission/under-lock audit and resume/bind/context writes; remove release activity locking from `runBuild`, `runStart`, `acquireDeploymentLocks`/`releaseDeploymentLocks`. Simplify `heldLockSteps` to the deployment lock; remove `RELEASE_LOCK_HELD_RE`, descriptor error reporting, its `authorityError` result and `runStatus`'s `lockAuthorityError`. `invocationOf` records repo/config plus the fixed compatibility literal `release_authority: null` (never a flag value). Drop `releaseReconciliation` dry-run output and new journal `release_context`/`release_reconciliation` fields. Retain ordinary locking and all phase/restore/health logic, including L1b/L4/L5. |
| `server/deploy/kaoiro-deploy-recovery.mjs` | `isInvocation` checks repo/config only; `baseArgv` and `renderRecovery` stop emitting release flags. Preserve target, transaction, config, refusal conditions, placeholders and explicit restore approval. |

Remove updater/switch options `--release-repo`, `--release-authority`,
`--release-attempt`, `--release-plan-sha256`, `--skip-release-reconciliation`,
`--skip-reason`, `--expected-authority-sha256`, `--release-target`,
`--release-alias`, and switch-only `--release-invocation` /
`--release-proof-sha256`. Remove the corresponding subset from the server
parser. Each retired option becomes an unknown-argument error before queue,
stop, Docker, link mutation or transaction creation. Do not silently discard
operator-supplied old flags. Ordinary `--repo`, `--target`, `--config`,
`--transaction`, `--detach` and native-state options retain their semantics.

### Keep the child-environment checker independent

`scripts/check-release-child-environments.mjs` still has consumers:
`scripts/test/child-process-environment.test.mjs`, `build-identity.mjs` and
`with-build-identity.mjs` checks. The parent's conditional deletion does not
apply. Keep its CLI/export and existing checks; replace its import of
`collectReleaseToolClosure` with local source-file enumeration. Enumerate the
same four directories (`scripts`, `scripts/lib`, `server/deploy`,
`runner/deploy`) and follow literal relative `.mjs` imports as today, within
the repository, with the existing file bound. Keep regular-file/no-symlink
checks for traversal; do not retain tool manifests, hashing, ownership-based
enrollment or pinned-copy installation solely for this checker.

Remove only deleted paths from `CHILD_ENVIRONMENT_SCOPE`. Retain the exact
legacy-call allowlist and checks for new raw imports/calls, helper import and
checked-call presence. Reconcile any already-landed child-environment change
before editing this table; never increase an allowance to make deletion pass.
Keep both shared child-environment modules and their profile semantics except
the single retired `RUNNER` key above.

## 3. Remaining launch and recovery paths

| Entrance | Path after P3 |
| --- | --- |
| Server build/start | Parse/configure → ordinary deployment lock → existing build/start checks and action → release that lock. No history authority/exporter/second lock. |
| Server update/rollback | Existing validation/dry-run → ordinary lock → phase-table action → existing stop/restore/start/health/full-SHA handling → journal and recovery hints. Enrollment never vetoes or approves a phase. |
| Runner update | Validate → generic detach submission if requested; otherwise `.lock.update` → prepare/verify artifact and native state → stop → switch under `.lock.links` → start → attestation/registration check → existing prune/cleanup. |
| Runner switch/rollback | Validate → `.lock.links` → verify target and retained native-state permission → update current/previous. No release-proof bypass. |
| Runner bootstrap | Validate/configure → existing dry-run or install/service setup. No release exporter. |
| Detached runner worker | Check `kaoiro_node >/dev/null` before queueing, then queue the physical updater script with its ordinary argv/env. Keep `--user`, `--no-block`, `--expand-environment=no`, independent unit, queue failure behavior and the distinction between ENQUEUED and completed. No retained production-worker protocol. |

For server `runBuild`/`runStart`/`runUpdate`/`runRollback`/`runStatus` and the
three runner entry scripts, once the installation path is known, check only
the presence of the fixed legacy descriptor (server
`.kaoiro-release-authority.json`, runner `release-authority.json`). An existing
file, directory or dangling link produces one fixed stderr warning that
enrollment is retired and the descriptor is ignored. Do not parse it, follow
its link, reveal its contents, start its exporter, or consult its history.
A metadata-read failure also cannot revive admission refusal; warn that any
legacy descriptor is ignored. Keep stdout machine-readable. Each entrance
emits at most one line; a nested updater/switch may each emit it, without a
new deduplication flag or persistent record.

C1 handled old enrollment before cutover. P3 does not delete, archive, repair
or reclassify descriptors, `production-attempts`, completion receipts, release
locks or old release-tools directories. They are inert bytes to the new
code. A held legacy `.lock.server` does not block P3; the ordinary deployment
lock still does. There is no new cleanup command.

Retain the pre-queue Node availability check explicitly in the updater's
`--detach` branch before reset-failed/submission. Its current call is an
incidental part of release admission; removing admission must not turn an
immediate missing-Node refusal into ENQUEUED followed by worker failure.

Old server journals remain readable. Unknown legacy `release_context`,
`release_reconciliation` and `invocation.release_authority` fields are ignored
for execution and left on disk; their contents must not invalidate an
otherwise valid repo/config invocation. New journals omit `release_context`
and `release_reconciliation`, but `invocationOf` continues writing
`release_authority: null` as a fixed literal. This is reader compatibility,
not enrollment state: it is never derived from flags, never authorizes an
operation, and is ignored by the new reader. Pre-P3 `isInvocation` requires
this key; without it, `readJournal` rejects the entire record and
`findUnfinishedTransaction` silently skips it. Keeping the literal preserves
discovery by old tooling without adding a P3-specific rollback prohibition.
The remaining phase/restore restrictions still apply. Recovery
from an old journal renders only current arguments and continues through the
unchanged phase restrictions. Missing invocation still renders placeholders;
malformed repo/config/target still refuses. Do not migrate phases or rewrite
journals just to remove unused fields. Old tools need no new P3 record
reader, but returning to old tooling with a restored descriptor can activate
old enrollment again; C1's archived state must stay out of its active paths.

## 4. Case migration and implementation checks

The [case ledger](issue-709-p3-test-cases.md) is part of this design. R means
the contract retires; K names a retained obligation and destination below.
A mixed case lists both. Move each K assertion to an ordinary-path test
before deleting its source; a replacement must test the retained mechanism,
not reproduce an enrolled fixture whose precondition disappeared. Record
final test names and mutation results alongside the implementation review.

| Group | Destination and required check | Negative control / mutation |
| --- | --- | --- |
| K1 runner lifecycle | `runner/test/releaseUpdate.test.ts` / `releaseSwitch.test.ts`: actual scripts, stop→switch→start, current/previous, `.lock.update` and `.lock.links`, failed post-stop switch restarts unchanged source; `releaseCleanup.test.ts` keeps failure to remove build/Codex owner retaining the update lock. Existing ordinary cases can absorb assertions. | Bypass ordinary update/link lock guards separately; suppress source restart after a retained switch failure. Swallow cleanup failure or release the update lock on failure: the cleanup test must fail. Each corresponding test must fail. Never use removed proof validation as the failure trigger. |
| K2 ordinary detach | `releaseUpdate.test.ts`: physical script, literal argv (spaces, `$`, `%`), explicit safe env/no token leak, independent unit, submit failure has no ENQUEUED/no stop, caller death does not kill owned worker. | Remove `--expand-environment=no`, bypass queue error, remove the explicit pre-queue Node check, or forward a forbidden ambient variable: matching tests fail. Keep the owned-child caller-death test; no host-wide PID enumeration. Typed retained-worker inspection and completion imports retire. |
| K3 server recovery | `server/deploy/test/recovery.test.mjs` and `recovery-property.test.mjs`: execute printed commands after actual owned CLI kill, ordinary held-lock refusal and status hints, update/rollback completion, old-journal extra fields ignored, new journal visible to pinned pre-P3 readers, repo/config/target/restore approval preserved. | Bypass ordinary deployment lock; omit recorded repo/config from rendered argv; weaken repo/config validation or a retained restore/phase refusal, or omit the compatibility literal from the actual writer: corresponding tests fail. Keep L1b/L4/L5 fault schedules and archive/volume invariants from their landed tree. |
| K4 child environment | `scripts/test/child-process-environment.test.mjs`: retain default real-child and operation-profile tests. Retarget bypass probes to surviving checked sources, not removed authority/SSH code. Check directory enumeration plus a newly added relative-import dependency; assert that the retired `KAOIRO_RELEASE_RETAINED_UNIT` is no longer forwarded while unrelated runner keys still are. | Raw import without call; spawn/fork; legacy count change; missing helper import/call; unchecked source in another scanned directory or imported dependency must each fail. Disable checker rejection/enumeration once in the test harness and confirm red; restoring the retired key to the profile must fail its assertion. |
| K5 artifact/start boundary | `runner/test/releaseInstall.test.ts`, `releaseUpdate.test.ts`, `releaseBootstrap.test.ts` and an isolated real-artifact check: build a real runner tarball, assert no release-tools/release-gate, run its CLI and launch-shim validation and strict manifest verification; preserve machine identity and production activation checks. | Remove a required runtime module or mismatch the artifact's full SHA: reject before stop/link change. Remove the verifier invocation in the script: corresponding test fails. |

Add contract-removal checks using the actual entry scripts/functions and
isolated fake Docker/service-manager/registration endpoints:

1. All retired flags reject before side effects, with and without a legacy
   descriptor. Measure stop/start/queue/Docker calls and journal/link bytes;
   an unknown argument must not be accepted merely because its code vanished.
2. Without descriptor, exercise ordinary paths first with no enrollment
   dependency injected. Then repeat with invalid JSON, directory and dangling
   descriptor link; plant an exporter that fails/writes a marker if launched,
   unfinished history and a legacy release lock. Expect the same deployment
   decisions, fixed warning only, zero exporter calls and byte-for-byte old
   records. Pair with ordinary held-lock/invalid-artifact controls that still
   refuse; absence of enrollment must not imply unconditional success.
3. For server recovery, use a valid pre-P3 journal containing retired fields;
   execute printed update/rollback argv and verify no retired flags. Include
   malformed *retired* metadata as a positive ignored-field case and malformed
   repo/config/target as negative cases. Also run the actual P3 CLI until it
   writes an unfinished journal, then feed its disk bytes to pinned pre-P3
   `isValidJournalShape`, `readJournal` and `findUnfinishedTransaction` from the
   integrated predecessor. They must accept/find it. Pin genuine reader source
   with its commit provenance, not a reimplementation of the expected shape.
   Remove the literal from the writer: this compatibility test must turn red;
   restore it and rerun. New journal assertions require the null literal and
   absence of the other two retired fields.
4. Run an upgrade from a pre-P3 **not-enrolled** source using the actual newly
   built tarball, then an update launched through the new physical updater.
   This covers both the first rollout and the path after rollout; fake only
   external services, not the shell scripts or artifact verifier. Bootstrap
   dry-run/install/optional service paths must likewise need no release tools.
   For the server's first rollout, the pre-P3 CLI process loads its imports
   before `git merge --ff-only` advances the checkout to P3. On the not-enrolled
   path there is no later read/launch of the removed modules: imports are static
   and the lifecycle-script command is in the enrolled lock branch. Failure
   writes an old-shape journal, covered by the old-to-new recovery check
   above. This first-rollout explanation is source inspection, not a claimed
   deployment measurement.
5. Confirm the warning test becomes red when its call is removed. Confirm a
   stale-descriptor test becomes red when old admission/exporter access is
   restored. Keep these mutations disposable; restore and rerun the final
   artifact. Add a missing `KAOIRO_NODE` detach case: zero reset/queue/stop
   calls and no ENQUEUED; removing only the pre-queue check must make it red.
   If any transferred guard remains unpinned, report it and do not
   count the migration as finished.

Run implementation checks on the integrated commit via the prescribed remote
test runner: runner build/typecheck/full tests; `node --test` in
`server/deploy`; surviving scripts tests; child-environment and test-isolation
checkers; actual tarball build/strict verification. Use the package/CI commands
from that tree, including prerequisite wrapper build. Mutations also run in
isolation. Real user-service behavior, if affected beyond ordinary argument
construction, needs an owned disposable unit outside production; a fake
manager is not evidence of real service-manager lifetime. No production unit
or host setting is changed for P3 validation.

## 5. Import closure, CI and documentation

Before deleting modules, enumerate tracked imports, dynamic imports, shell
calls and CI commands for every deleted filename. Afterward repeat the sweep:
executable consumers must be zero, while historical ADR/plan references may
remain. Load surviving checker and server modules in the isolated test run;
exercise actual runner entry scripts and the built artifact, rather than
relying on a text search to prove the graph is intact. Keep build identity,
schema-1 tag reading, runtime manifest tools, ordinary deploy lock/phase
modules and native-state helpers even if an exported function loses a P3
consumer.

Remove `server/deploy/test-support/fake-release-exporter.mjs` after its cases
move. Remove permissions for the deleted native/unit tests from
`scripts/test/fixtures/test-isolation-permits.cjs`. Remove CI's
`release-identity` job after P2's landing tests and P3's completion tests are
gone. Keep runner and server-deploy jobs and the child-environment checker/test
steps owned by #711 and updated by #713. P3 does not add a competing CI step;
its integration check verifies that those surviving steps still execute the
reduced source scope and the transferred assertions. Deleting the old
job must not delete a retained assertion's only execution path. In review,
check that the final workflow includes the exact surviving test command;
temporarily remove the step and confirm that this check fails. This can be a
disposable static check; P3 does not require a new permanent CI framework.

Update the parent's listed operations/reference pages: remove enrollment,
common production checkpoint, reconciliation/release-state table and removed
CLI recipes from `build-identity-and-release-tags.md`; adjust
`runner-update-and-rollback.md`, `server-update-and-rollback.md`,
`runner-install.md`, `reference/deployment/transactions-and-identity.md` and
`docs/README.md`. Also fix any live removed-command guidance in
`high-risk-change-release.md`. Explain the ignored-descriptor warning,
unchanged health/identity checks and ordinary recovery commands. Explicitly
list the removed stdout JSON fields: status `lockAuthorityError`, release-kind
entries in `locks[]`, and update dry-run `releaseReconciliation`. Machine
consumers must stop expecting those fields; ordinary lock/status fields remain.
Regenerate the server recovery table from its current source; remove enrolled lock
instructions without weakening ordinary stale-lock ownership checks. Keep
ADRs and historical plans as history, linking the current runbook where
necessary. No production inventory or private paths belong in these docs.

Design evidence is source inspection at the baseline, the case ledger and the
old-reader observation below. The implementation checks above remain
requirements, not claimed tests of a P3 implementation.

## 6. Old-reader compatibility observation

On 2026-10-23, an isolated disposable run imported the unchanged reader
modules and their dependencies from `2d3040de`. For each variant it wrote
`journal.json` under an owned temporary `20261023T000000Z` directory, then
called `isValidJournalShape`, `readJournal` and
`findUnfinishedTransaction(parent)`.

The common specimen (the JSON below is input, not a P3 implementation output):

```json
{"schema_version":1,"transaction_id":"20261023T000000Z","phase":"preflight","invocation":{"repo":"/srv/kaoiro","config":null,"release_authority":null},"history":[{"phase":"preflight","at":"2026-10-23T00:00:00Z","observation":{"container":"kaoiro-fixture","free_bytes":100,"volume_bytes":1,"threshold_bytes":2}}]}
```

| Variant | Old shape check | Old unfinished scan |
| --- | --- | --- |
| Add old `release_context: null` and `release_reconciliation: {status: "generic"}` | true | finds the transaction |
| Common specimen: fixed null literal, neither other field | true | finds the transaction |
| Remove only `invocation.release_authority` | false | returns null |

The same acceptance assertions turned red for the missing-field variant.
Restoring the literal and writing through the real `writeJournal` completed
a successful read/scan round trip. The run exited 0; stdout was 362 bytes,
SHA-256 `cff7021c29c9544bc48022043d1c624576f7d014a86939e4b3b0d0aa4ba0890f`.
The owned journal directory and remote run were removed. This establishes
the old reader's requirement, not coverage of the future P3 writer; section
4 requires repeating the check with that writer's actual output and mutation.
Keeping one inert null field is therefore preferred to a new old-tool
return restriction.
