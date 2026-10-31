---
title: Transaction state table for server deploy and runner update
status: accepted
last_updated: 2026-10-31
---

# Transaction state table for server deploy and runner update

Tracking: [issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695) (step 2 of [issue #585](https://github.com/sakuraiyuta/kaoiro/issues/585)).
Base of the analysis: `d5ac3cfd6c4ea07ae623c3bf6a1ded64472ae7e9`; every
`file:line` refers to that commit. The design passed four review rounds and
was approved; the round record is kept on the issue, not here. Landing units
are tracked per unit (section 8); L1 is [issue #696](https://github.com/sakuraiyuta/kaoiro/issues/696).

Where a claim comes from reading control flow rather than from running it, it
is marked **(read, not run)**. The property tests in section 7 turn those claims
into measurements; a unit corrects this page where a measurement disagrees.

## Decisions

- Children: [issue #584](https://github.com/sakuraiyuta/kaoiro/issues/584), [issue #681](https://github.com/sakuraiyuta/kaoiro/issues/681),
  [issue #553](https://github.com/sakuraiyuta/kaoiro/issues/553) and [issue #531](https://github.com/sakuraiyuta/kaoiro/issues/531). [Issue #530](https://github.com/sakuraiyuta/kaoiro/issues/530),
  [issue #524](https://github.com/sakuraiyuta/kaoiro/issues/524) and [issue #472](https://github.com/sakuraiyuta/kaoiro/issues/472) are not children: they have no
  persisted transaction phase. They stay standalone, and no sibling issue is
  opened while the step-4 stop of [issue #585](https://github.com/sakuraiyuta/kaoiro/issues/585) applies.
- `scripts/production-release-state.mjs` (the release lifecycle of
  [issue #571](https://github.com/sakuraiyuta/kaoiro/issues/571)) is out of scope; its table shape is reused.
- Runner restore and code-recovery intermediate phases (R4) are landing unit L3,
  with their own design round; the first candidate is to represent an abandoned
  recovery without a new terminal record shape.
- Landing units L1, L1b, L2, L3, L4, L5 (section 8). Each unit's issue is
  opened when that unit starts.
- The runner `recover` action runs outside the release gate, like `abandon`,
  `accept` and `retire`, because the gate protects code switching and
  `recover` switches no code. Two conditions apply and are tested (5.4, 7.2):
  it writes no link and no release tree, and it starts only the recorded,
  unchanged source.
- Operator decision (R2, 2026-10-20): `recover` deletes the
  transaction-owned staging residue, at exactly the recorded `tx.staging`
  only, and records its path and size in the abandonment record. It is not
  moved to private storage.
- Three late review findings are in the scope of L2 and are checked in L2's
  implementation review: the R7 path-reuse guards, the `active-mismatch`
  refusal, and the proof that `next` writes nothing (all in 5.4).

## 1. Problem

Recovery bugs arrive one phase at a time (issues [584](https://github.com/sakuraiyuta/kaoiro/issues/584), [681](https://github.com/sakuraiyuta/kaoiro/issues/681), [531](https://github.com/sakuraiyuta/kaoiro/issues/531), [553](https://github.com/sakuraiyuta/kaoiro/issues/553)): a
transaction stops in a phase from which the printed next command loops, is
refused, or needs a destructive manual step. The root is structural:

- the set of phases is declared in one place (`server/deploy/kaoiro-deploy-phase.mjs:27`,
  `runner/deploy/kaoiro-runner-codex-state.mjs:82`), but the recovery verbs and
  the hint strings are scattered through the CLIs and decided per failure site;
- nothing checks that each persisted phase has a recovery path that completes,
  or that a printed command works.

The fix is one declarative recovery table per transaction, from which the
eligibility checks, the hint text and `status`'s next-step output are all
generated, plus a property test that drives every phase through the real CLI
and executes the command the CLI itself prints.

## 2. Scope

In scope:

- Server deploy transaction: `journal.json` phases (`kaoiro-deploy-phase.mjs:27-74`),
  written by `runUpdate` / `runRollback` in `server/deploy/kaoiro-server-deploy.mjs`.
- Runner update transaction: the Codex state transaction records
  (`codex-state/transactions/<uuid>.json`, `kaoiro-runner-codex-state.mjs`),
  driven by `runner/deploy/kaoiro-runner-update.sh` and `kaoiro-runner-switch.sh`,
  plus the non-journal persisted state the updater leaves (`.lock.update` and its
  files, `.lock.links`, staging directories).

Out of scope:

- `scripts/production-release-state.mjs` `RELEASE_STATES` / `ADMIN_STATES` (the
  [issue #571](https://github.com/sakuraiyuta/kaoiro/issues/571) release lifecycle on the operator side). Director ruling
  2026-10-20: excluded from [issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695) because it already has a per-state exit
  table (`releaseStateTable()`, line 380); this design reuses its shape only.
- Production deploys and runner updates. Nothing here runs against a production
  host, including dry runs.

## 3. State tables

Columns: **On disk** is what is true when the journal stops at this phase.
**Left here by** lists the failure points that leave the journal at this phase
(the next step after the checkpoint failed or the process died).
**Resume / Rollback / Abandon** are what the code does today. **Hint** is what
the operator sees today. **D** names the defect in section 4.

Verbs used in the server table: *resume* = `update --transaction <id>`;
*rollback* = `rollback --transaction <id> --confirm-restore`; the server CLI has
no *abandon* (`kaoiro-server-deploy.mjs:3421-3433`).

### 3.1 Server deploy — today

| Phase | Written at | On disk | Left here by | Resume | Rollback | Hint today | D |
|---|---|---|---|---|---|---|---|
| (no journal) | `mkdirSync(dir)` :2051, recovery compose :2066 | tx dir without `journal.json` | crash before :2082 | n/a | n/a | none; `findUnfinishedTransaction` skips it (`kaoiro-deploy-transaction.mjs:53-58`) | — |
| preflight | :2068-2082 | tx dir, journal, maybe `rollback-<old>` tag; `latest` untouched | `docker tag` / read-back mismatch :2094-2100 | refused: "has not completed prepare … rerun update with --transaction" :1984-1987 (same command) | refused: not in `ROLLBACK_ELIGIBLE_PHASES` :2630-2634, :2693-2696 | `update` w/o `--transaction`: "resume it with --transaction" :2026 | S1, S4 |
| old_image_saved | :2102-2115 | rollback tag verified; checkout may be ff-merged to target; **`latest` may point at the new image** (`compose build` ran in `buildUnderLock` :1474-1494) | build failure, `requirePlanIdentityMatch` :2119 ([issue #681](https://github.com/sakuraiyuta/kaoiro/issues/681)), `assertSourceIdentity` after build :1488 | refused, same loop as preflight | non-destructive allowed, but runs the fleet guard :2773-2776 (exit 78 on a pre-bridge or stopped old container; [issue #584](https://github.com/sakuraiyuta/kaoiro/issues/584)) | "resume it with --transaction" (loops) | S2, S3, S4 |
| build_prepared | :2120-2131 | target image built; `latest` restored to old on every exit of the env block :2182-2190, :2232-2242 | env_consistency refusal :2174-2218, persistence-path query errors :2221-2243 | allowed (re-runs the env check) | non-destructive + fleet guard | names `--accept-new-store` when applicable :2201-2203; the 5-b case names runbook 4.3 (5-b), after which resume still refuses ([issue #553](https://github.com/sakuraiyuta/kaoiro/issues/553)) | S3, S6 |
| env_consistency_checked | :2245-2251 | as above, check recorded | policy placement failure :2254-2272 (restores `latest`), normal stop at the gate :2274-2279 | allowed | non-destructive + fleet guard | gate: "resume with --transaction … --maintenance-approved" :2276 (correct here) | S3 |
| maintenance_gate_passed | :2287-2291 | as above | `ensureAlpineImage` :2299, fleet guard on the target :2307-2308 (exit 78) | allowed (skips re-advance :2287) | non-destructive + fleet guard | fleet guard text; `update` w/o `--transaction` says resume | S3 |
| stopping | :2309 | `compose stop` may or may not have run | `requireSingleBoundContainer` :2315-2319, `compose stop` failure :2320 | refused by `UNRESUMABLE_PHASES` :1694 only on the w/o-`--transaction` path; **with `--transaction` and a running container the gate hint is printed again and `--maintenance-approved` then hits `advancePhase(MAINTENANCE_GATE_PASSED)` from `stopping`, a PhaseError** (read, not run) | non-destructive; fleet guard needs `--fleet-stopped` if stopped (compose `ps -q` without `-a`, `kaoiro-deploy-docker.mjs:89-94`) | "commit half has no resume support … follow 4.4" :2025 | S3, S4 |
| stopped | :2325-2331 | old container stopped (outage) | unclean stop :2341-2354 | refused | non-destructive (retag + `docker start`) + fleet guard needs `--fleet-stopped` | `use 'docker start <container>' … investigate before retrying` :2352; runbook 4.4 (1) then says "a fresh update can retry", which is refused while this transaction is unfinished :2022-2027 | S3, S4 |
| mount_resolved | :2363-2369 | stopped, volume id recorded | empty volume :2378-2382, archive `tar` / verify / fsync :2385-2438 | refused | non-destructive + `--fleet-stopped` | raw error, no next command | S3, S4 |
| archived | :2441-2447 | stopped, archive recorded; manifest written next :2458 | manifest write, `latest` pin read-back :2487-2493 | refused | non-destructive + `--fleet-stopped` | raw error | S3, S4 |
| starting | :2506 | `compose up` may have run; new container may exist | `compose up` / `requireRunningContainer` :2507-2513 | refused (same PhaseError trap as stopping if a container runs) | destructive (manifest required, exists) | raw error | S4 |
| up | :2515-2521 | new container recorded | health poll timeout :2525-2531 | refused (same trap) | destructive | raw poll error | S4 |
| healthy | :2532-2538 | health matched target | stability check :2565-2569 | refused (same trap) | destructive | "investigate before retrying" | S4 |
| done | :2570 | terminal | — | n/a | destructive allowed | — | — |
| rollback_stopped | :2916-2925 | candidates stopped (outage) | forensic `tar` / verify / fsync :2927-2955 | refused (`requireRunningContainer` fails) | refused: rollback chain excluded :2630-2634 | "investigate … manually" :2695 | S5 |
| rollback_forensic_archived | :2956-2962 | forensic archive recorded, volume untouched | pre-deploy archive re-verify :2967-2977 | refused | refused | same | S5 |
| rollback_restoring | :2984-2993 | volume anywhere from intact to restored | stopped-check :2995-3003, wipe+restore :3005-3016 | refused | refused | same | S5 |
| rollback_restored | :3061-3067 | volume verified equal to `required_entries` at the checkpoint; after a failure past `compose up` :3076 the old-image container may be **running but unhealthy** (or report another identity) and may already have written to the volume | retag :3069-3075, `compose up` :3076, health :3083-3089 | refused | refused | same | S5 |
| rolled_back | :2793, :3091 | terminal | — | n/a | refused (terminal) | — | — |

Non-phase persisted state: the deploy lock `<backup_root>/.lock.<key>`
(`kaoiro-deploy-lock.mjs:44-53`) survives SIGKILL; its message names the path and
runbook 4.4 (0a) gives the manual check. Not a defect; it gets a row in the
generated table so the property test exercises it after a kill.

### 3.2 Runner update — today

Verbs: *resume* has no general verb; *rollback* = the state-aware restore run
(`kaoiro-runner-update.sh --restore-codex-backup <snapshot> --codex-home <home>`)
or the in-run code recovery (`prepare-recovery`); *abandon* =
`kaoiro-runner-codex-state.mjs abandon <root> <uuid>` (`:460-476`);
*accept* = `accept <root> <uuid> <evidence>` (`:390-423`).

Forward mode (created by `prepare` :257-279 before the stop):

| Phase | Written at | On disk | Left here by | Exit today | Hint today | D |
|---|---|---|---|---|---|---|
| prepared | `prepare` :275-277 | record + lock record; home untouched; runner usually still active | build-format refusal (`update.sh:452`), seal (`:456`), stop failure (`:507-511`) | abandon (owner gone, nothing written) | `abort_before_switch` text: `<reason>; … ; transaction <uuid>` (`update.sh:474-503`), does not name `summary` / `abandon` | R1 |
| stopped | `takeSnapshot` :287 | runner stopped; home untouched; possibly staging `.staging.codex-<uuid>`, possibly a complete snapshot, possibly the backup ref | `snapshot()` failure after the staging mkdir (`codex-snapshot.mjs:163-169`: copy, post-copy check, migration levels, manifest; staging not removed — [issue #531](https://github.com/sakuraiyuta/kaoiro/issues/531), reproduced at function level on 2026-10-20 per the issue comment; a failure inside `inventory()` at `:159` happens before the mkdir and leaves nothing); crash after rename but before the ref :288-289; crash after the ref but before :290 | **none** when staging, snapshot or ref exists: abandon refuses (:468-471), `prepare-recovery` needs the live lock owner (:315, :125-130), `prepare-restore` needs a ref; with only the ref, a restore can be prepared but its `accept` refuses because `recoveryLineage` does not list `stopped` (:182-183) (read, not run) | `Codex state preparation failed … transaction <uuid>` | R2 |
| snapshot-verified | :290 | snapshot + ref; home untouched; runner stopped; `current` = source | switch failure (in-run code recovery `update.sh:524-540`), worker killed | in-run: code recovery. After a killed worker: `prepare-recovery` impossible (no live lock owner); the restore run works after the stale `.lock.update` is removed by hand | killed worker prints nothing; the next update refuses with "Recover or accept the previous Codex state transaction first" (:260), no command | R3, R6 |
| switch-authorized | `guard` :227-228 | as above; `current` may be source or target (switch swaps links after the guard) | switch failure after authorization | in-run code recovery; after a kill: restore run | same as above | R3, R6 |
| start-attempted | `beforeStart` :305 | `current` = target; target may have started | start failure or identity mismatch (`update.sh:557-585`) | restore run (printed) | prints the exact restore command (`update.sh:573-576`) | — |
| awaiting-acceptance | `started` :484 | running on target | normal end of a forward | accept, or restore run | `awaiting actual Codex start/history acceptance: transaction <uuid>` (`update.sh:590`), does not name `accept` | R5 |
| completed | `accept` :412, :422 | terminal; ref retained until retire | — | retire (:424-448) | — | — |
| retired | `retire` :446, `abandon` :474 | terminal | — | — | — | — |

Restore and code-recovery modes (created by `prepareRollback` :319-350):

| Phase | Written at | On disk | Exit today | D |
|---|---|---|---|---|
| restore-prepared | :346-348 | record; home untouched; restore staging may be partial (`prepareRestore` copies after this point, `codex-snapshot.mjs:184-192`) | in-run before stop: source restart (`update.sh:478-500`). After that: **none** — a new restore refuses because the unresolved set holds a non-forward record (:320, PENDING), abandon refuses non-forward (:465), no verb resumes it | R4 |
| restore-intent | :376 | staging complete and verified; home intact | none | R4 |
| quarantine-intent | `promoteRestore` `codex-snapshot.mjs:198` | home may already be renamed to quarantine | none | R4 |
| quarantined | `:200` | **home path absent**; old home in `.failed.codex-<uuid>` | none | R4 |
| `credential-intent:<name>` / `credential-moved:<name>` | `:204`, `:206` | credentials partly moved from quarantine into staging | none | R4 |
| promote-intent | `:209` | staging may already be the home | none | R4 |
| state-restored | `:211` | home restored | switch guard (:225) → start → accept. On restore switch failure: "runner remains stopped … use operator fresh setup" (`update.sh:526-527`) | R4 |
| code-recovery-prepared | :346 | home untouched | in-run only (`update.sh:530-540`); after a kill: none | R4 |
| switch-authorized / start-attempted / awaiting-acceptance (restore or code-recovery) | as in forward | as in forward | awaiting-acceptance: accept. Earlier: none after the worker exits | R4 |
| restored | `accept` :412-422 | terminal | — | — |

The intent phases (`quarantine-intent` … `promote-intent`) were designed as
"persist intent before mutation" (`docs/plans/issue-468-codex-state-backup.md:302`),
but no code reads them back: `grep` for those strings outside the validator and
`promoteRestore` finds nothing. The only documented exit is the second-level
fresh setup, which deliberately loses Codex history and login
(`docs/operations/runner-update-and-rollback.md:250-282`).

Non-journal state: `.lock.update` (`codex-owner.json`, `release-owner.json`,
`release-audit.json`, `release-switch-proof.json`) and `.lock.links` survive a
killed worker; `cleanup()` also keeps `.lock.update` when build-dir removal or
release cleanup fails (`update.sh:346-358`). `kaoiro_lock_acquire` prints
"wait for it, or remove a stale lock dir" (`kaoiro-runner-common.sh:85-90`);
the owner checks are documented only under the abandon section of the runbook
(`runner-update-and-rollback.md:584-606`). The non-state path (no
`--codex-home`) has no journal: switch failure restarts the previous release
and start failure prints `kaoiro-runner-switch.sh --rollback`
(`update.sh:541-546`, `:579-584`); both complete.

### 3.3 State left alongside a phase

Persisted state that is not a phase but survives with one. **Cleaned by** says
whether a recovery path removes or repairs it, today and as proposed in
section 5.

| Item | Created at | Left with | Cleaned by today | Proposed |
|---|---|---|---|---|
| server deploy lock `<backup_root>/.lock.<key>` | `kaoiro-deploy-lock.mjs:44-53` | any phase after SIGKILL | nobody; manual `rmdir` after the owner check (runbook 4.4 (0a)) | unchanged (age never proves death); the lock message gets a `next:` line with the runbook anchor, and the property test's kill cases execute it |
| tx dir without `journal.json` | `:2051`, `:2066` | crash before `:2082` | never; the scan skips it, retention ignores it | unchanged, harmless; `status` lists it as an orphan directory |
| `kaoiro-server:latest` repointed to the new image | `compose build` in `buildUnderLock` `:1474` | `old_image_saved` (S2); also `build_prepared` and later after SIGKILL or a failed retag | `build_prepared` and later: update's exit paths **attempt** the retag and append a failure to the message (`:2232-2242`, `:2265-2270`); `old_image_saved`: no attempt, only the manual runbook 4.4 (0); after SIGKILL: nobody | three cases kept apart: an ordinary exit from `old_image_saved` attempts the retag too; a **confirmed** restore (read-back equal) is reported as such, a failed one prints a `next:` naming rollback; a crash residue is repaired by every rollback path (non-destructive and destructive both retag and read back) |
| checkout ff-merged to the target | `buildUnderLock` `:1458` | `old_image_saved` and later | never, by design (runbook 4.4 (0)) | unchanged; noted in the table because an update to an *older* target then fails the identity check — the hint must say so |
| `kaoiro-server:rollback-<old>` tag | `:2094` | `preflight` and later | retention, only for pruned `done` transactions (`pruneOldTransactions`) | unchanged |
| `kaoiro-server:<target>` image | `buildUnderLock` `:1489-1490` | `old_image_saved` and later | never | unchanged (disk only); listed for the operator |
| old container stopped | `compose stop` `:2320` | `stopping` … `archived` | non-destructive rollback (`docker start` `:2792`) | same, without the fleet guard (S3) |
| new container | `compose up` `:2507` | `starting` and later | destructive rollback stops it (`:2880-2906`) | unchanged |
| volume partly wiped | restore `:3005-3016` | `rollback_restoring` | nobody | rollback resume re-wipes and restores (S5) |
| tx evidence: `recovery-compose.yaml`, `archive.tar.gz`, `rollback-forensic.tar.gz`, `rollback-restore-verify.tar.gz` | `:2066`, `:2384`, `:2927`, `:3022` | every phase after creation | retention, `done` only; `rolled_back` transactions are never pruned | unchanged in 695; retention of `rolled_back` is a separate, non-recovery question |
| runner `.lock.update` (+ `codex-owner.json`, `release-owner.json`, `release-audit.json`, `release-switch-proof.json`) | `update.sh:330`, codex-state `:276` / `:347`, release gate | any phase after SIGKILL; also kept when cleanup fails (`update.sh:346-358`) | manual removal after the owner checks (runbook, abandon section) | unchanged rule; the lock message names the owner-check anchor and the evidence to preserve (release-owner / audit / proof files on enrolled roots); the check moves to its own runbook subsection |
| runner `.lock.links` | `update.sh:479`, `:613`; switch; `accept` / `retire` / `abandon` | after SIGKILL | manual removal | as above |
| `.staging.build.<pid>` | `update.sh:394` | any (build output) | next update's `kaoiro_gc_staging` (`update.sh:366`) | unchanged — the only automatically collected item |
| `releases/<new-id>` not activated | `kaoiro-runner-install.sh` | any phase | prune after a later successful update; protected while an unresolved transaction names it (`protectedReleases` :379-389) | unchanged |
| `current` / `previous` | switch, `previous` written first | `switch-authorized` and later | consistent by construction; recovery switches them back | unchanged |
| `previous` = `current` = `releases/<source>` | kill between the two swaps (`kaoiro-runner-switch.sh:251-253`) | `switch-authorized` + `current=source` | — | harmless: `recover` admission holds and it leaves the links as they are (no-code-write); `switch.sh --rollback` would be a no-op |
| unrecorded `rollback-forensic-resume-<n>.tar.gz` | C′ (5.3) | a `rollback_*` phase after a kill during the extra archive | nobody | the next resume uses `<n+1>`; `status` lists the unrecorded file as residue for the operator |
| snapshot directory partly removed, ref retired, transaction `completed` | `retire` `rmSync` (`codex-state.mjs:442-445`) | `completed` after a kill during `retire` | nobody (a rerun fails `verifySnapshot`) — R7 | `retire` rerun finishes the removal of exactly `ref.snapshot` when the ref already carries this retirement's evidence digest; `next` renders `retire` |
| `current.tmp.<pid>` / `previous.tmp.<pid>` | `kaoiro_symlink_swap` (`kaoiro-runner-common.sh:303-309`) | after SIGKILL between `symlinkSync` and `renameSync` | nobody | non-blocking; `recover` and the next update remove a tmp sibling whose name matches exactly and whose pid is not alive, else list it |
| server `<authority_root>/.lock.server` (+ `owner.json`), enrolled installations only | `acquireServerReleaseActivity` (`kaoiro-release-reconciliation.mjs:148-155`, `production-release-files.mjs:201-220`), right after the deploy lock (`kaoiro-server-deploy.mjs:1951-1955`, `:2758-2761`) | any phase after SIGKILL of `update` or `rollback` | the release layer's owner-checked `inspect-residue` then `recover-lock` (`docs/operations/build-identity-and-release-tags.md:354-361`); a named live owner refuses | unchanged mechanism; the server's lock message and `status` name both locks and render both `next:` steps; covered by the enrolled kill/replay case |
| `.staging.codex-<uuid>` | `snapshot()` `codex-snapshot.mjs:163` | `stopped` (R2, [issue #531](https://github.com/sakuraiyuta/kaoiro/issues/531)) | nobody | removed by `snapshot()` on an ordinary failure; crash residue deleted by `recover` step 4 (R2 decision) |
| snapshot directory (operator-supplied path) + backup ref | `:169`, `:289` | `stopped` … | `retire` (`:442-445`) | `recover` (never-switched forward): ref retired first; a complete snapshot without a ref is kept as **operator-owned evidence** (nothing collects it: `retire` needs a ref), its path printed |
| `.restore.codex-<uuid>` | `prepareRestore` | `restore-prepared` … `promote-intent` | nobody | `deferred(L3)` |
| `.failed.codex-<uuid>` (quarantined old home) | `promoteRestore` `:199` | `quarantined` and later, also after success | nobody; the runbook says retain | `deferred(L3)`; after a successful restore it stays as operator-owned evidence (unchanged) |
| transient unit `kaoiro-runner-update.service` in `failed` | `systemd-run` (`update.sh:312`) | after a failed detached run | next detached run's `reset-failed` (`:288`) | unchanged |

The two central holes, `preflight` and the four
`rollback_*` phases, are S1 and S5 below. Both are fixed in L1 / L1b (section 8),
and the property test treats them as its first required cases.

## 4. Defects found

### 4.1 Server

- **S1** `preflight` has no exit. Resume refuses and names itself; rollback
  refuses it as ineligible.
- **S2** `old_image_saved` has no forward exit (issues [584](https://github.com/sakuraiyuta/kaoiro/issues/584), [681](https://github.com/sakuraiyuta/kaoiro/issues/681)), and an ordinary
  failure after `compose build` does not even attempt to restore `latest`
  (`build_prepared` and later attempt it; see 3.3 for attempted / confirmed /
  crash residue).
- **S3** Non-destructive rollback runs the fleet guard (`:2773-2776`). In the
  non-destructive phases the old image is the one the fleet was attached to at
  `preflight`, and the path only retags `latest` and starts the recorded
  container, so the guard protects nothing there. Its RPC fails against a
  pre-bridge server ([issue #584](https://github.com/sakuraiyuta/kaoiro/issues/584)), and it needs `--fleet-stopped` whenever the old
  container is stopped.
- **S4** Hints that do not name a working command: (a) the prepare loop (`:1986`,
  and `:2026` for `preflight` / `old_image_saved`); (b) the gate hint and the
  PhaseError trap for `--transaction` on commit-half phases (read, not run); (c) unclean stop plus
  runbook 4.4 (1) "a fresh update can retry", which is refused while the
  transaction is open; (d) `mount_resolved`, `archived`, `starting`, `up` and
  `healthy` failures print no next command.
- **S5** The four mid-rollback phases have no exit. A rollback that fails during
  the forensic archive or the restore leaves the service stopped; one that fails
  after the final `compose up` leaves an old-image container that may be running
  but unhealthy. Either way only manual recovery remains.
- **S6** `build_prepared` after a genuine 5-b migration ([issue #553](https://github.com/sakuraiyuta/kaoiro/issues/553)): forward
  progress is blocked; rollback closes the transaction.
- **S7** (root cause of 681) the recovery plan ignores
  `docker-compose.override.yaml` because of the explicit `-f` (`:231-233`).

### 4.2 Runner

- **R1** `prepared`: abandon works, but no failure text names `summary` /
  `abandon`.
- **R2** `stopped`: three residues without an exit — staging only ([issue #531](https://github.com/sakuraiyuta/kaoiro/issues/531)),
  complete snapshot without a ref, ref present with the phase still `stopped`.
  The home is unchanged in all three.
- **R3** `snapshot-verified` / `switch-authorized` after a killed worker: code
  recovery needs a live lock owner. Only the full restore works, after a manual
  lock removal, and nothing tells the operator so.
- **R4** Intermediate restore and code-recovery phases have no CLI exit (deferred
  to L3).
- **R5** `awaiting-acceptance` hint does not name `accept`.
- **R6** Generic refusals and the stale-lock message name no command and no
  runbook anchor.
- **R7** (read, not run) `retire` killed during the
  snapshot removal cannot be re-run: the ref is already retired, and the rerun's
  `verifySnapshot` on the partial directory fails (`codex-state.mjs:437-445`).

### 4.3 Same-class checks

| Class | Other places found | Resolution |
|---|---|---|
| Resume uses facts that are not persisted | (a) `old_image_saved` resume needs the target, which is first recorded at `build_prepared`. (b) Non-destructive rollback starts the `preflight` `container`, a compose container **name** (`requireRunningContainer` returns names, `kaoiro-deploy-branch.mjs:80-91`), not the recorded `old_container_id`. A container recreated under the same name would be started instead. (c) Destructive rollback computes the fleet observation (`:2775`) but never records it, so a resume while the service is down could not re-use it | (a) record `target_sha` and `invocation` at `old_image_saved` (5.5); (b) start by `old_container_id` and verify its image is `old_image_id`; journals without the id start the named container only if its live image is `old_image_id`, with a separately stated weaker postcondition (5.2); (c) record `fleet_compatibility` at `rollback_stopped` as **audit only**; admission on resume is a fresh live snapshot or explicit `--fleet-stopped` (5.3) |
| Routing derived from graph adjacency | `UNRESUMABLE_PHASES` (reachability from `stopping`) also covers the rollback chain; runner `neverStarted` is derived from a phase list in two places (`codex-state.mjs:309`, `:316`); `update.sh` routes recovery by whether `codex_restore` is empty | the table's `operation` field is the only router; the graph-derived sets remain as unit-test cross-checks; the runner's never-started phase set is one table field read by both call sites |
| Terminal record ≠ working service | server non-destructive rollback (ends with the old container started: fine); runner restore run ends at `awaiting-acceptance`, so `accept` belongs to that sequence; existing strict `abandon` leaves an inactive runner to a manual start | every verb's postcondition in the table names the service state and "next update admitted"; the property test asserts both (7.1, 7.2) |
| Injection that does not reach its state | every recipe | recipes declare their residual and assert it before recovery (7) |
| Omitted invocation / enrolled context | server resume also needs `--repo` and `--config` (journal records neither); runner restore on enrolled roots already passes `runner-restore-admission` (`update.sh:360-362`); the new runner `recover` action runs outside the release gate | journal records `invocation` (5.5); runner `recover` is a state-helper action like `abandon` / `accept` / `retire` (which also run outside the gate). It never switches code (it requires `current` = source), so no switch proof is involved. Accepted with two conditions (5.4, Decisions) |

### 4.4 Saved state used later as authorization

| Path | Saved state it reads | Used to authorize | Re-checked live before the mutation? | Result |
|---|---|---|---|---|
| server `old_image_saved` resume | `old_container_id`, `old_image_id`, `target_sha`, `recovery_plan`, rollback tag | build and continue | yes: running container id and image, tag target, `--target`, re-rendered recovery plan (`requirePlanMatch`) | ok |
| server resume at `env_consistency_checked` / `maintenance_gate_passed` | recorded env_consistency observation | skipping the env check | indirectly: target plan `compose_sha256` / `env_sha256` re-checked before stop (`:2280`), container bound by id (`requireSingleBoundContainer` `:2315`) | ok (existing); recorded here so a future change keeps both checks |
| server resume, policy placement | `journal.policy_store_placement` | re-using the placement | `preparePolicyPlacement` re-queries paths and receives `previous` (`:2256-2259`) (read, not run) | to be measured in L1 |
| server stop gate | fleet compatibility | stop + start of the target | computed live at each attempt (`:2307-2308`) | ok |
| server non-destructive rollback, fleet guard skipped | none: the skip rests on the server code being unchanged relative to before the transaction, verified **live** (the container with `old_container_id` runs `old_image_id`) | retag + start | yes | ok — not a reuse of a saved fleet observation |
| server non-destructive rollback, legacy journal | container name from `preflight` | start | live image check by name (5.2) | ok with the stated weaker postcondition |
| server destructive resume, fleet | `fleet_compatibility` at `rollback_stopped` | — | not used for admission | fixed by this design |
| server destructive resume, candidates | `resolved_container_ids` | wipe | candidates re-enumerated live and verified stopped (5.3) | ok |
| server destructive resume, archives | recorded sha256 of pre-deploy and forensic archives | wipe / evidence | files re-hashed and traversed | ok |
| server deploy lock and `.lock.server` | lock directories | removal | owner checks live; age never proves death | ok |
| runner `recover` (first run and retry) | `tx.source`, `tx.binding`, `tx.owner` | start of the source | full re-check under locks, again before start, verify after | fixed by this design |
| runner `recover`, "target never started" | phase below `start-attempted` | treating the home as untouched | `current` = `tx.source.id` live, and the unit launches through `current` (`update.sh:375-381` reads `ExecStart`), so the target cannot have run through the unit | ok; the unit check is added to `recover` |
| runner restore run for `switch-authorized` / `current` = target | snapshot ref, tx | home restore | `prepareRollback` re-verifies snapshot, lineage, binding (`:319-350`) | ok (existing) |
| runner `accept` | evidence file, tx | terminal + receipt | `proof()` re-checks release, hash, live binding, twice (`:395-421`) | ok (existing) |
| runner stale `.lock.update` | `codex-owner.json` | removal | operator owner check per runbook | ok (manual, unchanged) |

No other path in the proposal reads saved state as authorization.

### 4.5 The recovery action itself dies part-way

For every recovery action, the state its own crash leaves, whether the table and
the read path render a working next command from it, and the result.

| Action | Its writes, in order | State after a kill between writes | Rendered next command | Result |
|---|---|---|---|---|
| server `update` resume | journal checkpoints (phases) | a later phase of the same table + stale deploy lock (+ `.lock.server` if enrolled) | next invocation refused by the lock, naming both locks; then `status` renders the phase's entries | ok (each phase is a row) |
| server `rollback` record-close (`preflight`) | one journal write | `preflight` (before) or `rolled_back` (after) + stale locks | as above | ok |
| server `rollback` non-destructive | retag, read back, `docker start`, journal `rolled_back` | phase unchanged with `latest` already old and/or the container started | rerun is idempotent: retag again, image check, `docker start` on a running container exits 0 (`:2786-2791`), then the journal write; `status` renders the same entry | ok; kill-after recipes on the retag and on `docker start` added (7.1) |
| server `rollback` destructive / resume | checkpoints B-E (5.3), `rollback_resumes[]`, extra forensic archive | a `rollback_*` phase + stale locks; possibly a **partial** `rollback-forensic-resume-<n>.tar.gz` that was never recorded | `status` renders destructive-resume; the partial file is not recorded, so the next resume picks the next free index (5.3) and lists the unrecorded file as residue | ok; residue row added (3.3) |
| runner `recover` | `tx.recovery`, ref retired, staging disposed, `tx` retired, start, `recovery.completed` | any prefix, + `recover`'s stale `.lock.update` / `.lock.links` | stale-lock message → owner check → `next` renders `recover <uuid>` (open transaction, or retired by `recover` without `completed`) | fixed by `recovery.completed` and the `next` read path (5.4) |
| runner `abandon` | one save (`retired`) | before: unchanged; after: retired. Locks stale. `abandon` does not touch the service | `next` renders `abandon` again (before) or nothing for that transaction (after) | ok |
| runner `accept` | ref `restored`, original `restored`, receipt + terminal phase (one save) | `awaiting-acceptance` with partial settlement + stale locks | `next` renders `accept <uuid> <evidence>` (existing rerun contract, runbook "If a step fails, the recovery stays `awaiting-acceptance`") | ok |
| runner `retire` | ref `retired` + evidence, `rmSync(snapshot)`, `tx` retired | **ref retired, snapshot partly deleted, `tx` still `completed`**: a rerun skips the ref write but runs `verifySnapshot` on the partial directory (`codex-state.mjs:442-444`), which fails ("Unexpected snapshot entry" / payload mismatch), so `retire` can never finish (read, not run) | none today | **defect R7**, fixed in L2: when the ref is already retired with this retirement's evidence digest, a rerun finishes the removal of exactly `ref.snapshot` without re-verifying, then retires `tx`; `next` renders `retire` for a `completed` forward whose ref is retired |
| runner restore run (updater) | forward / restore phases | rows of the table (restore intermediate rows `deferred(L3)`) | `next` | ok for forward; L3 for restore |
| runner `next` | none (read only) | — | — | — |

## 5. Proposed design

### 5.1 One recovery table per transaction, the single source of hints

Add `server/deploy/kaoiro-deploy-recovery.mjs` and
`runner/deploy/codex-state-recovery.mjs`. Each exports a frozen table: one row
per phase (for inventory), each row holding **entries** keyed by command, mode
and condition (for dispatch):

```js
{ phase,
  entries: [{
    command,     // server: "update" | "rollback"
                 // runner: "update" | "recover" | "abandon" | "restore-run" | "accept"
    mode,        // runner only: "forward" | "restore" | "code-recovery"; server: null
    condition,   // named, evaluated live: e.g. "current=source", "current=target",
                 // "journal-has-target", "legacy-no-container-id"; or null
    operation,   // "resume" | "record-close" | "non-destructive" | "destructive"
                 // | "destructive-resume" | "recover" | "refuse"
    entry,       // destructive-resume only (5.3)
    argv, placeholders, postcondition,
    closure,     // "closed" | "deferred(L1b)" | "deferred(L3)"
  }],
  note }
```

- Inventory at import: the row keys equal `Object.values(PHASE)` (server) and
  the validator's phase list including the eight `credential-*` names (runner).
- Dispatch: `(phase, command, mode)` selects the candidate entries; their
  `condition`s are evaluated live; exactly one must match, else the command
  refuses and renders the row's `next:` lines. A unit test asserts that no two
  entries of a row can match together (conditions within one
  `(phase, command, mode)` are declared mutually exclusive and tested on
  fixtures for each), and covers in particular `done` (`update → refuse`,
  `rollback → destructive`) and the runner phases shared by forward and
  recovery modes (`switch-authorized`, `start-attempted`,
  `awaiting-acceptance`).
- `TRANSITIONS`-derived sets and the `:2701` adjacency stop deciding anything;
  a unit test checks the table against them where they overlap.
- Rendering: (executable prefix, recorded `--repo` / `--config`,
  `--target`, recorded release context; operator-only values as named
  placeholders). An operator **attestation** such as `--fleet-stopped` is a
  placeholder with its precondition text, never pre-filled.
- Staged closure: per entry. The test pins each unit's deferred set; it can only
  shrink, and only in the unit that closes it.
- Runbook tables are generated and pinned by a doc-equality test.

### 5.2 Server table — proposed

| Phase | Command → operation | Postcondition |
|---|---|---|
| preflight | update → refuse (renders rollback); rollback → record-close | journal `rolled_back`; zero Docker calls; branches before the `old_image_saved` lookup (`:2698-2701`). New edge `preflight → rolled_back` |
| old_image_saved | update + `journal-has-target` → resume; update + no target → refuse; rollback → non-destructive | resume refuses before any Docker mutation unless the running container id equals `old_container_id`, its image equals `old_image_id`, the rollback tag resolves to `old_image_id`, `--target` equals the recorded target and the recovery compose hash matches. A build or plan failure attempts the `latest` retag and reports it confirmed or failed |
| build_prepared, env_consistency_checked, maintenance_gate_passed | update → resume; rollback → non-destructive | as today for resume |
| stopping … archived | update → refuse (before any Docker call or phase change); rollback → non-destructive | — |
| starting, up, healthy | update → refuse; rollback → destructive | — |
| done | update → refuse; rollback → destructive | at the CLI layer `update` never reaches this row, because `findUnfinishedTransaction` skips terminal phases (`kaoiro-deploy-transaction.mjs:62-65`); the table's `refuse` entry exists for the dispatch test and for `status` |
| rollback_stopped … rollback_restored | update → refuse; rollback → destructive-resume (5.3) | — |
| rolled_back | rollback → refuse (terminal) | — |

Non-destructive rollback, two conditions:

- `old_container_id` recorded: retag `latest` to `old_image_id` (read back);
  verify the container with that **id** has image `old_image_id`, else refuse;
  `docker start <old_container_id>`. Postcondition: that container runs
  `old_image_id`; volume untouched; no fleet RPC (the server code does not change
  relative to before the transaction, verified live; see 0.1). **Not checked:**
  runners or wrappers that changed identity during the window are re-checked
  only by the next update's gate (`:2307`); the postcondition and the generated
  runbook text say so.
- `legacy-no-container-id`: retag as above; start the `preflight` container
  **name** only if its live image is `old_image_id`, else refuse with guidance.
  Postcondition, stated separately: "a container named N runs `old_image_id`".
  The identity of the object is not claimed.

`closure`: L1 closes every entry except the `rollback_*` destructive-resume
entries, `deferred(L1b)`.

### 5.3 Destructive rollback and its resume (L1b)

Steps, each split into checks and mutations, in this order:

| Step | Order inside the step |
|---|---|
| A. pair | old image exists; pre-deploy archive sha256, traversal, `required_entries`; recovery and target plans match; recorded plan binds the volume |
| F. fleet admission | live snapshot if a live service container answers (`requireFleetCompatibility` with its id); otherwise the operator's explicit `--fleet-stopped`. Never a saved observation |
| B. stop | (1) resolve candidates and check identity (project / recorded UP container / any container mounting the volume; a foreign running consumer refuses); (2) stop the owned running candidates; (3) verify all stopped (`requireRollbackContainersStopped`); (4) checkpoint `rollback_stopped` with `resolved_container_ids` and the fleet observation **as audit** |
| C. forensic | archive, verify, fsync; checkpoint `rollback_forensic_archived` |
| D. restore | re-verify the pre-deploy archive; B(1)-(3) again without checkpoint; checkpoint `rollback_restoring`; wipe + extract; verify `required_entries`; checkpoint `rollback_restored` |
| E. start | B(1) identity only: any running service container must run `old_image_id` (a running container of another image refuses — it may have written to the restored volume); retag `latest` (read back); `compose up -d --no-build --force-recreate` with the recovery args; health for the old sha; checkpoint `rolled_back` |

Entry per phase (checkpoints of earlier steps are never rewritten):

| Journal phase | Runs | Running consumer found at B(1) | Notes |
|---|---|---|---|
| starting, up, healthy, done | A, F, B, C, D, E | normal case: stopped by B(2) | — |
| rollback_stopped | A, F, B(1)-(3) (no checkpoint), C, D, E | stopped by B(2); appended to `rollback_resumes[]` | — |
| rollback_forensic_archived | A, F, B(1)-(3) (no checkpoint), C′, D, E | stopped; appended | C′: the recorded forensic archive must match its recorded sha256, else refuse; an **additional** archive `rollback-forensic-resume-<n>.tar.gz` is taken (the wipe has not begun), where `n` is one more than the highest index present **on disk**, recorded or not, so a partial file is never overwritten; the original is never rewritten |
| rollback_restoring | A, F, B(1)-(3) (no checkpoint), D without its first checkpoint, E | stopped; appended | no forensic archive over a possibly half-wiped volume |
| rollback_restored | A's image check, F, E | old-image container expected and left running for E | never returns to the wipe; the volume is not re-verified against `required_entries` |

F on resume: when the service is stopped (all entries except possibly
`rollback_restored`) there is no live node, so the rendered `next:` line carries
the `--fleet-stopped` placeholder with its precondition ("stop the fleet first";
the existing semantics of that flag). The saved observation is never accepted
in place of either. Its shape is validated only when it is written (an invalid
one fails the write); a missing or malformed one has no effect on admission.

### 5.4 Runner — proposed (L2; R4 deferred to L3)

`abandon` keeps today's strict contract. `snapshot()` removes its own staging in
a `finally` unless the rename succeeded. Crash residue goes to:

`kaoiro-runner-codex-state.mjs recover <install-root> <uuid> <service>`

Contract (the two conditions set when `recover` was admitted outside the release gate):

- **No code switch.** `recover` never writes `current`, `previous`,
  `releases/` or any release file, and never calls the switch. It only writes
  this transaction's record, its backup ref, and the residue at `tx.staging`.
- **Only the recorded unchanged source starts.** Verification V below runs on
  every invocation that may start the service, immediately before the start,
  and again after it.

Verification V (all under `.lock.update` + `.lock.links`, taken by the CLI
entry as for `abandon`):

1. Owner proven gone: `ownerState(tx.owner)` is `absent` or `pid-reused`; if
   `tx.recovery.owner` exists (an earlier `recover`), it is proven gone too.
2. No conflicting work: `unresolved(root)` holds no transaction other than this
   one. (Active refs of earlier completed forwards are normal retained state and
   are not conflicts.)
3. Link: `readlink(current)` is `releases/<tx.source.id>`.
4. Release: `releaseIdentity(root, tx.source.id)` (full hash verify) equals
   `tx.source` (`id`, `sha256`).
5. Unit: `ExecStart` launches through `<root>/current/` (as `update.sh:375-381`);
   static binding `checkBinding(root, service, tx.binding)` equals the record.
6. After the start: `ActiveState` active, MainPID live, live binding
   (`captureBinding`) equals the recorded home, and the machine identity read
   through `current` attests `tx.source.id`.

Admission: mode forward; phase `prepared`, `stopped`, `snapshot-verified` or
`switch-authorized` with condition `current=source`; **or** phase `retired`
with `abandonment.via === "recover"` and no `recovery.completed` (a retry
after step 5 below). Any other state refuses and renders its row.

Steps (each re-run safe):

1. V1-V5.
2. Write `tx.recovery = {version, started, owner: {pid, start}, disposition}`
   where `disposition` is the planned action on `tx.staging`
   (`{kind: "delete", path, size}`, or `{kind: "none"}` when absent). It is
   written **before** acting, so a kill during the deletion is resumed.
3. Backup ref of `tx.uuid`, if present: `retired: true`,
   `retirementReason: "recover"` (ref first; a retired transaction with a live
   ref would leave a reference no helper settles — see 7.2 oracle).
4. Residue at `tx.staging`: absent → no-op; present and `lstat` shows a
   directory, uid-owned, mode 0700, at exactly the recorded path → delete it
   (R2 decision); a symlink, another owner, another mode or
   any other entry → refuse (no change). A complete snapshot at `tx.snapshot`
   (manifest uuid = `tx.uuid`) is left in place and printed.
5. `tx.phase = "retired"`, `abandonment = {version, phase, ownerStatus,
   via: "recover"}`.
6. Service state: `inactive` or `failed` with `MainPID` 0 → V1-V5 again, then
   `systemctl --user start`, then V6. `active` → no start and no stop; V6 only. A V6
   mismatch on an active service is recorded as `tx.recovery.v6 = {at, mismatch}`
   and the row's condition `active-mismatch` → refuse: `next` renders
   "investigate the running unit; `recover` cannot verify it" instead of
   `recover` again, so the hint does not loop. Anything else (`activating`,
   `deactivating`, `reloading`, unknown) → refuse with no change, as
   `runnerActivity` (`codex-service.mjs:137-140`) and `update.sh:466-472` do.
   Starting an inactive source unconditionally is right because every forward
   had an active source at `prepare` (`captureBinding`, `codex-service.mjs:121`).
7. After V6 passes: `tx.recovery.completed = <timestamp>`. A retired transaction
   with `recovery.completed` is done; `recover` refuses it and `next` renders
   nothing for it.

A retry always starts at step 1 (V is never skipped). Steps 2-5 skip what the
record already shows as done, and steps 6-7 run as written. If V fails on a retry
(for example a later legitimate update moved `current`), `recover` refuses
before any start and renders the guidance for the current state.

`switch-authorized` + `current=target`: `recover` refuses; the row's entry
`restore-run` renders the existing full restore and then `accept` (evidence
placeholder).

Stale locks: unchanged rule, rendered with the runbook anchor, and the message
ends with "then run `<tool> next <install-root>`". `recover` does not remove
locks.

**Read path `next <install-root>`** (new, read-only, takes no lock, like
`summary`): lists, from the table, the entries for every open transaction, for
the latest forward retired by `recover` without `recovery.completed`, and for a
`completed` forward whose ref is retired (R7). Each entry is printed as
rendered argv with placeholders. A legacy transaction (no
`bindingReceiptVersion`) prints the existing LEGACY guidance
(`codex-state.mjs:13`). `next` writes nothing: the suite takes a digest of
`codex-state/`, `.lock.update`, `.lock.links`, `current` and `previous` before
and after every `next` and requires equality, with a negative control in which
`next` calls `init()` or creates a lock. It is the runner's single read path (the server
uses `status`). Every runner refusal that 5.6 routes through the table, and the
`prepare` failure in `captureBinding` (`codex-service.mjs:121`) when the latest
forward is retired by `recover` without `completed`, end with the same pointer
to `next`.

**`retire` rerun (R7):** when the ref is already `retired` and its
`retirementEvidence` equals the digest of the supplied evidence file, the
retirement decision is durable. A rerun removes exactly `ref.snapshot` (no
symlink traversal, owned by uid) without `verifySnapshot`, then retires the
transaction. With a different evidence digest it refuses, and its `next:` text says the same evidence file must be supplied. Two further guards (L2): refuse if any other backup record names the same `snapshot` path, and, if `manifest.json` exists at the path, refuse unless its `uuid` equals `ref.uuid`. A reused-path fixture is a negative control.

R2 (operator decision, 2026-10-20): delete exactly `tx.staging` and record its
path and size in the abandonment record.

R4: `deferred(L3)`.

### 5.5 Persisted facts added

| Record | Field | Used by | Missing / malformed |
|---|---|---|---|
| journal top level | `invocation: {repo, config}` | argv rendering | rendered as placeholders |
| `old_image_saved` observation | `target_sha` | resume admission (compared with `--target`) | resume refused; rollback offered |
| `rollback_stopped` observation | `fleet_compatibility` | **audit only** | no effect on admission |
| journal top level | `rollback_resumes[]` | evidence of resumed stops and extra forensic archives | n/a |
| runner transaction | `recovery` (incl. `owner`, `disposition`), `abandonment.via` | `recover` retries | n/a (new; old tools ignore extra fields) |
| runner backup ref | `retirementReason` | audit | n/a |

Each new observation field is validated when written: the predicate for its
phase is extended to check the new key when present, so a malformed value fails
the write instead of being tolerated.

### 5.6 Hint changes (both CLIs)

Every refusal caused by an open transaction (S4 a-d, R1, R5, R6) prints only
table-rendered `next:` lines plus a runbook anchor. Unclean stop names
non-destructive rollback; runbook 4.4 (1) is corrected to say rollback closes
the transaction before a fresh update. After a SIGKILL nothing is printed by the
dead process: the guidance comes from the **next** invocation, which is refused
by the lock (it names both server locks, or the runner lock rule plus `next`),
and then from the read path: `status` on the server, `next` on the runner.

## 6. Children

Issues [530](https://github.com/sakuraiyuta/kaoiro/issues/530), [524](https://github.com/sakuraiyuta/kaoiro/issues/524) and [472](https://github.com/sakuraiyuta/kaoiro/issues/472) are not children of 695; they stay
standalone and no sibling issue is opened while the [issue #585](https://github.com/sakuraiyuta/kaoiro/issues/585) step-4 stop applies.

| Child | Defect | Unit |
|---|---|---|
| [#584](https://github.com/sakuraiyuta/kaoiro/issues/584) | S2, S3, S4a | L1 |
| [#681](https://github.com/sakuraiyuta/kaoiro/issues/681) | S2, S4a (state and message); S7 root cause | L1; L5 |
| [#553](https://github.com/sakuraiyuta/kaoiro/issues/553) | S6 (forward admission; rollback already closes) | L4 |
| [#531](https://github.com/sakuraiyuta/kaoiro/issues/531) | R2 (reproduced at function level 2026-10-20) | L2 |

## 7. Property-style test

### 7.1 Server

Harness: a stateful fake `docker` (JSON model of images and tags, containers
with id / name / image / status / restart count, volumes with content and
digest, and `compose ps` / `config` answers), plus the existing
`KAOIRO_DEPLOY_CURL_BIN` override for health. Every CLI command reads or mutates
the model. No production code reads a test variable.

**Recipes = phase + durable side effect.** Each recipe names a command, a
schedule and the residual it must produce. The harness asserts that residual
(phase, model state, files, locks) **before** running any recovery, so a recipe
that does not reach its state fails as a recipe.

| Schedule | Meaning |
|---|---|
| fail-before | fake exits non-zero, no effect; the CLI's own error handling runs |
| kill-before | fake SIGKILLs its parent, no effect |
| kill-after | fake applies the full effect, then SIGKILLs its parent before returning |
| partial | fake applies a defined partial effect (half-written archive; volume wiped but not extracted; volume wiped and half extracted), then SIGKILLs its parent |

Required recipes (minimum; each a row of the test table):

- `preflight`: tag fails (fail-before), kill-after on the tag.
- `old_image_saved`: `compose build` fail-before and kill-after (`latest` already
  moved); plan identity failure via an override adding a mount ([issue #681](https://github.com/sakuraiyuta/kaoiro/issues/681));
  pre-bridge model for the rollback ([issue #584](https://github.com/sakuraiyuta/kaoiro/issues/584)); resume refusal controls for a
  **changed container id**, a **changed container image** and a **changed
  `--target`**, each asserting zero Docker mutations.
- `build_prepared` … `maintenance_gate_passed`: their first failing command, plus kill-after on the
  `latest` retag.
- `stopping`: kill-before and kill-after on `compose stop`.
- `stopped`, `mount_resolved`, `archived`: unclean exit; partial archive;
  kill-after on the `latest` pin.
- `starting`: kill-after on `compose up` (new container running); `up`: health
  wrong revision with the container running; `healthy`: restart count change.
- Rollback chain: kill-after on candidate stop; partial forensic archive;
  kill-before on the wipe; **partial** wipe (wiped, not extracted) and partial
  extract — the forensic-overwrite control uses these, because only a changed
  volume makes a re-taken archive differ; kill-after on `compose up
  --force-recreate` with the health endpoint failing (`rollback_restored` with a
  running, unhealthy old container).
- `done`: explicit rollback after a completed update (destructive), and `update` refusing nothing because `done` is not open.
- Non-destructive rollback killed after the retag and after `docker start` (before the journal write): the rerun rendered by `status` completes.
- Destructive resume killed during the extra forensic archive: the next resume uses `<n+1>`, and `status` lists the unrecorded file.
- Resumed destructive rollback with the fleet changed after `rollback_stopped` (the model changes a runner identity to an unsupported format, or restarts a node in between): without `--fleet-stopped` and with no live node the command refuses before any stop, wipe or start; with a live node the fresh snapshot is used.
- Legacy journal without `old_container_id`, and a reused container name on another image.
- Locks: every kill recipe leaves the deploy lock. The enrolled fixture (an
  owned release authority built with the existing `scripts/test` authority
  helpers) also leaves `.lock.server`. The next invocation must be refused,
  name both, and the harness executes the rendered steps: deploy-lock removal
  after the documented owner check, `inspect-residue` then `recover-lock`.

Replay: run the rendered argv **as printed** (only declared placeholders are
substituted, each from a test-owned value), up to 4 steps. **Progress** is a
strict increase of the phase rank along the table's recovery order, or reaching
a terminal phase; a rewrite of audit metadata alone is not progress.

Oracles by operation (S1):

| Operation | Oracle |
|---|---|
| record-close | zero Docker calls during recovery; model unchanged |
| non-destructive | no volume write during recovery (the model writes some data as the old server during prepare, and it must survive); `latest` = old image; the container with `old_container_id` runs `old_image_id` |
| destructive | volume equals the content of the hash-bound pre-deploy archive; the forensic archive's bytes equal what was recorded |
| destructive-resume, entries `rollback_stopped` / `rollback_forensic_archived` / `rollback_restoring` | as destructive, plus the original forensic archive is byte-identical to its first record and each extra evidence file is new |
| destructive-resume, entry `rollback_restored` | zero wipe calls; the volume at the end equals the volume **as found at recovery entry**, including writes the model made as the old server after the earlier `compose up`; it is not compared with the pre-deploy archive |
| legacy non-destructive (`legacy-no-container-id`) | `latest` = old image; a container with the recorded name runs `old_image_id`; with a reused name on another image, the start is refused (zero starts) |
| update `done` | new image running, health at the target |

Every terminal case then asserts a fresh `update --target` is admitted. These
are modeled control-flow assertions about the CLI, not measurements of Docker.
Docker semantics the model relies on (for example `docker start` on a running
container exits 0, already measured in the code comment at `:2786-2791`) are
listed in the test file with their source.

Negative controls (each recorded red, and run separately):

1. fleet guard back on the non-destructive path → `old_image_saved` pre-bridge fails;
2. old prepare-loop hint → no progress;
3. `operation: resume` declared for `stopping` → refused at replay;
4. a recipe whose schedule is switched to fail-before where kill-after is declared → the residual assertion fails;
5. destructive resume that re-takes the forensic archive at `rollback_restoring` → forensic-bytes oracle fails (partial-wipe recipe);
6. `rollback_restored` entry routed to D → wipe-count oracle fails;
7. `old_image_saved` resume without the container-id check → the changed-container control mutates and fails;
8. generated argv without the release context → enrolled replay refused;
9. checker self-test: a fake CLI whose printed command exits 0 without changing the phase is reported as no progress;
10. destructive resume admitted from the saved `fleet_compatibility` → the fleet-changed case mutates and fails;
11. legacy fallback that starts by name without the image check → the reused-name case starts the wrong container and fails;
12. dispatch that resolves `done` by a single phase operation → `update` on `done` or `rollback` on `done` takes the wrong route and the dispatch test fails.

### 7.2 Runner

Process ownership (who owns what, and what a kill means):

| Process | Owns | Started by |
|---|---|---|
| updater shell (`kaoiro-runner-update.sh` worker) | `tx.owner` (`liveOwner` requires it to be an ancestor of the helper, `codex-state.mjs:113-124`), `.lock.update`, `codex-owner.json` | the test, as a **process-group leader** (spawned detached; its PGID is retained and checked to be a positive integer) |
| codex-state helper | nothing durable; runs one action under the updater | the updater, through `kaoiro_node` |
| `recover` helper | its own CLI-entry locks (`.lock.update`, `.lock.links`) and `tx.recovery.owner` | the test, as its own process-group leader |

Kills are sent only to those retained test-owned process groups. Nothing
enumerates host processes.

**Shared CLI entry.** The outer lock lifecycle now at `codex-state.mjs:499-514`
moves into an exported `runCli(argv, { cut } = {})`. The file's entry block
becomes `await runCli(process.argv.slice(2))`, and actions receive the optional
`cut(name)` (default no-op), threaded into `snapshot()`. A test driver calling
`runCli` therefore runs the same lock acquisition and release as the CLI.

**Worker-death cuts (snapshot windows).** The test sets `KAOIRO_NODE` (honoured
by `kaoiro_node`, `kaoiro-runner-common.sh:99-104`) to a wrapper. For a
codex-state call it runs the driver instead of the CLI file. The driver calls
`runCli` with a `cut` that, at the chosen name, sends SIGKILL to the updater's
process group (passed to the wrapper by the test). The helper and the updater
die together, before the helper returns and before `abort_before_switch` or
`cleanup()` can run. Other calls pass through unchanged. Cut names:
`snapshot:after-mkdir`, `snapshot:after-copy`, `snapshot:after-rename`,
`takeSnapshot:after-ref`.

**Action-boundary kills** use the same wrapper without the driver: at a chosen
call (before the `previous` symlink swap, before `before-start`, before
`snapshot`, before `started`) the wrapper kills the group instead of running
the call. No production code reads a test value. Only the optional `cut`
parameter exists, and it is a no-op unless a caller passes one.

**Recover cuts** (`recover:after-intent`, `after-ref`, `after-dispose`,
`after-retire`, `before-start`, `after-start-before-v6`): the test runs `recover`
through a driver calling `runCli` and kills `recover`'s own group. Its locks stay
behind as a stale lock, and `tx.recovery.owner` proves the earlier `recover` is
gone on retry. **The retry is not called directly.** The harness takes the
refused invocation's stale-lock message, performs the owner-checked removal it
names, runs `next <install-root>`, and executes the command `next` printed.
The hint is the thing under test.

**Observed before any recovery** (asserted, per case): the phase; `.lock.update`
present with `codex-owner.json` naming the dead updater (and the release files
on the enrolled fixture); the declared residue exactly (staging present or
absent, snapshot present or absent, ref present or absent); the fake
`systemctl` service state (inactive after a worker death in a window after the
stop).

**End-to-end, no cut:** the 531 reproduction with a corrupt `state_5.sqlite`
pinned on the unfixed code in L2's first commit. After recovery the test
removes its own corrupt file before retrying the update, so the retry's green
is a real success. One full update with no wrapper covers the default
composition.

Required cases: the three R2 residues (worker-death cuts); `snapshot-verified`
and `switch-authorized` + `current=source` (action-boundary kills);
`switch-authorized` + `current=target` → restore run + `accept`; every recover
cut and its retry through `next`, including the retry of a retired transaction
without `recovery.completed`; a retired transaction **with** `completed` for
which `next` prints nothing and `recover` refuses; a transitional service state
(`activating`) for which `recover` refuses with zero starts; `retire` killed
during the snapshot removal, then the `retire` command `next` printed (R7);
`accept` killed between its settlement writes, then `next`'s `accept`; stale
`.lock.update` with and without the enrolled release files.

Oracles:

| What | Assertion |
|---|---|
| ref settlement | after `recover`, the ref of `tx.uuid` (if it existed) has `retired: true` and `retirementReason: "recover"`, and no active ref names a retired transaction. Asserted directly on the record, not inferred from the next update |
| transaction | `phase: retired`, `abandonment.via: "recover"`, `recovery.disposition` matching what happened to `tx.staging` |
| no code switch (contract 1) | `readlink current`, `readlink previous`, and a listing digest of `releases/` (names, types, sizes, per-file sha256) are equal before and after `recover` |
| only the recorded source starts (contract 2) | the fake `systemctl` start log has exactly one start, after V1-V5 passed; after it V6 holds |
| service and next step | service active with the source identity; the next update is admitted |

Negative controls (each separately, each recorded red):

1. `snapshot()` cleanup removed → the ordinary-failure case finds staging before any recovery (asserted at that point, so `recover` cannot hide it);
2. ref-first ordering reversed → the `recover:after-ref` / `after-retire` windows leave an active ref naming a retired transaction; the ref-settlement oracle fails;
3. step 6 removed → service-active oracle fails;
4. a `cut` that writes `previous` inside `recover` → no-code-switch oracle fails;
5. a `cut` that writes a file into an unrelated retained release → no-code-switch oracle fails;
6. retry of a retired transaction with `current` moved to another release → must refuse with zero starts; removing V3 from the retry path turns it red;
7. same, with the source release's native bytes changed → removing V4 turns it red;
8. same, with `runner.env` changed → removing V5 turns it red;
9. dead-owner check removed → a live-owner fixture is mutated and fails;
10. old generic refusal text → hint assertion fails;
11. `next` without the retired-by-`recover`-without-`completed` rule → the `before-start` cut case prints no command and fails;
12. `recovery.completed` written before V6 → the `after-start-before-v6` case finds nothing to resume and the V6 oracle fails;
13. step 6 starting from a transitional state → the `activating` case records a start and fails;
14. `retire` rerun that still calls `verifySnapshot` → the R7 case cannot finish and fails.

### 7.3 Where it runs

Both suites run on hakoniwa through `heavy-test-remote` (category `test`;
`sandbox-test` only if the cgroup fixture needs a user namespace). Nothing runs
against a production host, unit or Docker daemon.

## 8. Landing units

Each unit gets its own issue when it starts; L1 first.

| Unit | Contents | Depends on | Closure gate (test-pinned) | Closes |
|---|---|---|---|---|
| L1 | server table, rendering, `invocation` / `target_sha`, S1-S4, harness, enrolled fixture | — | all server rows `closed` except the four `rollback_*` rows `deferred(L1b)` | 584; 681 state/message |
| L1b | destructive rollback steps and resume (5.3), live fleet admission on resume, audit-only fleet record | L1 | no server row deferred | — |
| L2 | superseded by [issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709) N2 and N3 ([N3 plan](issue-709-n3-recovery-table.md)) | — | — | — |
| L3 | superseded by issue #709 N2 (restore phases) and N3 | — | — | — |
| L4 | correct 5-b refusal guidance | L1 (table, rendering, harness) | existing-store mismatch remains refused; guidance directs non-destructive rollback | 553 not planned after L4 lands |
| L5 | compose file set with override hashes | L1 (harness; the 681 recipe flips from "recoverable" to "admitted") | 681 recipe completes forward | 681 root |

## 9. Verification plan (summary)

- Every **(read, not run)** claim is measured by the L1 / L2 harness before the
  code it describes changes: the PhaseError trap, the 531 SQLite reproduction,
  R2's other two residues, the R7 `retire` rerun failure, the `accept` refusal after a `stopped`-with-ref
  restore, and code recovery when `current` already equals the source (the switch
  treats it as a no-op after the guard, `kaoiro-runner-switch.sh:240-246`).
- Negative controls as listed, each recorded with its red output.
- Full `server/deploy` and `runner` suites on hakoniwa at each landing commit.

## 10. Docs to update

- `docs/operations/server-update-and-rollback.md` 4.4: generated table; fix (1);
  both locks after a kill.
- `docs/operations/runner-update-and-rollback.md`: generated table; `recover`;
  lock recovery in its own subsection; `abandon` text unchanged in substance.
- `docs/reference/deployment/transactions-and-identity.md`: point to the tables.

## 11. Open decisions

None. R2 was decided by the operator on 2026-10-20 (see Decisions).
