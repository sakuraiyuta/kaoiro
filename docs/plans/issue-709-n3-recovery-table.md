---
title: N3 — runner recovery table, hint rendering and property test
status: proposed
last_updated: 2026-10-25
---

# N3 — runner recovery table, hint rendering and property test

Unit N3 of [issue #709](https://github.com/sakuraiyuta/kaoiro/issues/709)
([parent plan](issue-709-release-reduction.md), sections 5, 7, 8 D4 and
9 U5). Base: `develop` at `2c5f34cc`, with N2 landed. N3 declares the
recovery contract of N2's eight phases as one table of branches, renders
every hint from that table, and proves every declared branch with a property
test. It replaces units L2/L3 of the
[issue-695 plan](issue-695-transaction-state-table.md) on the runner side.
It does not build any state of the retired machine (issue-695 plan section
5.4).

Revision r2 answers design review r1 (must 2, should 4, nit 6). Both musts
are one class: a declaration that no test ties to the code. r2 closes that
class (section 1, N3-e), not the two instances.

## 1. Decisions

| Id | Decision | Alternative rejected, and why |
|---|---|---|
| N3-a | The table declares, per (phase, command), a list of **branches**: the live precondition, the outcome, the refusal message and class, and the hint entry. N2's control flow keeps deciding. The property test executes **every** declared branch and checks that the code's outcome and rendered hint equal the declaration | Table-driven dispatch (issue-695 plan 5.1). It would rewrite N2's reviewed control flow for no change in outcome |
| N3-b | One module, `runner/deploy/codex-state-recovery.mjs`, is the only source of hint text: `TABLE`, `GUARDS`, `REFUSALS` and `render()` | Hint strings at each site (R6 today) |
| N3-c | New read-only helper action `next <root> [<uuid>]` (section 5.3) | The updater's `<uuid>` placeholder (`kaoiro-runner-update.sh:277`) |
| N3-d | The runbook's recovery table is generated from the module, and a doc-equality test pins it | A hand-written runbook table |
| N3-e | Close the class "declaration without an executable tie": every declared item has exactly one mechanical tie, and an untied item fails layer 1 (table below) | Fixing the cited instances only. That was the r1 pattern twice |

| Declared item | Its tie | What fails when it is missing |
|---|---|---|
| Phase | `TABLE` keys equal the exported `PHASES` | layer 1 inventory |
| (phase, command) cell | at least one branch | layer 1 inventory |
| Branch | a layer-2 recipe with the same id; layer 2 runs exactly the branch-id set | layer 2 refuses to start (missing recipe), and a completeness assertion fails after the run |
| Refusal branch | its message key exists in `REFUSALS`, and the catalog class equals the branch class | layer 1 class equality |
| Refusal message in code | exactly one `REFUSALS` entry, found by the fail-closed scan of section 4.1 | layer 1 scan |
| Hint entry | its rendered option equals the cell's command key; its anchor exists | layer 1 rendering and anchors |
| Runbook table | equal to `render --runbook` | layer 1 doc equality |
| Cited N2 test | the cited title exists in the test sources | layer 1 citation check |

Director rulings recorded here:

- D4 is adopted as recommended (section 7).
- Implementation review r1 nits 1 and 4 of N2 are in N3's scope (section 5).
- Nits 2 and 3 stay in [issue #769](https://github.com/sakuraiyuta/kaoiro/issues/769).

## 2. Commands and rendered form

| Key | Command (always the recorded physical tool `<root>/releases/<tx.tool>/deploy/…`) |
|---|---|
| RES | `kaoiro-runner-update.sh --install-dir <root> --resume-codex-transaction <uuid>` |
| REC | `kaoiro-runner-update.sh --install-dir <root> --recover-codex-transaction <uuid>` |
| RST | `kaoiro-runner-update.sh --install-dir <root> --service <unit> --restore-codex-backup <snapshot> --codex-home <home>` |
| PRN | `<interpreter> kaoiro-runner-codex-state.mjs prune <root> <uuid>` |
| UPD | a new update: state-aware forward, or same-native code-only |
| RBK | `kaoiro-runner-switch.sh --rollback --install-dir <root>` |

How the commands are rendered:

- Every argv element is single-quoted, with `'` written as `'\''`.
- The interpreter for PRN is the helper's own `process.execPath`, the node
  that runs the helper. `prune` does not reach `verifyRelease`, so it needs
  no extra flags.
- In the generated runbook the interpreter is written `node`, as it is
  today.
- UPD is never rendered as a full command. Its hint is the runbook anchor
  `#codex-state-backup`.

## 3. The recovery table

Notation:

- **Outcome** is one of:
  - `→ <phase>`: a transition;
  - `settle`: the `run()` catch records `failed` and starts the source;
  - `held`: nonzero exit, with the phase unchanged after a stop;
  - `refuse`: zero mutation.
- **Class** is the class of the refusal message (section 5.1).
- **Pin** is the existing N2 test that drives the same path, or `—`. Layer 2
  drives every branch regardless, because no N2 test checks the rendered
  hint.

### 3.1 Guards common to entry points

A guard is evaluated before the first mutation of each entry point listed.
Layer 2 runs one refusal case per (guard, entry point) pair. A refusal is
not repeated for every phase, because the guard is a single call in that
entry point (cited by line).

| Guard | Message key | Class | Entry points (helper line at `2c5f34cc`) | Pin |
|---|---|---|---|---|
| G1 recorded tool | "Use the recorded physical updater tool" | `transaction` | `run` (L382) | — |
| G2 another unfinished record | "Unresolved Codex transaction requires recovery" | `transaction` (renders the blocking UUID) | `guard`, `prepare`, `prepare-restore`, `run`, `prune` (L117 callers) | Workflow "refuses %s before its first mutation with a second unfinished operation" |
| G3 current outside the operation | "Current is outside recorded operation" | `integrity` | `run` (L385), `guard` (L210) | Workflow "refuses %s before authorization" (`third-current`), Recovery "refuses a third current release before stop…" |
| G4 home or unit disagreement | `codex-service.mjs` binding messages | `config` | `run`, `guard`, `admitRestore`, `prepare` | Workflow "refuses restore admission with requested %s disagreement before stop" |
| G5 transitional activity | "Runner activity is transitional or unknown" | `transient` | every `runnerActivity` call | KeepSafety "handles %s without unsafe subsequent effects" |
| G6 a held lock | `withLock` "Lock held" / updater lock-held / `kaoiro_lock_acquire` | `lock` | `resume`, `recover`, `prune` (L478–L479); updater L275; switch, install and updater links lock | Workflow "preserves a held %s and takes no other unowned lock" |
| G7 old schema-1 record | "Resolve old Codex state records…" (L51) | `cutover` | every mutating action and `protected` | Workflow "blocks every remaining mutation entrance on an unresolved old %s" |

### 3.2 Forward phases

| Phase | Cmd | Branch | Precondition | Outcome | Class / hint | Pin |
|---|---|---|---|---|---|---|
| `prepared` | RES | P-RES-ok | current = source; B5 after stop | → `snapshot-verified` → `start-intent` → `completed` | — | — |
| | RES | P-RES-copy | snapshot copy or verification fails | settle | `failed` row | — |
| | REC | P-REC-ok | current = source | adopt or mark the destination; clean owned staging; → `failed`; source started | `failed` row | Recovery "recovers after dead worker at $phase…" (prepared) |
| | RST | P-RST-own | the record's own (planned) snapshot | refuse ("No unique retained snapshot matches selection") | `transaction`: P row | — |
| | PRN | P-PRN | — | refuse ("Prune requires a terminal operation") | `transaction` | — |
| | UPD, RBK | via G2 | — | refuse | G2 | as G2 |
| `snapshot-verified` | RES | V-RES-ok | stopped state equals the snapshot | → `start-intent` → `completed` | — | — |
| | RES | V-RES-stale | stopped state differs | settle | `failed` row | Recovery "refuses stale snapshot reuse after a source boot…" |
| | REC | V-REC-ok | current = source | → `failed`, saved before the start request; source started | `failed` row | Recovery dead worker (snapshot-verified) |
| | REC | V-REC-missing | snapshot directory missing | → `failed`, snapshot `retired` | `failed` row | Workflow "recovers a verified record with a missing snapshot…" |
| | RST | V-RST-own | the record's own snapshot | refuse ("Use never-started source recovery") | `transaction`: V row | — |
| | PRN, UPD, RBK | as for `prepared` | | refuse | | |
| `start-intent` | RES | S-RES-source | current = source; state equals the snapshot | switch → `completed` | — | — |
| | RES | S-RES-target | current = target, active | post-start only → `completed` | — | — |
| | RES | S-RES-attest | post-start check fails | held (`start-intent`) | `transaction`: S row | Workflow "retains start-intent when the actual CLI reports %s" (in-run) |
| | RES | S-RES-stale | current = source; state differs | held | `transaction`: S row (REC) | — |
| | REC | S-REC-ok | snapshot retained | → `restore-prepared` → `replace-intent` → `restored` | — | Recovery dead worker (start-intent); "records forward intent before independent boot…" |
| | REC | S-REC-nosnap | snapshot not retained or corrupt | refuse | `integrity` | Workflow "refuses recovery from a snapshot not marked retained" |
| | RST | S-RST-own | the record's own snapshot | → `restore-prepared` … `restored` (same path as REC) | — | — |
| | RBK | via G2 | — | refuse | G2 | — |
| | PRN, UPD | as above | | refuse | | |

### 3.3 Restore phases

| Phase | Cmd | Branch | Precondition | Outcome | Class / hint | Pin |
|---|---|---|---|---|---|---|
| `restore-prepared` | RES | R-RES-ok | current = `from`; B5 | → `replace-intent` → `restored` | — | — |
| | RES | R-RES-fail | failure during the run | the `run()` catch restarts `from` only if admission began active | `transaction`: R row | KeepSafety "restarts a failed restore only if admission began %s" |
| | REC | R-REC-cancel | current = `from` | cancel: clean the owned staging, restore `priorPhase`, start `from` if inactive, post-start (`unchanged`) | row of `priorPhase` | Recovery "cancels an admitted restore before replacement…" |
| | REC | R-REC-moved | current ≠ `from` | refuse ("Cancellation source link changed") | `integrity` | Workflow "refuses changed restore current before staging and source restart" |
| | RST | R-RST | — | refuse ("Replacement is already unfinished") | `transaction`: R row | — |
| | PRN, UPD, RBK | | | refuse | G2 / `transaction` | |
| `replace-intent` | RES, REC | Q-L1 … Q-L4 | one of the four admissible H/S/Q layouts (N2 section 5) | → `restored` | — | Recovery "finishes after independent boot at …" (16) |
| | RES, REC | Q-bad | any other layout | refuse; every object preserved | `integrity` | Recovery "preserves all objects when staging is corrupt %s" |
| | RES, REC | Q-cred | a credential in both locations or in neither | refuse | `integrity` | Recovery "refuses %s credential locations before promotion…" |
| | RST, PRN, UPD, RBK | | | refuse | as `restore-prepared` | |

### 3.4 Terminal phases

Terminal RES and REC are no-ops only after G1, G4 and the exclusion check
have passed.

| Phase | Cmd | Branch | Precondition | Outcome | Class / hint | Pin |
|---|---|---|---|---|---|---|
| `completed`, `restored` | RES, REC | T-noop | — | no-op | — | Recovery dead worker (`resume` after recover) |
| | RST | T-RST-ok | the named snapshot is retained and verifies | → `restore-prepared` … | — | Recovery "restores an explicitly selected older snapshot…" |
| | RST | T-RST-retired | the snapshot is retired | refuse | `transaction` (PRN done) | — |
| | PRN | T-PRN | — | → `prune-intent` → `retired` | — | Workflow "retries durable prune intent with %s" |
| | UPD | T-UPD | — | a new operation | anchor | forward cases |
| | RBK | T-RBK-ok, T-RBK-native, T-RBK-pre-n2 | same native; differing native; a pre-N2 target while a snapshot is retained | rollback; refuse; refuse | `config` | Workflow "refuses cross-native code-only switching with zero link mutations" |
| `failed` | RES | F-RES | — | no-op | — | — |
| | REC | F-REC-ok | current = source | retry the pending cleanup; mark a missing snapshot `retired`; start the source if inactive | — | — |
| | REC | F-REC-moved | current ≠ source | refuse (G3) | `integrity` | — |
| | RST | F-RST | retained | restore | — | Recovery "restores a terminal failed snapshot after later work…" |
| | PRN | F-PRN, F-PRN-cleanup | retained; `cleanup.pending` | prune; retry the exact cleanup | — | Workflow "keeps failed staging cleanup named and retries it…" |
| | UPD | F-UPD | after a copy fault | a new forward succeeds | — | added in N3 (issue #531 acceptance) |
| | RBK | as `completed` | | | | |

## 4. Property test

### 4.1 Layer 1, fast tier (`runner/test/codexStateRecoveryTable.test.ts`)

These are pure checks; no process is started.

- **Inventory.** The `TABLE` keys equal the exported `PHASES`, and every
  cell has at least one branch. Branch ids are unique.
- **Class equality.** For each refusal branch,
  `REFUSALS[branch.message].class === branch.class`. A message raised by
  branches of different classes is allowed only if it is listed in
  `SHARED_MESSAGES`, with the reason.
- **Rendering.** For each hint entry and a fixture record:
  - the rendered option equals the cell's command key;
  - argv[0] is `<root>/releases/<tool>/deploy/…` or the given interpreter;
  - the UUID is the record's;
  - quoting round-trips through `sh -c 'printf %s\\n "$@"'`.
- **Fail-closed scan.**
  - The closure is computed from the helper's static relative imports. At
    `2c5f34cc` this adds `verify-release.mjs` and
    `child-process-environment.mjs` to the four files of r1.
  - Each file is parsed with the TypeScript compiler API, already a
    devDependency.
  - Every `throw` is classified as one of:
    - `throw new <Error class>(<literal | template>)`;
    - a call to a declared thrower: `must`, `fail`, `failMissingArtifact`,
      `failMissingWorkspaceLink`;
    - a rethrow at a site listed in `RETHROWS`, with the reason.
  - Any other `throw`, and any thrower call whose message is not a literal
    or template, fails the scan.
  - A template contributes its literal prefix as the key.
  - Every key has exactly one `REFUSALS` entry, and every entry matches a
    site. Duplicate messages are listed in `SHARED_MESSAGES` (r1 nit 3).
- **Shell scan.**
  - Every `kaoiro_die` and hint `printf` in `kaoiro-runner-update.sh`,
    `kaoiro-runner-switch.sh`, `kaoiro-runner-install.sh` and
    `kaoiro-runner-common.sh` (including `kaoiro_lock_acquire`) has a
    `SHELL_REFUSALS` entry: a Codex class, `usage`, or `none`.
  - Selection is by file, not by keyword.
- **Anchors.** Every anchor named by `REFUSALS`, `GUARDS` or `TABLE` exists
  in its Markdown file.
- **Citations.** Every cited N2 test title exists in
  `runner/test/codexState*.test.ts`.
- **Runbook.** The table in `runner-update-and-rollback.md` equals
  `node runner/deploy/codex-state-recovery.mjs --runbook`.

### 4.2 Layer 2, integration tier (`runner/test/codexStateRecoveryProperty.test.ts`)

Layer 2 drives the real shipped updater with the existing state fixture and
its fake service manager. The fixture is created with a **distinct physical
tool** (`toolId`), so `current/deploy` and `releases/<tool>/deploy` are
different files (r1 should 3).

- **Enumeration.** The case list is `TABLE`'s branch ids plus the
  (guard, entry point) pairs of section 3.1. Each id needs a recipe from
  `RECIPES`. A missing recipe throws before any case runs. After the run,
  the executed id set must equal the declared set.
- **Reaching a phase.** Through the real updater and `interruptStateWorker`,
  using the existing checkpoints: `{phase, when}`, the `promote` cut, and
  the H→Q rename cut. Terminal phases are reached by finishing.
- **Reuse.** All `refuse` branches of one reached state run in sequence on
  that state. Each one asserts zero mutation (below), which also makes
  reusing the state valid. A perturbation recipe (move `current`, edit
  `runner.env`, create a lock directory, add an old record) is undone
  afterwards, and the digest must equal the state before the perturbation.
  Each progress branch (`→`, `settle`, `held`) gets a freshly reached state.
- **Hint under test.** A case does not call a command directly. It uses one
  of two lines:
  - a non-terminal record: the line that `next <root>` renders for the
    cell's command key;
  - a terminal record: the line from `next <root> <uuid>`.

  If the next plain invocation was refused by G6, the test first removes the
  locks of the worker it killed itself, as the hint says. One case runs its
  line through `sh -c` with an install root that contains a space and a
  `'`.
- **Oracle per branch:**
  - outcome:
    - the final phase equals the declaration;
    - `settle` additionally requires `failed` and one source start;
    - `held` requires the unchanged phase and a nonzero exit;
  - zero mutation, for `refuse`: the digest of `releases/` (names, types,
    sizes, per-file sha256), `current`, `previous`, every record's bytes,
    the home listing, and the fake service manager's call log are all
    unchanged;
  - the message and the hint: stderr contains the declared message, and the
    rendered `next:` and `see:` lines equal `render()` for that class;
  - the start order: the fake service manager logs the record phase at each
    start request, and no source start happens before `failed` or
    `startRequested` is durable;
  - no code-only return: after REC on `start-intent`, the source is selected
    only through `restore-prepared` → `replace-intent`;
  - state: each credential exists in exactly one location with its original
    bytes, and every aside named in any record exists;
  - residue: no unrecorded staging remains, and a pending cleanup is listed
    by `next`.
- **Unclassified fallback.** One case injects an `EIO` from `lstatSync`
  through the fixture's fault preload. It expects the `unclassified`
  rendering: the message, the record's `next:` lines and
  `see: …#recovery-table`.
- **`next` while paused.** One case runs `next` while a worker is paused at
  a record checkpoint (N3-U2).
- **Determinism.** The checkpoints are the fixture's existing record and
  rename hooks. The only kills are SIGKILL to PIDs that the test started and
  verified (start time checked). There are no timers other than the existing
  15 s deadline.
- **Size and time (estimate).**
  - About 55 phase branches and 20 guard pairs. About 20 of them are
    progress branches that need a fresh state.
  - Progress branches: 20 × ~12 s (the measured mean of
    `codexStateRecovery` in CI run 40148732194: 680 s for 56 cases).
  - Refusals on a reused state: 55 × ~2 s.
  - So about 6 min of accumulated test time in a separate file that runs in
    parallel with the others.
- **Threshold (r1 nit 6).**
  - Baseline: N2's landing run 40153723223, whose runner job took 14 min 42 s.
  - If the N3 candidate's runner job takes more than 2 min longer, split
    layer 2 into a progress file and a refusal file so that they run in
    parallel.
  - Branches are never dropped to meet the time.
  - U5 also reports the comparison with run 39747478279 (11 min 25 s).
- **Where it runs.** In the CI complete tier (integration list of
  `runner/test-tiers.json`). During development, on hakoniwa through
  `heavy-test-remote`.

### 4.3 Outside CI (real service manager and real native)

These checks are not part of CI. They run once at implementation
acceptance, by the implementer and again by the reviewer, under
command-line rule exception 5, with the N2 probe scripts (not committed):

- real native: one-turn rollout persistence, snapshot and restore, and
  same-thread resume, with the no-turn negative;
- real user systemd: a forward interrupted at `start-intent`, then
  `next <root>` → the rendered REC line → `restored`;
- prefix unit count 0 before and after.

## 5. Hint rendering

### 5.1 Classes

| Class | Rendered after the message |
|---|---|
| `transaction` | the selected record's `next:` lines (its row's entries) |
| `config` | `see:` an anchor (`#editing-the-runner-environment`, or the `codex-home.md` classification anchors) |
| `integrity` | "preserve every named object", then `see: codex-home.md#fresh-setup-after-failed-snapshot-recovery` |
| `transient` | rerun the same command: the record's `next:` lines |
| `lock` | `see: #stale-operation-locks`, then the output of `next <root>` |
| `cutover` | `see: #old-records-and-barriers` |
| `usage` | the usage line only |
| `unclassified` | the message, the record's `next:` lines when a UUID argument is present, and `see: #recovery-table` |

### 5.2 Sites

Every site renders through the module, and no site keeps its own command
text.

| Site at `2c5f34cc` | Today | N3 |
|---|---|---|
| helper `main()` catch L493 | `codex-state: <message>` | class rendering; a key that is not cataloged gets `unclassified` |
| helper `run()` catch L437 | a free-text RES/REC line | `render(tx)`. After a pre-start settle it renders the `failed` row, so RES is no longer offered (N2 implementation review r1 nit 4) |
| helper `exclude()` L117 | no UUID | the blocking UUID and its `next:` lines (N2 implementation review r1 nit 1) |
| helper `withLock()` L113 | free text | `lock` |
| helper L51 old record | path and runbook file | `cutover` |
| helper L337 and L465 warnings | free text | `failed` / `terminal` rendering |
| updater L275–L278 lock-held | `<uuid>` placeholder | `lock`; `next <root> || true`, so the exit stays 75 |
| updater L393 `target` and L395 build-format preflight | no message (L393), or fixed text after a published record (L395) | `next <root> <uuid>` for the published record (r1 should 2) |
| updater L388, L391 (prepare failed, no record), L400 (no record), L446, L448 | fixed text | `see:` anchors |
| `common.sh` `kaoiro_lock_acquire` L85–L89, reached by the switch, install and updater links lock | "remove a stale lock dir" | `lock` wording with the anchor; callers holding a Codex root also run `next <root> || true` |
| switch L164, L217; install L205, L207 | fixed text | `see:` anchors; L164 runs `next <root>` when `--codex-transaction` was given |

### 5.3 `next`

`next <root>`:

- prints, for each unfinished v2 record, its UUID, phase and the `next:`
  lines of its row;
- prints the PRN line for each terminal record with `cleanup.pending`;
- for each of `.lock.update` and `.lock.links`, prints `lock present: <path>`.
  It does not judge whether the owner is alive (r1 nit 2).

With an unresolved schema-1 record it prints the `cutover` rendering and
exits 0, instead of failing in `cutover()`. A read failure prints the
`unclassified` rendering and exits 78.

`next <root> <uuid>` prints that record's whole row, including the terminal
entries `terminal.restore`, `terminal.prune` and `terminal.rollback`.

`next` takes no lock and writes nothing. N2 publishes records by atomic
rename and filters temporary names; N3-U2 measures this.

## 6. Runbook

This completes the parent plan's "final runbook rewrite" for the runner.
N2 already rewrote the rest in `86c409c1`. In
`runner-update-and-rollback.md`:

- "Resume and recover" keeps its heading for the inbound links
  (`reference/deployment/transactions-and-identity.md:54`,
  `codex-home.md:269`). Its body becomes:
  - the generated recovery table, from
    `node runner/deploy/codex-state-recovery.mjs --runbook`;
  - how to read `next <root>` and `next <root> <uuid>`;
  - the quoting note.
- A new `### Recovery table` anchor is added inside it as the `see:` target.
- "Prune and owned staging cleanup", "Stale operation locks" and "Old
  records and barriers" keep their anchors, which the catalog uses. Their
  commands are replaced by links to the table rows.

In `codex-home.md`, "Fresh setup after failed snapshot recovery" stays as
the `integrity` target, and "State-aware backup and restore" links to the
table.

Inbound links found by grep at `2c5f34cc`, all kept:

- to `#codex-state-backup`: `runner-artifacts.md:125`, `production.md:287`,
  `runner-install.md:76`, `high-risk-change-release.md:422`,
  `codex-home.md:95`;
- to `#resume-and-recover`: `transactions-and-identity.md:54`,
  `codex-home.md:269`;
- to `#editing-the-runner-environment`: `codex-home.md:275`.

## 7. D4 and issue #695 (adopted)

L2 and L3 have no issue numbers. They are unit labels in
[issue #695](https://github.com/sakuraiyuta/kaoiro/issues/695) and in
section 8 of its plan, and neither unit started.

At N3 landing, the director:

- comments on issue #695 that L2 and L3 are superseded by issue #709 N2 and
  N3, with the carry table of the parent plan section 5;
- keeps issue #695 open for L1b and L4
  ([issue #553](https://github.com/sakuraiyuta/kaoiro/issues/553));
- closes [issue #531](https://github.com/sakuraiyuta/kaoiro/issues/531),
  citing KeepSafety "resumes source after %s with recoverable residue" (`copy-fault`) and N3's new F-UPD
  case: a new forward after the copy fault succeeds without a manual move
  (r1 should 4).

N3's docs commit marks the L2 and L3 rows of the issue-695 plan's section 8
table as superseded, with the link.

| Defect | Status at `2c5f34cc` | Closed by |
|---|---|---|
| R1 `prepared` without a named exit | partly: `run()` failures name RES/REC; L393 and L395 name nothing | N3, section 5.2 |
| R2 staging residue (issue #531) | fixed | N2; F-UPD pins the retry |
| R3 killed worker at a pre-start phase | fixed, apart from the `<uuid>` placeholder | N2; N3 `next` |
| R4 intermediate restore phases | fixed | N2 (Q-L1…Q-L4) |
| R5 acceptance hint | retired | codexState "fails as an unknown action…" |
| R6 refusals without command or anchor | open | N3, N3-e |
| R7 interrupted prune | fixed | N2 (T-PRN) |

## 8. Verification plan

Negative controls, each run separately and recorded red:

| Id | Mutation | Must fail |
|---|---|---|
| NC1 | delete a phase row | layer 1 inventory |
| NC2 | add a phase to `PHASES` without a row | layer 1 inventory, and the import assertion |
| NC3 | a branch with no recipe | layer 2 start |
| NC4 | an entry that renders REC for a RES cell | layer 1 rendered option = command key |
| NC5 | the renderer uses `current` | layer 2 (distinct tool): the executed line runs the wrong tool and G1 refuses |
| NC6 | a catalog entry whose class differs from the branch class (r1 example: "Source link changed before recovery" as `transient`) | layer 1 class equality |
| NC7 | a new `must()` message; a new `fail()` message in `verify-release.mjs`; a new bare `throw value` | layer 1 scan, each separately |
| NC8 | a new `kaoiro_die` without an entry | layer 1 shell scan |
| NC9 | a missing anchor; the runbook edited by hand; a cited title renamed | layer 1, each separately |
| NC10 | the updater lock-held message back to `<uuid>` | layer 2 G6 |
| NC11 | `exclude()` without the UUID | layer 2 G2 hint oracle |
| NC12 | REC on `start-intent` routed to source return | layer 2 no-code-return oracle |
| NC13 | the source start before `failed` (N2 implementation review MY3) | layer 2 start-order oracle |
| NC14 | the `main()` fallback removed | layer 2 unclassified case |
| NC15 | a refuse branch that stops the service first | layer 2 zero-mutation oracle |

The scan checker itself:

- An unrecorded message is added in an existing closure file, and
  separately in a newly imported file. Each must fail on its own.
- With the scan's own guard removed, its self-test must fail.
- A clean control (comments only) must pass.

Also: runner typecheck; exact-head CI with all 7 jobs; section 4.3; and U5
with its threshold.

Size (estimate):

| Part | Lines |
|---|---|
| Product: the module | ~260 |
| Product: sites | ~70 |
| Product: `next` | ~40 |
| Tests: layer 1 | ~250 |
| Tests: layer 2 and recipes | ~450 |
| Docs | ~140 |
| Total | ~1,200 |

Classification: **L**. Reasons:

- operator-visible behaviour changes: hint text, `next` and the runbook
  procedure;
- the recovery paths are a safety valve;
- the shared fixture is a surface;
- the diff is over 200 lines.

## 9. Unmeasured premises

| Id | Premise | Settled by |
|---|---|---|
| N3-U1 | Layer 2 costs about 6 min accumulated, and the runner job grows by less than 2 min | The first candidate's CI, compared against the section 4.2 threshold |
| N3-U2 | `next` reads records safely without a lock | Read in code (`atomicJSON`, temporary-name filter); the paused-worker case of layer 2 |
| N3-U3 | Every throw site is one of the scan's accepted forms | The fail-closed scan itself, on the first candidate. The design-time counts (`must` 144 and `new Error` 16 in four files; `fail()` and its variants in `verify-release.mjs`) are from grep, not from the parser |
| N3-U4 | Each guard is evaluated once per entry point, so one pair per entry point pins it | Code reading of the cited lines; the layer-1 citation check keeps the lines current only through the test titles, so the implementer re-reads them on the candidate |
