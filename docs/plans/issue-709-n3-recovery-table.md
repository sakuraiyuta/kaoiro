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

Revisions:

- r2 answered design review r1 (must 2, should 4, nit 6).
- r3 answered r2 (must 1, should 3, nit 3).
- r4 answers r3 (must 1, nit 3).

All four musts belong to one class: a declared item that no test ties to
the code. r4 closes it at every level that was still open:

- the walk's roots come from module namespaces, not from a list;
- every tie must fail on its own counterexample;
- the only default class makes no causal claim;
- the excluded files of the digest are derived from the recorders.

## 1. Decisions

| Id | Decision | Alternative rejected, and why |
|---|---|---|
| N3-a | The table declares, per (phase, command), a list of **branches**: the live precondition, the outcome, the refusal message and class, and the hint entry. N2's control flow keeps deciding. The property test executes **every** declared branch and checks that the code's outcome and rendered hint equal the declaration | Table-driven dispatch (issue-695 plan 5.1). It would rewrite N2's reviewed control flow for no change in outcome |
| N3-b | One module, `runner/deploy/codex-state-recovery.mjs`, is the only source of hint text: `TABLE`, `GUARDS`, `REFUSALS` and `render()` | Hint strings at each site (R6 today) |
| N3-c | New read-only helper action `next <root> [<uuid>]` (section 5.3) | The updater's `<uuid>` placeholder (`kaoiro-runner-update.sh:277`) |
| N3-d | The runbook's recovery table is generated from the module, and a doc-equality test pins it | A hand-written runbook table |
| N3-e | Close the class "declared item without an executable tie" mechanically: layer 1 walks the exported structures, and every field kind it finds must have a registered tie (below). No refusal class is chosen outside a branch or a guard | A hand-written tie table, which r2 used and which missed `REFUSALS` classes |

**Field walk (layer 1).**

- **Roots.** The walk has two roots, both found through a module namespace
  (`import * as`), not through a list of names (r3 must 1, fix 1):
  - every non-function export of `codex-state-recovery.mjs`;
  - every non-function export of the test declaration module
    `runner/test/codexStateRecoveryDecl.ts`, which holds `RECIPES`,
    `PRECONDITIONS`, `RECORDERS` and `TIES`. `RECIPES` and `PRECONDITIONS`
    are objects of functions, and their keys are walked.
- **Fields.** Under each root the walker enumerates the field paths that
  occur, for example `TABLE.<phase>.<command>[].message`, and looks each
  path pattern up in `TIES`.
- **Failures:**
  - an export that has no root entry in `TIES`;
  - a pattern that occurs but has no `TIES` entry;
  - a `TIES` entry whose pattern never occurs.
- **Counterexamples (r3 nit 2).** Every `TIES` entry carries
  `counterexample(declarations)`, which returns a modified copy that
  violates exactly that tie. The layer-1 self-test runs each entry's check
  on its counterexample and requires that check to fail. A check that
  passes everything (`() => true`) is therefore red. The walk also requires
  each entry to have a counterexample, so this rule has no exceptions.

The registry at r4. This table is a copy for the reader; the test module
is the source:

| Field pattern | Tie |
|---|---|
| `TABLE` keys | equal the exported `PHASES` |
| `TABLE.<phase>.<command>` | at least one branch; the command is one of section 2's keys |
| `…[].id`, `GUARDS[].id` | a `RECIPES` entry; layer 2's executed id set equals the declared set |
| `…[].precondition` | a `PRECONDITIONS` predicate that layer 2 evaluates as true before running the command |
| `…[].outcome` | the layer-2 outcome oracle |
| `…[].message`, `GUARDS[].message` | a key found by the scan of section 4.1, and seen in the case's stderr |
| `…[].class`, `GUARDS[].class` | the derived class of the message (section 5.1) and the layer-2 hint oracle |
| `…[].hint` | the rendered option equals the cell's command key; its anchor exists |
| `…[].pin` | the cited title exists in the test sources |
| `…[].site`, `GUARDS[].site` | a `// codex-recovery-site: <id>` marker in the code, on a line that calls the guard function (r2 nit 3) |
| `GUARDS[].entry` | layer 2 drives the case through that entry point |
| `REFUSALS.<key>.files`, `SHELL_REFUSALS.<key>.file` | the scan finds the key in exactly those files |
| `SHELL_REFUSALS.<key>.exit` | the exit status at the scanned `kaoiro_die` |
| `RETHROWS[].site`, `.reason` | a marker at the rethrow; a non-empty reason |
| `SHARED_MESSAGES[].message`, `.class`, `.reason` | the message is raised by two or more branches or guards; layer 2 expects `.class` for each of them |
| `RECORDERS.<id>.file`, `.writer` | the file name occurs as the write target in the named recorder's source (the fault preload, the fake manager, the node wrapper); it does not match any product name (`codex-state/`, `releases/`, `current`, `previous`, `.lock.*`, `.staging.*`, `.restore.*`, `.failed.*`, the snapshot directories, the home) |
| `RECIPES.<id>`, `PRECONDITIONS.<id>` | the id is a declared branch or guard id, or precondition name, and the reverse |
| `TIES.<pattern>` | the pattern occurs, and its counterexample fails its check |

`REFUSALS` and `SHELL_REFUSALS` have **no class field**. Adding one is an
unregistered pattern, so the walk fails (NC6).

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
- **Class** is declared on branches and guards only. The catalog derives
  each message's class from them. A message that no branch or guard raises
  renders as `unclassified` (section 5.1).
- **Pin** is the existing N2 test that drives the same path, or `—`. Layer 2
  drives every branch regardless, because no N2 test checks the rendered
  hint.

### 3.1 Guards before the first mutation

A guard row is one **call site**. The site id is the row's id, and it
matches a `// codex-recovery-site:` marker in the code.

- A guard row exists only where a refusal leaves zero mutation: before the
  stop, or at an entry point that has not changed anything yet.
- A guard function that is also called after the stop gets a phase branch
  for that site instead (section 3.5), because its outcome there is
  `settle` or `held`, not `refuse` (r2 should 1).
- Each row is driven once in layer 2.
- Lines refer to `2c5f34cc`, are for orientation only, and are not tied.
  The marker is the tie.

| Site id | Guard | Message key | Class | Entry and line | Pin |
|---|---|---|---|---|---|
| G1.run | recorded tool | "Use the recorded physical updater tool" | `transaction` | `run` L382 | — |
| G2.guard, G2.prepare, G2.restore, G2.run, G2.prune | another unfinished record (`exclude`) | "Unresolved Codex transaction requires recovery" | `transaction` (blocking UUID) | first call in each entry | Workflow "refuses %s before its first mutation with a second unfinished operation" |
| G3.run, G3.guard | current outside the operation | "Current is outside recorded operation" | `integrity` | L385, L210 | Workflow "refuses %s before authorization" (`third-current`) |
| G4.run-pre, G4.guard-entry, G4.restore, G4.prepare | home or unit disagreement (`checkBinding` / `captureBinding`) | the `codex-service.mjs` binding messages | `config` | L386, L212 when reached from switch, L242, L153 | Workflow "refuses restore admission with requested %s disagreement before stop" |
| G5.began, G5.pre-stop, G5.target-check, G5.resume-stop | transitional activity (`runnerActivity`) | "Runner activity is transitional or unknown" | `transient` | L380, L389, L401, L403 (all before `stopRunner`) | KeepSafety "handles %s without unsafe subsequent effects" |
| G6.helper, G6.updater, G6.switch-links, G6.install-links, G6.updater-links | a held lock | `withLock` "Lock held"; updater lock-held; `kaoiro_lock_acquire` | `lock` | L478–L479; updater L275; `common.sh` L85 callers | Workflow "preserves a held %s and takes no other unowned lock" |
| G7.guard, G7.prepare, G7.restore, G7.run, G7.prune, G7.protected | old schema-1 record (`cutover` through `records`) | "Resolve old Codex state records…" | `cutover` | first `records()` call in each entry | Workflow "blocks every remaining mutation entrance on an unresolved old %s" |

To reach G5 at a specific site, layer 2 sets the fake manager to report
`activating` from the n-th `ActiveState` query. The fixture's call log
gives n for each site. This needs no product change.

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

### 3.5 Guards after the stop (phase branches)

These sites run after `stopRunner` or after a start, so a failure there is
`settle` or `held`. Each is a branch with its own marker.

- The fake manager's existing hooks (`late-config`, `late-populated`,
  `late-unknown`, `remain-active`) or the record and rename checkpoints
  produce the precondition at the stop or the start.
- Because the outcome is not zero mutation, each branch gets a freshly
  reached state.

| Branch (= site id) | Phase / command | Site at `2c5f34cc` | Outcome | Pin |
|---|---|---|---|---|
| PS.snapshot-stopped | `prepared`, `snapshot-verified` RES | `takeSnapshot` L175 `assertStopped` | settle | KeepSafety "resumes source after %s with recoverable residue" (`late-unknown`) |
| PS.snapshot-binding | same | `takeSnapshot` L175 `checkBinding` | settle | — |
| PS.guard-nested | `snapshot-verified` RES | nested switch `guard` L212/L214 | settle (no `start-intent` saved) | — |
| PS.guard-nested-intent | `start-intent` RES, current = source | nested `guard` L212/L214 | held | — |
| PS.stage | `restore-prepared` RES | `stageRestore` L261 | the `run()` catch restarts `from` only if admission began active | KeepSafety "restarts a failed restore only if admission began %s" |
| PS.replace-stopped | `replace-intent` RES | `moveReplacement` L273 `assertStopped` | held | — |
| PS.replace-binding | `replace-intent` RES | `moveReplacement` L274 `checkBinding` | held | — |
| PS.after-switch | `start-intent` RES | `run` L414 | held | — |
| PS.post-start-active | `start-intent` RES | `postStart` L359 (active and MainPID) | held | Workflow "refuses unsafe post-start %s even when version succeeds" (`active`) |
| PS.post-start-binding | `start-intent` RES | `postStart` L361 `captureBinding` | held | same title (`next-path`, `service`) |
| PS.return-link | `prepared`, `snapshot-verified` REC | `returnSource` L333 | held; source not started; "source recovery refused" | KeepSafety "refuses source restart after %s" |
| PS.return-binding | same | `returnSource` L334 | held | — |
| PS.return-activity | same | `returnSource` L346 | held | — |
| PS.cancel-activity | `restore-prepared` REC | cancellation L398 | held | — |
| PS.catch-restore | `restore-prepared` RES failure, began active | `run()` catch L426/L427 | "source recovery refused"; held | — |

PS.return-link raises "Source link changed before recovery" (L333). That
gives the r2 NC6 message a branch (r2 must 1, item 3).

A site that calls two guard functions has one branch per function (r3
must 1, fix 3), so each function's messages get their own causal class. A
further message raised at the same site by a function that has no branch
renders `unclassified`, which makes no causal claim.

## 4. Property test

### 4.1 Layer 1, fast tier (`runner/test/codexStateRecoveryTable.test.ts`)

These are pure checks; no process is started.

- **Field walk.** The walk and the `TIES` registry of section 1 (N3-e). It
  covers inventory: phase rows, cells, unique ids, recipes, preconditions,
  markers and citations.
- **Class derivation.**
  - Every scanned message key gets one rendered class:
    - the class of the branches and guards that raise it;
    - for a `SHARED_MESSAGES` entry, that entry's class;
    - for a key that no branch or guard raises: `unclassified` for helper
      messages, and for shell lines `usage` (exit 64) or `none`.
  - A causal class (`transaction`, `config`, `integrity`, `transient`,
    `lock`, `cutover`) appears only on keys that a layer-2 branch or guard
    raises. Layer 1 asserts this for every key.
  - Two branches or guards that raise one message with different classes,
    without a `SHARED_MESSAGES` entry, fail.
  - The rendering function's class table is compared with this derivation
    for every key.
- **Rendering.** For each hint entry and a fixture record:
  - the rendered option equals the cell's command key;
  - argv[0] is `<root>/releases/<tool>/deploy/…` or the given interpreter;
  - the UUID is the record's;
  - quoting round-trips through `sh -c 'printf %s\\n "$@"'`.
- **Fail-closed scan.**
  - The closure is the **transitive** closure of the helper's static
    relative imports. At `2c5f34cc` this adds `verify-release.mjs` and
    `child-process-environment.mjs` to the four files of r1.
  - Each file is parsed with the TypeScript compiler API, already a
    devDependency.
  - Every `throw` is classified as one of:
    - `throw new <Error class>(<literal | template>)`;
    - a call to a declared thrower: `must`, `fail`, `failMissingArtifact`,
      `failMissingWorkspaceLink`;
    - a rethrow at a site listed in `RETHROWS`, with the reason.
  - The definitions of the declared throwers are exempt. Their bodies
    throw a parameter (r2 nit 1).
  - Any other `throw`, and any thrower call whose message is not a literal
    or template, fails the scan.
  - Dynamic `import()` and `createRequire` into a release
    (`codex-native.mjs` L20 and L35–L36, `verify-release.mjs` L667) cannot
    be scanned. Each is listed in `RETHROWS` with a marker. Errors from
    them reach `main()` and are rendered as `unclassified`.
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

- **Enumeration.** The case list is every branch id of sections 3.2–3.5
  plus every guard site id of section 3.1.
  - Each id needs a recipe from `RECIPES`, and each precondition needs a
    `PRECONDITIONS` predicate. A missing one throws before any case runs.
  - Before the command runs, the predicate must hold on the reached state.
  - After the run, the executed id set must equal the declared set.
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
  - zero mutation, for `refuse`: a digest of the **whole fixture directory
    tree** is unchanged. The digest records each entry's names, types,
    modes, sizes and sha256, and symlink targets. It covers the install
    root, records, snapshots, staging, asides, lock directories, the home
    with file contents, and the fake manager's state and call log (r2
    should 2). The excluded files are not declared by hand. They are
    exactly the `RECORDERS` outputs, and the `RECORDERS` tie checks each
    one against its writer's source and against every product name (r3
    must 1, fix 4);
  - the message and the hint: stderr contains the declared message, and the
    rendered `next:` and `see:` lines equal `render()` for that class;
  - the site, for sites that share one message and outcome (G5): the fake
    manager's `ActiveState` query count at the refusal equals the recipe's
    n, so a recipe that reaches another G5 site fails (r3 nit 1);
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
- **Size and time (estimate, r2 nit 2).**
  - Branches that need a fresh state: about 36 phase branches with
    `→`, `settle` or `held` outcomes, plus 15 post-stop branches (section
    3.5). That is about 51 cases at 12–19 s each (12 s is the measured mean
    of `codexStateRecovery` in CI run 40148732194: 680 s for 56 cases), so
    10–16 min accumulated.
  - Refusals and guard sites on reused states: about 50, at ~2 s each, so
    about 2 min.
  - Layer 2 is split from the start into three files that run in parallel:
    forward phases, restore and terminal phases, and refusals with guards.
    Each is expected to take under 6 min.
- **Threshold (r2 should 3).** The decision uses what N3 adds and vitest
  measures directly, not job wall time. Wall time varied by 3 min 07 s
  between two runs of the same product (CI runs 40152496802 and
  40153723223).
  - Each new file's reported duration must stay below the longest existing
    integration file in the same CI run (Workflow: 758 s in run
    40148732194). Above that, the new file becomes the job's critical path.
  - If a file exceeds it, split that file further. Branches are never
    dropped to meet the time.
  - U5 reports the accumulated test time and the runner-job wall time as
    the median of three runs on each side: the N3 candidate, and run
    39747478279 together with two later runs on the same base. These are
    reported, not used as a gate.
  - Worker saturation (r3 nit 3). The number of vitest workers on the CI
    runner is not measured (inferred to be about 3). U5 records it on the
    candidate. If saturation lengthens the job, the increase is accepted:
    N3 does not drop or merge branches for wall time. If the median grows by
    more than 5 min, the director decides on a follow-up issue for CI
    sharding of the runner suite. That issue is outside N3.
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

A message's class is derived, never chosen in the catalog:

- the class of the branches and guards that raise it (or its
  `SHARED_MESSAGES` entry);
- otherwise, one default that claims no cause (r3 must 1, fix 2):

| Origin | Default |
|---|---|
| any helper-closure module | `unclassified` |
| a shell `kaoiro_die` with exit 64 | `usage` |
| any other shell line | `none` (message only) |

A causal class therefore requires a branch or a guard that layer 2 drives.
Examples: B5 after the stop is `transient` only through
PS.snapshot-stopped and PS.replace-stopped; a classification refusal stays
`unclassified` unless a branch is added.

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
| NC6 | (a) a `class` field added to one `REFUSALS` entry; (b) a second branch that raises an existing message with another class, without `SHARED_MESSAGES`; (c) PS.return-link declared as `transient` | (a) field walk (untied pattern); (b) class derivation; (c) the layer-2 hint oracle for PS.return-link |
| NC7 | a new `must()` message; a new `fail()` message in `verify-release.mjs`; a new bare `throw value` | layer 1 scan, each separately |
| NC8 | a new `kaoiro_die` without an entry | layer 1 shell scan |
| NC9 | a missing anchor; the runbook edited by hand; a cited title renamed | layer 1, each separately |
| NC10 | the updater lock-held message back to `<uuid>` | layer 2 G6 |
| NC11 | `exclude()` without the UUID | layer 2 G2 hint oracle |
| NC12 | REC on `start-intent` routed to source return | layer 2 no-code-return oracle |
| NC13 | the source start before `failed` (N2 implementation review MY3) | layer 2 start-order oracle |
| NC14 | the `main()` fallback removed | layer 2 unclassified case |
| NC15 | a refuse branch that stops the service first | layer 2 zero-mutation oracle |
| NC16 | a refuse path that removes an owned staging directory, or leaves a lock directory | layer 2 whole-tree digest |
| NC17 | a guard site marker deleted, or moved to a line without the guard call | layer 1 marker tie |
| NC18 | a `TIES` entry removed | layer 1 field walk |
| NC19 | a new non-function export added to `codex-state-recovery.mjs`, and separately to the declaration module | layer 1 root check, each separately |
| NC20 | one `TIES` check replaced by `() => true` | layer 1 counterexample self-test |
| NC21 | a `RECORDERS` entry naming a product file (for example a record file name), and separately one whose writer does not write it | layer 1 `RECORDERS` tie, each separately |
| NC22 | a helper message given a causal class without a branch (for example through a new `SHARED_MESSAGES` entry with one raiser) | layer 1 class derivation and the `SHARED_MESSAGES` tie |
| NC23 | a G5 recipe aimed at L389 that reaches L380 | layer 2 query-count oracle |

Every `TIES` pattern has a counterexample, by the walk's own rule. The
patterns that r3 listed without a control (`…[].precondition`,
`SHELL_REFUSALS.<key>.exit`, `REFUSALS.<key>.files`, `RETHROWS[].site`)
are covered by NC20's self-test, one counterexample each.

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
| Tests: layer 1 | ~300 |
| Tests: layer 2 and recipes | ~600 |
| Docs | ~140 |
| Total | ~1,400 |

Classification: **L**. Reasons:

- operator-visible behaviour changes: hint text, `next` and the runbook
  procedure;
- the recovery paths are a safety valve;
- the shared fixture is a surface;
- the diff is over 200 lines.

## 9. Unmeasured premises

| Id | Premise | Settled by |
|---|---|---|
| N3-U1 | Layer 2 costs 12–18 min accumulated (about 51 fresh-state cases) in three parallel files, each under the longest existing integration file | The first candidate's CI, against the section 4.2 threshold |
| N3-U5 | The CI runner has about 3 vitest workers | Recorded by U5 on the candidate; saturation is accepted (section 4.2) |
| N3-U2 | `next` reads records safely without a lock | Read in code (`atomicJSON`, temporary-name filter); the paused-worker case of layer 2 |
| N3-U3 | Every throw site is one of the scan's accepted forms | The fail-closed scan itself, on the first candidate. The design-time counts (`must` 144 and `new Error` 16 in four files; `fail()` and its variants in `verify-release.mjs`) are from grep, not from the parser |
| — | (r2's N3-U4 is withdrawn) | Code reading showed it was false: G4 and G5 are evaluated at several sites, some after the stop. Section 3.1 now declares one row per site, and section 3.5 covers the post-stop sites. The markers tie every site |
