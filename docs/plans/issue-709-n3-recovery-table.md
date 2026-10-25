---
title: N3 — runner recovery table, hint rendering and property test
status: proposed
last_updated: 2026-10-25
---

# N3 — runner recovery table, hint rendering and property test

Unit N3 of [issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709)
([parent plan](issue-709-release-reduction.md), sections 5, 7, 8 D4 and
9 U5). Base: `develop` at `2c5f34cc`, with N2 landed. N3 declares the
recovery contract of N2's eight phases as one table, renders every hint from
that table, and proves the table with a property test. It replaces units
L2/L3 of the [issue-695 plan](issue-695-transaction-state-table.md) on the
runner side. It does not build any state of the retired machine
(issue-695 plan section 5.4).

## 1. Decisions in this design

| Id | Decision | Alternative rejected, and why |
|---|---|---|
| N3-a | The table declares, for each phase and command, the outcome and the hint. N2's control flow keeps deciding. The property test checks that the actual outcome of every (phase, command) pair equals the table | Table-driven dispatch (issue-695 plan section 5.1). It would rewrite N2's control flow, which has just landed with 338 tests and 71 mutations, for no change in outcome. A consistency test gives the same single-contract guarantee |
| N3-b | One module, `runner/deploy/codex-state-recovery.mjs`, is the only source of hint text: the table, the refusal catalog and the renderer | Hint strings at each refusal site (today's state, R6) |
| N3-c | New read-only helper action `next <root>`. It prints the rendered commands for every unfinished record and for every terminal record with pending cleanup. It takes no lock | The `<uuid>` placeholder in the updater's lock-held message (`kaoiro-runner-update.sh:277`) |
| N3-d | The runbook's recovery table is generated from the module and pinned by a doc-equality test | A hand-written runbook table |

## 2. Commands

| Key | Command (always the recorded physical tool, `releases/<tx.tool>/deploy/…`) |
|---|---|
| RES | `kaoiro-runner-update.sh --install-dir <root> --resume-codex-transaction <uuid>` |
| REC | `kaoiro-runner-update.sh --install-dir <root> --recover-codex-transaction <uuid>` |
| RST | `kaoiro-runner-update.sh … --restore-codex-backup <snapshot-dir> --codex-home <home>` (a new restore admission) |
| PRN | `node …/kaoiro-runner-codex-state.mjs prune <root> <uuid>` |
| UPD | a new update: state-aware forward or same-native code-only |
| RBK | `kaoiro-runner-switch.sh --rollback` (manual old-tool return) |

The rendered path is `join(root, "releases", tx.tool, "deploy", …)`, never
`current`. Run 1 of section 3 asserts this.

## 3. The recovery table

"N2 test" names an existing test that already exercises the cell (title from
`runner/test/codexState*.test.ts` at `2c5f34cc`). "new" means that no test
drives that cell today, and the property test of section 4 adds it.
Every non-terminal row blocks UPD, RST, PRN and RBK for any other operation
with "Unresolved Codex transaction requires recovery". N3 makes this refusal
name the blocking UUID and render its RES/REC lines (section 5).

| Phase | Command | Preconditions (live, re-read) | Effect | Hint entry | N2 test |
|---|---|---|---|---|---|
| `prepared` | RES | current = source; stop, B5 | snapshot (or adopt a complete owned destination), `snapshot-verified`, then as below | `forward.resume` | new |
| `prepared` | REC | current = source | adopt or mark the destination; clean owned staging (path and size recorded); `failed`; start source; post-start checks | `forward.recover-source` | KeepSafety "resumes source after copy-fault/backup-fault" (in-run); "keeps failed staging cleanup named…" |
| `snapshot-verified` | RES | stopped state equals snapshot, else refuse naming REC | `start-intent` under the links lock; switch to target; start; post-start; `completed` | `forward.resume` | Recovery "refuses stale snapshot reuse after a source boot but keeps recover usable"; the forward default path |
| `snapshot-verified` | REC | current = source | save `failed` before the start request; start source; post-start checks | `forward.recover-source` | KeepSafety "reports %s as failed source recovery" (4); Workflow "recovers a verified record with a missing snapshot…" |
| `start-intent` | RES | current ∈ {source, target}; target active → post-start only | stop, B5, snapshot equality, switch, start, `completed` | `forward.resume` | Recovery "records forward intent before independent boot" (2); Workflow "retains start-intent when the actual CLI reports %s" (2) |
| `start-intent` | REC | — | restore admission from the record's snapshot: `restore-prepared` → `replace-intent` → `restored` | `forward.recover-restore` | Recovery boot-ordering cases (restore leg) |
| `start-intent` | RBK, code-only return | — | refuse | `forward.recover-restore` | KeepSafety "never treats changed phase start-intent as a pre-start source return" |
| `restore-prepared` | RES | current = `replacement.from`; stop, B5 | rebuild and verify owned staging; `replace-intent`; section 5 of N2 | `restore.resume` | Recovery "restores the same snapshot twice…" |
| `restore-prepared` | REC | current = `replacement.from` | cancel: clean staging, restore `priorPhase`, start `from` only if admission began active | `restore.cancel` | Recovery "cancels an admitted restore before replacement…"; KeepSafety "restarts a failed restore only if admission began %s" |
| `replace-intent` | RES or REC | one of the four admissible H/S/Q layouts (N2 section 5) | finish the same replacement; `restored` | `restore.resume` | Recovery "finishes after independent boot at …" (16); "resumes %s home rename…" |
| `replace-intent` | any | any other layout | refuse, preserve all objects | `integrity.manual-repair` | Recovery "preserves all objects when staging is corrupt %s"; "refuses the switch guard with %s…" |
| `completed`, `restored` | RES, REC | — | no-op (terminal) | none | Workflow "rejects unknown mode and development option before touching a completed operation" (no-op path is new) |
| `completed`, `restored` | RST | named retained snapshot verifies | restore admission | `terminal.restore` | Recovery "restore-selection" (2), "restore cancellation and consecutive selection" |
| `completed`, `restored`, `failed` | PRN | terminal; no unfinished replacement uses the snapshot | `prune-intent`, removal, `retired` | `terminal.prune` | Workflow "retries durable prune intent with %s" (4); "persists prune intent before actual partial recursive deletion…" |
| `failed` | REC | current = source | retry the source start only | `failed.retry-source` | new |
| `failed` with `cleanup.pending` | PRN | — | retry the exact recorded cleanup | `failed.cleanup` | Workflow "keeps failed staging cleanup named and retries it…" |
| any terminal | UPD | none unfinished; same-native or state-aware rules | new operation | none | Workflow forward cases |
| any terminal | RBK | same native; a pre-N2 target also needs no retained or pruning snapshot | rollback | `terminal.rollback` | Workflow "pin-guard and old tools" |
| old schema-1 record not terminal or not retired | any mutating command | — | refuse with the previous-tool guidance (helper L51) | `cutover.old-tool` | Workflow "blocks every remaining mutation entrance on an unresolved old %s" (2) |

A stale `.lock.update` or `.lock.links` is not a phase: the refusal renders
the stale-lock procedure anchor, then `next <root>` (section 5).

## 4. Property test

### 4.1 Layer 1, fast tier (`runner/test/codexStateRecoveryTable.test.ts`)

These are pure checks. They do not start any process.

- Inventory: the table's phase keys equal the helper's exported `PHASES`
  (exported for this purpose). The commands per row equal the six keys of
  section 2. A cell either names a hint entry or is explicitly `none`.
- Rendering: every hint entry renders argv whose first element is a path
  under `releases/<tool>/deploy/` and whose options include exactly one of
  RES, REC, RST or PRN, or a runbook anchor. A rendered UUID equals the
  record's UUID.
- Refusal catalog: a source scan of the helper's closure
  (`kaoiro-runner-codex-state.mjs`, `codex-service.mjs`,
  `codex-snapshot.mjs`, `codex-native.mjs`) collects every literal message of
  `must(…)` and `new Error(…)`; template literals contribute their prefix
  before `${`. Each message must have one catalog entry, and each catalog
  entry must match a message. Today that is 144 `must` and 16 `new Error`
  sites, including duplicates. The same check covers the Codex-related
  `kaoiro_die` lines of the updater, switch and install scripts (section 5).
- Anchors: every anchor named by the catalog exists in its Markdown file.
- Runbook: the generated table in `runner-update-and-rollback.md` is equal
  to the module's rendering.

### 4.2 Layer 2, integration tier (`runner/test/codexStateRecoveryProperty.test.ts`)

This layer drives the real shipped updater with the existing state fixture
and its fake service manager.

- Enumeration. The test builds its case list from the table, not by hand.
  - For each non-terminal phase p, it reaches p through the real updater and
    `interruptStateWorker` with the existing checkpoint
    `{phase: p, when: "after"}`.
  - For `start-intent` it adds `{phase: "start-intent", when: "before"}` and
    the `promote` checkpoint.
  - For `replace-intent` it adds the first H→Q rename cut.
  - For each terminal phase it lets the operation finish.
  - Then, for every command cell of that phase, it runs one case.
- Hint under test. A case never calls a command directly. It first takes
  the refusal of the next plain invocation, either the lock-held message or
  the exclusion refusal. If the refusal names the stale-lock anchor, the test
  removes the two lock directories of the worker it killed itself. It then
  runs `next <root>` and executes exactly one of the rendered lines: the one
  the cell's command selects. A missing line fails the case.
- Oracle per case:
  - outcome: the record's final phase equals the table cell's target, and a
    refusal cell ends with zero mutations (listing digest of `releases/`,
    `current`, `previous`, every record's bytes, the start log of the fake
    service manager);
  - no code-only return: after REC on `start-intent`, the source is selected
    only through `restore-prepared` → `replace-intent`;
  - the start order: the fake service manager logs the record's phase at
    each start request; no source start happens before `failed` or
    `startRequested` is durable (the pin added in N2 implementation review
    r1);
  - state: credentials exist in exactly one location and keep their bytes;
    every aside named in any record exists;
  - residue: no unrecorded staging directory remains; a pending cleanup is
    listed by `next`.
- Determinism: the checkpoints are the fixture's existing record and rename
  hooks. The only kills are SIGKILL to PIDs that the test started and
  verified (start time checked). There are no timers other than the existing
  15 s deadline.
- Expected size: about 26 cases. That is 8 phases with 1 to 3 cuts each,
  times the non-`none` cells, after removing duplicates where two cells reach
  the same command path.
- Expected time (estimate, not measured): 12 s per case, the measured mean
  of `codexStateRecovery` in CI run 40148732194 (680 s for 56 cases), so
  about 5 min of accumulated test time. CI runs files in parallel and the
  longest file today takes 758 s, so the job wall time should change
  little. U5 reports the actual effect.
- Where it runs: CI complete tier, because it is in the integration list of
  `runner/test-tiers.json`. During development it runs on hakoniwa through
  `heavy-test-remote`.

### 4.3 Outside CI (real service manager and real native)

These checks are not part of CI. They run once at implementation acceptance,
by the implementer and again by the reviewer, under command-line rule
exception 5. They use the N2 probe scripts, which are not committed:

- real native one-turn rollout persistence, close, snapshot and restore, and
  same-thread resume, with the no-turn negative;
- real user systemd: a forward interrupted at `start-intent`, then
  `next` → the rendered REC line → `restored`, with prefix count 0 before and
  after.

## 5. Hint rendering

`codex-state-recovery.mjs` exports:

- `TABLE`: one row per phase, and one cell per command (section 3).
- `REFUSALS`: message → class.

  | Class | Rendered |
  |---|---|
  | `transaction` | the selected record's `next:` lines |
  | `config` | a runbook anchor: environment, unit or classification |
  | `integrity` | a runbook anchor: preserve objects, manual repair or fresh setup |
  | `usage` | a usage line |
  | `transient` | rerun the same command; the record's `next:` lines |

- `render(record, root)`: the `next:` lines and the `see:` anchor.

The output shape is:

```text
codex-state: <message>
next: <root>/releases/<tool>/deploy/kaoiro-runner-update.sh --install-dir <root> --resume-codex-transaction <uuid>
next: <root>/releases/<tool>/deploy/kaoiro-runner-update.sh --install-dir <root> --recover-codex-transaction <uuid>
see: docs/operations/runner-update-and-rollback.md#<anchor>
```

Sites that change. Every one of them renders through the module, and none
keeps its own command text:

| Site | Today | N3 |
|---|---|---|
| helper `main()` catch (L493) | `codex-state: <message>` | message plus class rendering for the action's record |
| helper `run()` catch (L437) | free-text resume/recover line | `render(tx)` |
| helper `exclude()` (L117) | "Unresolved Codex transaction requires recovery" | adds the blocking UUID and its `next:` lines (closes implementation review r1 nit 1) |
| helper `withLock()` (L113) | free-text stale-lock guidance | stale-lock anchor plus `next <root>` |
| helper old-record refusal (L51) | path and runbook file | anchor `#old-records-and-barriers` |
| helper `returnSource` warning (L337) and `protected` warning (L465) | free text | `failed.cleanup` and `terminal.prune` rendering |
| updater lock-held (`kaoiro-runner-update.sh:276-277`) | `<uuid>` placeholder | runs `next <root>`, read-only |
| updater preflight refusals (L388, L391, L400), prune refusals (L446, L448) | fixed text | adds `see:` anchors; L388 and L391 also run `next <root>`, because `prepare` may already have published a record |
| switch (L164, L217), install (L205, L207) | fixed text | adds `see:` anchors; L164 runs `next <root>` when `--codex-transaction` was given |

When a resume fails in a pre-start phase, it settles `failed`. Its hint
then renders the `failed` row, so it no longer offers RES (implementation
review r1 nit 4). Review nits 1 and 4 belong to the hint class that N3
closes, so this design folds them in. Nit 2 (the build-format preflight runs
after `prepare`) is control flow, outside N3, and stays a follow-up issue.

## 6. Runbook

`runner-update-and-rollback.md`:

- "Resume and recover" becomes "Recovery table". The heading `## Resume and
  recover` is kept for the inbound links from
  `reference/deployment/transactions-and-identity.md:54` and
  `codex-home.md:269`. The section holds the generated table (section 4.1)
  and the reading of `next`.
- "Prune and owned staging cleanup" and "Stale operation locks" keep their
  anchors and point to the table rows instead of repeating the commands.
- "Old records and barriers" keeps its anchor, which the catalog uses.

`codex-home.md`: "Fresh setup after failed snapshot recovery" is the target
of the `integrity` class, and its anchor stays. "State-aware backup and
restore" links to the recovery table.

Inbound links checked at `2c5f34cc`:

- `runner-artifacts.md:125`, `production.md:287`, `runner-install.md:76`,
  `high-risk-change-release.md:422`, `codex-home.md:95`: link to
  `#codex-state-backup`, which is unchanged.
- `transactions-and-identity.md:54`, `codex-home.md:269`: link to
  `#resume-and-recover`, which is kept.
- `codex-home.md:275`: links to `#editing-the-runner-environment`, which is
  kept.

## 7. D4 and issue #695

Observed: L2 and L3 have no issue numbers. They are unit labels in
[issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695) and in
section 8 of its plan, which says each unit gets its own issue when it
starts, and neither started (operator hold, 2026-10-22). So there are no
numbers to reuse.

Recommendation:

- Do not file issues for L2 or L3.
- Record in a comment on issue #695 that L2 and L3 are superseded by
  issue #709 N2 and N3, with the carry table of the parent plan section 5.
- Mark the L2 and L3 rows of the issue-695 plan's section 8 table as
  superseded, with a link.
- Keep issue #695 open for L1b and L4 ([issue #553](https://github.com/sakuraiyuta/kaoiro/issues/553)).
- Close [issue #531](https://github.com/sakuraiyuta/kaoiro/issues/531) as
  fixed by N2, citing the tests below.

Reasons:

- One contract and one tracker: N3's tests are the closure evidence, and
  they live under issue #709.
- New L2 and L3 issues would exist only to be closed, and could later be
  mistaken for open work.
- The carry table keeps each issue-695 defect traceable.

R1–R7 against the landed code (read at `2c5f34cc`, not assumed):

| Defect | Status | Evidence |
|---|---|---|
| R1 `prepared` without a named exit | partly closed: `run()` failures name RES/REC (L437). A refusal after `prepare` published (updater L388/L391, and the build-format preflight) names nothing | N3 section 5 |
| R2 staging residue (issue #531) | closed by N2: owned cleanup records path and size; pending cleanup is retried by PRN | Workflow "keeps failed staging cleanup named and retries it…"; KeepSafety copy-fault |
| R3 killed worker at a pre-start phase | closed by N2: never-started return is chosen from the durable phase. The lock-held hint still prints `<uuid>` | KeepSafety "never treats changed phase…"; N3 `next` |
| R4 intermediate restore phases | closed by N2 | Recovery "finishes after independent boot…" (16) |
| R5 acceptance hint | retired | codexState "fails as an unknown action…" (`accept`) |
| R6 refusals without command or anchor | open; N3 | sections 4.1 and 5 |
| R7 interrupted retire/prune | closed by N2 | Workflow "retries durable prune intent with %s" (4), "recursive prune interruption" |

## 8. Verification plan

Negative controls, each run separately and each recorded red:

| Id | Mutation | Must fail |
|---|---|---|
| NC1 | delete one phase row from `TABLE` | layer 1 inventory |
| NC2 | add a phase to `PHASES` without a row | layer 1 inventory, and the import-time assertion |
| NC3 | a hint entry that renders no command and no anchor | layer 1 rendering |
| NC4 | a hint entry that names the wrong option (REC for RES) | the layer 2 case for that cell (wrong final phase) |
| NC5 | the renderer uses `current` instead of `releases/<tool>` | the layer 2 case in which current is the target at `start-intent` |
| NC6 | a new `must()` message without a catalog entry; a stale catalog entry | layer 1 catalog, once for each |
| NC7 | a catalog anchor that does not exist | layer 1 anchors |
| NC8 | the runbook table edited by hand | layer 1 doc equality |
| NC9 | the updater lock-held message back to the `<uuid>` placeholder | layer 2 (no executable line) |
| NC10 | `exclude()` without the UUID | layer 2 rival cases |
| NC11 | REC on `start-intent` routed to source return | layer 2 no-code-return oracle (N2 already refuses this; the mutation is applied to the routing) |
| NC12 | the source start before `failed` (implementation review r1 MY3) | layer 2 start-order oracle, in addition to KeepSafety |

The catalog checker itself:

- One unrecorded message is added in an existing file and, separately, one
  in the new module. Each must fail on its own.
- With the checker's guard removed, the self-test must fail.

Also: runner typecheck; exact-head CI with all 7 jobs; the real-native and
real-systemd runs of section 4.3; U5 reporting (runner job wall time and
accumulated test time against run 39747478279).

Size (estimate):

| Part | Lines |
|---|---|
| Product: the new module | ~180 |
| Product: site changes | ~60 |
| Product: `next` action | ~25 |
| Tests: layer 1 | ~150 |
| Tests: layer 2 | ~300 |
| Docs | ~120 |
| Total | ~830 added and changed |

Classification: **L**. Reasons:

- operator-visible behaviour changes: hint text, the new `next` action and
  the runbook procedure;
- the recovery paths are a safety valve, even though N3 adds no transition;
- the shared state fixture is a surface touched by layer 2;
- the diff is over 200 lines.

## 9. Unmeasured premises

| Id | Premise | How it is settled |
|---|---|---|
| N3-U1 | The layer-2 cost is about 26 cases × 12 s, and CI wall time changes little | Measured on the first implementation candidate and reported with U5 |
| N3-U2 | `next` can read records without a lock while a worker writes them, because N2 publishes records by atomic rename | Read in code (`atomicJSON`), not measured. Layer 2 adds one case that runs `next` while a worker is paused at a record checkpoint |
| N3-U3 | Every refusal message is a literal or a template with a literal prefix, so the source scan can enumerate them | Checked by reading the 160 `must`/`Error` sites only roughly. The layer-1 scan fails closed on a non-literal message, so an exception is visible |
