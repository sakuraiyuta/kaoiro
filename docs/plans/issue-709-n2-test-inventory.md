---
title: N2 — case-level test migration inventory
status: proposed
last_updated: 2026-10-25
---

# N2 — case-level test migration inventory

Part of the [N2 design](issue-709-n2-native-state.md), not an implementation
or a report that the replacements have passed. Source is
`8986936d9136fb7c7c7545f808543ceffe91dffd`, `runner/test/`.
Line numbers identify declarations at that baseline; parameter rows are
expanded individually. A row classified **K** retains an invariant and names
its destination/guard, even if it also removes receipt/lineage assertions.
**D** removes a retired contract and explains why. Internal loops/assertions
are included in the row's disposition; they are not additional Vitest cases.

`W` means `runner/test/codexStateWorkflow.test.ts`; `S` means
`runner/test/codexState.test.ts`. The suffixes name intended describe groups,
not new test files. Keep `codexHomeClassification.test.ts` and wrapper home
validation tests unchanged; add explicit-home integration coverage in W.
Reconcile new/changed cases from N1/P3 before implementation deletes anything.
In particular, N1's surviving S13 restart, stop-failure and pre-stop activity
cases must join W.source-recovery/W.stopped and the G10/G21 mutations.

Implement the replacement assertions first through the shipped helpers and
updater/switch entry points. Delete an old case only once its K row has an
identified passing replacement. Then remove the four retired files and the
lineage harness after an importer sweep. Record exact test names/candidate
SHA in implementation evidence; do not claim a file-level reference sweep
establishes invariant coverage. Do not delete an unlisted case without first
extending this inventory. The inventory intentionally retains broad semantic
coverage while removing the expensive receipt/lineage setup sequences.

## Guard mutations and destinations

For every new/rewritten guard and every retained guard whose sole coverage
is deleted, remove only that guard (or disconnect its caller), run the listed
replacement group, require a failing assertion, then restore and rerun. If
multiple affected checks share a row, mutate each separately. Unchanged
primitive/artifact tests keep their existing negative controls; this table
does not require rewriting or re-mutating unrelated unchanged guards. A full
suite remaining green for a required mutation is a blocking coverage gap.
Run mutations in the remote test environment on the implementation candidate.
Positive-only cases also name their paired negative control here.

| ID | Replacement group and specific mutation/negative control |
|---|---|
| G01 | W.restore-selection: bypass the selected snapshot/source agreement guard; a mismatched-source control must fail, while older and consecutive explicitly selected restores pass |
| G02 | S.records: independently bypass selected schema/UUID/path/private-file checks and phase/retention projection validation; malformed input must stop mutation/protection output |
| G03 | W.snapshot-binding: independently remove snapshot UUID, path, home, source release ID and native-hash comparisons; crossed but internally hash-consistent metadata must fail before stop |
| G04 | W.unfinished: remove exclusion at each forward/restore/guard/before-start/prune entry; an interrupted operation must prevent rival mutation and keep its snapshot |
| G05 | S.cutover: independently remove old unfinished-phase and unretired-backup rejection; every remaining mutating entry/protected refuses without altering old/v2 bytes; terminal/retired obsolete receipts pass |
| G06 | S.snapshot/S.restore-resume, W.restore-resume: include credential in snapshot; copy rather than move credential; delete aside on interruption (separate mutants); byte exclusion, inode preservation and both-state retention fail |
| G07 | W.unfinished/W.restore-selection, S.records: separately omit retained source, in-flight from/target and tool from protection; install/prune contender must fail the expected preservation assertion; terminal historical tool/target may be pruned |
| G08 | W.path-agreement: independently bypass explicit next-start home admission, live/next/requested and recorded-home comparisons or selected service ID check; mismatches refuse before subsequent mutation, while same-path config/inode edits pass |
| G09 | W.restore-resume: move intent after H publication, publish H before source link, repeat replacement after promotion, or overwrite the earlier aside list (separate mutants); boot writes, repeated resume and interrupted checkpoint cases must fail |
| G10 | W.source-recovery: move forward intent after link switch; bypass pre-start phase/source-only restart checks; save failed after source restart (separate mutants); boot and recovery-boundary cases must fail |
| G11 | S.ignored-barriers: reconnect a stale-barrier read/authority or removal at a state action; valid/damaged/dangling barrier twins must detect effects and preserve old objects |
| G12 | S.snapshot/W.snapshot-binding: independently bypass payload and manifest hash verification, omit WAL copying, or probe migration DB in place; corruption refusal and original-byte checks must fail |
| G13 | S.classification/W.classification: omit unknown-name, credential-symlink, external-session checks separately; drop migration-state classification or include runtime locks; corresponding classification assertion must fail |
| G14 | S.capacity/W.capacity: omit logical bytes, reserve, diagnostic-copy bytes/inodes, or post-stop recheck separately; refuse before the next copy/stop boundary specified in each case; sparse controls must not perform giant copies |
| G15 | S.path-parser/W.path-agreement: skip unsupported-expression refusal or ignore manager-selected environment file; literal and alternate-file twins must fail without executing shell payloads |
| G16 | S.pin-guard/W.pin-guard/W.same-pin: bypass native equality or backup requirement; cross-pin actions must fail with zero links/stop, same-pin terminal snapshots do not force state-aware update |
| G17 | S.artifact: bypass dangling-current, resolver agreement, native uniqueness/existence and required-runtime-member checks separately; each corresponding negative control fails, prose-only edits pass |
| G18 | S.removed-actions: reconnect a removed action or move unknown-action rejection after filesystem mutation; unknown action leaves locks/records unchanged |
| G19 | W.locks/S.removed-actions: bypass update/links lock acquisition separately or remove an unowned lock; live contenders and recorded lock sentinels must detect it |
| G20 | W.forward: independently omit active, positive MainPID, target/current, artifact or live-home post-start check; version success alone cannot mark completed |
| G21 | W.stopped/W.forward/W.source-recovery: bypass stop-error handling, inactive/MainPID/empty-cgroup check, unified-v2 check or initial activity read separately; no later copy/switch/start on unsafe stop, unchanged source restart only after safe failure |
| G22 | W.prune/W.snapshot-residue: omit durable prune intent, root identity, no-symlink/owned-path checks or cleanup publication separately; partial deletion retries, corrupt owned destination removal, reused path refusal and recorded staging cleanup must detect each mutant |
| G23 | W.writer-boundary: remove the single cooperative-writer warning; retained warning assertion fails (do not revive foreign-writer discovery) |

Groups may share replacements, but merge rows only when the replacement
asserts every retained property. The source line/title below keeps that
mapping auditable. Removal of obsolete assertions is not a reason to skip
the surviving semantic assertion in a mixed case.

## codexReceipt.test.ts

| Baseline line / case | Class | Disposition |
|---|---|---|
| L52: admits the older restore with the home identity from the latest accepted recovery | K | W.restore-selection; G01. Keep older-snapshot admission; drop receipt/inode assertions. |
| L63: publishes a complete version 1 receipt without the live process identity | D | S10 receipt shape and acceptance sequence. |
| L77: refuses a receipt without its accepted binding | D | S10 accepted binding receipt. |
| L78: refuses a restore receipt whose observed home identity is not a number | D | S9/S10 receipt inode typing. |
| L79: refuses a receipt carrying the live process identity | D | S10 receipt excludes live owner. |
| L80: refuses a receipt whose configuration differs from its own transaction | D | S9/S10 receipt/config equality. |
| L81: refuses an invalid acceptance sequence | D | S10 sequence validity. |
| L82: refuses acceptance published on a non-terminal transaction | D | S10 acceptance on terminal phase. |
| L83: refuses a terminal recovery without a receipt | D | S10 receipt required for terminal recovery. |
| L84: refuses an acceptance record in the pre-receipt shape on a modern transaction | D | S10 old acceptance shape. |
| L85: refuses a recovery recorded as completed instead of restored | D | S10 recovery receipt discriminator. |
| L86: refuses a modern recovery without a valid original reference | K | S.records; G02. Selected UUID/path validity remains; replace the removed backupUUID relationship. |
| L87: refuses a legacy transaction carrying modern acceptance fields | D | S14 modern/legacy acceptance discrimination. |
| L88: refuses an unsupported receipt version | D | S10 receipt version; v2 record schema has its separate G02 case. |
| L89: refuses an unknown transaction discriminator instead of treating it as legacy | D | S10/S14 receipt discriminator; selected v2 schema validation is independently required in S.records. |
| L90: refuses ambiguous acceptance sequences | D | S10/S12 ambiguous acceptance sequence. |
| L91: does not fall back to the older matching receipt when a newer accepted event does not match | D | S12 latest accepted event selection. |
| L92: refuses a recovery that names a different original forward | K | W.snapshot-binding; G03. Match selected snapshot UUID/source to its record; remove inter-record lineage. |
| L93: refuses a recovery whose original forward was never settled | D | S12 original-forward settlement relationship; both edited records are terminal, so this is not unfinished-operation exclusion. |
| L94: refuses a recovery whose backup reference disagrees with the original | K | W.snapshot-binding; G03. Match selected snapshot path/metadata; dual-registry equality disappears. |
| L104: refuses a recovery whose snapshot differs from its original's | K | W.snapshot-binding; G03. Snapshot path and selected record must agree; no recovery/original pair. |
| L105: refuses a recovery whose target native hash is not its original's source | K | W.snapshot-binding; G03. Snapshot source native hash must match the release to start. |
| L110: refuses a recovery whose target release is not its original's source | K | W.snapshot-binding; G03. Snapshot source release ID must match the release to start. |
| L114: refuses a recovery whose source release is outside its original's lineage | D | S12 historical source lineage restriction; independently selected older snapshot is allowed. |
| L118: refuses a recovery prepared before its original | D | S12 preparation order. |
| L119: refuses a recovery whose original forward is legacy | D | S14 legacy original relationship; cutover is covered by Legacy rows. |
| L120: refuses a recovery whose original is not a forward transaction | D | S12 original transaction mode relationship. |
| L121: refuses a legacy accepted event without a sequence | D | S10 legacy acceptance sequence. |
| L122: ignores accepted events recorded for another home | D | S12 accepted-event home filtering; no accepted-event scan remains. |
| L135: refuses a latest accepted recovery with a different unit | D | S9/S12 latest-event unit identity; selected operation service check lives in Lineage153. |
| L136: refuses a latest accepted recovery that is legacy | D | S14 latest legacy event restriction. |
| L137: refuses a selected reference that is legacy | K | S.cutover; G05. Old retained reference refuses before any mutation. |
| L144: retires a restored forward only through its accepted recovery | D | S12/S15 retirement through accepted recovery. |
| L167: exposes only a completed forward acceptance as a production completion fact | D | S17 completion collector export; P3 must remove its consumers first. |
| L219: keeps the receipt of a retired forward and admits the older restore through it | K | W.restore-selection; G01. Earlier snapshot remains restorable after another is pruned; drop receipt assertions. |
| L228: refuses when only the latest forward's target release differs | D | S12 latest historical target release equality. |
| L229: refuses when only the latest forward's target native hash differs | D | S12 latest historical target hash equality. |
| L230: refuses when only the latest forward's unit differs | D | S12 latest historical unit equality. |
| L231: refuses when only the latest forward's observed home inode is not the actual home | D | S9 latest accepted inode equality. |

## codexLineage.test.ts

| Baseline line / case | Class | Disposition |
|---|---|---|
| L20: restores C to B and then B to A with the inode carried by the accepted transaction | K | W.restore-selection; G01/G06. Consecutive selected restores recover state and preserve refreshed credentials; remove accepted-inode history. |
| L56: uses a later accepted forward, retired before the older restore, as the home identity | K | W.restore-selection; G01/G07. Pruned intermediate snapshot/release does not block earlier retained restore; current credentials survive. |
| L88: restores an unaccepted newest forward without borrowing an older accepted event | K | W.restore-selection; G01. Restore completed forward directly without acceptance. |
| L99: refuses the second restore before stop when the home was replaced after the first | D | S9 historical home inode equality; add same-path new-inode positive twin in W.path-agreement. |
| L122: restores through an in-place configuration revert but refuses a rename-style edit | K | W.path-agreement; G08. Same-path config edits allow restore; no identity receipt needed. |
| L138: refuses restore after a rename-style edit of the runner configuration | D | S9 config inode equality; replace refusal with same-path rename positive control in W.path-agreement. |
| L153: refuses restore when the unit identity changes | K | W.path-agreement; G08. Selected installed service ID must agree; hashes/inodes of its fragment are not compared. |

## codexLineagePending.test.ts

| Baseline line / case | Class | Disposition |
|---|---|---|
| L51: keeps the recovery pending after a failure at the reference save and finishes on a rerun | K | W.unfinished; G04/G07/G09. Preserve all mutating-entry refusals and needed release protection during an interrupted v2 restore; replace obsolete multi-record save boundary with a v2 checkpoint. |
| L51: keeps the recovery pending after a failure at the original forward save and finishes on a rerun | K | W.unfinished; G04/G07/G09. Preserve all mutating-entry refusals and needed release protection during an interrupted v2 restore; replace obsolete multi-record save boundary with a v2 checkpoint. |
| L51: keeps the recovery pending after a failure at the final receipt save and finishes on a rerun | K | W.unfinished; G04/G07/G09. Preserve all mutating-entry refusals and needed release protection during an interrupted v2 restore; replace obsolete multi-record save boundary with a v2 checkpoint. |
| L79: does not accept a recovery a second time when the final save fails after its rename | K | W.restore-resume; G09. Failure after terminal record rename must not repeat replacement; acceptance retry/sequence disappears. |
| L102: refuses to accept a recovery when another accepted recovery already names its original | D | S12 competing accepted recovery; repeated explicit restores of one snapshot are allowed. |
| L128: refuses to publish when the evidence changes while the recovery is settled | D | S10 evidence-change-during-settlement check. |
| L145: rejects a second unresolved transaction before the owned transaction passes guard or before-start | K | W.unfinished; G04. Second unresolved operation refuses both guard and before-start callers. |
| L165: closes the same window for a never-started code recovery whose home inode is unchanged | K | W.source-recovery; G04/G10. Persist failed before unchanged-source restart; new forward cannot reuse stale pre-start snapshot. Remove acceptance settlement window. |

## codexLegacy.test.ts

| Baseline line / case | Class | Disposition |
|---|---|---|
| L38: refuses to restore an accepted legacy reference before stopping | K | S.cutover; G05. Old retained reference blocks restore before stop. |
| L45: refuses a state-aware forward while an accepted legacy reference is retained | K | S.cutover; G05. Old retained reference blocks forward before stop. |
| L52: refuses to accept or recover an unfinished legacy transaction | K | S.cutover; G05. Old unfinished phase blocks every remaining mutating entry and protected; accept action itself is removed. |
| L73: allows an independent modern snapshot once every legacy reference is retired | K | S.cutover; G05. All-terminal/all-retired old records allow an independent v2 snapshot despite obsolete receipts. |
| L88: keeps the evidence and snapshot gates on explicit legacy retirement | D | S14/S15 legacy evidence and verify-before-retirement; explicit prune may discard corrupt state. |
| L104: treats a modern transaction with the pre-receipt acceptance shape as malformed everywhere | D | S10 receipt shape validation everywhere; malformed obsolete acceptance is ignored if cutover projection is terminal/retired. |
| L140: does not let a well-formed barrier with a different home inode bias a consecutive restore | K | S.ignored-barriers; G11. Barrier content has no effect and remains byte/identity unchanged; no inode lineage required. |
| L152: does not let a well-formed barrier naming a replaced home admit the restore | D | S9 replaced-home inode refusal; same-path replacement no longer refuses. Barrier non-authority retained by the other barrier rows. |
| L196: behaves like the no-barrier twin for prepare, acceptance and retirement | K | S.ignored-barriers; G11. Forward/restore/prune with or without a stale barrier behave identically; replace accept/retire assertions. |
| L204: ignores damaged and dangling barrier entries without touching them | K | S.ignored-barriers; G11. Damaged and dangling entries remain unread/unmodified through forward and restore. |

## codexState.test.ts

| Baseline line / case | Class | Disposition |
|---|---|---|
| L29: snapshots a real closed WAL database without changing source bytes | K | S.snapshot; G12. Retain real SQLite/WAL source-byte and migration-level checks. |
| L29: snapshots a real uncheckpointed WAL database without changing source bytes | K | S.snapshot; G12. Retain real SQLite/WAL source-byte and migration-level checks. |
| L53: excludes all current credentials, verifies state, and preserves refreshed credentials on restore | K | S.snapshot; G06/G12. Credentials excluded, refreshed entries moved, newer state preserved aside; update phase assertion. |
| L70: preserves native policy migration state and excludes stopped runtime locks | K | S.classification; G13. Preserve migration state and omit runtime locks. |
| L81: rejects unclassified entry auth.json.tmp before copying | K | S.classification; G13. Unknown names refuse before copy. |
| L81: rejects unclassified entry unclassified before copying | K | S.classification; G13. Unknown names refuse before copy. |
| L81: rejects unclassified entry unclassified-extension before copying | K | S.classification; G13. Unknown names refuse before copy. |
| L86: rejects credential symlinks without opening their targets | K | S.classification; G13. Credential symlink refuses without target access. |
| L90: rejects external session storage | K | S.classification; G13. External session storage refuses. |
| L94: rejects payload corruption and does not replace live state | K | S.snapshot; G12. Corrupt payload cannot replace live state. |
| L101: rejects manifest corruption | K | S.snapshot; G12. Manifest hash mismatch refuses. |
| L108: does not delete current credentials after a failed credential move | K | S.restore-resume; G06. Interrupted move retains credentials and is resumable. |
| L115: counts top-level diagnostic DB and sidecar copies without charging restore | K | S.capacity; G14. Diagnostic copy bytes/inodes counted only on snapshot. |
| L127: rechecks diagnostic bytes capacity before creating snapshot staging | K | S.capacity; G14. Recheck capacity before stage creation. |
| L127: rechecks diagnostic inodes capacity before creating snapshot staging | K | S.capacity; G14. Recheck capacity before stage creation. |
| L149: requires logical space plus reserve without performing a copy | K | S.capacity; G14. Logical size and reserve checked without copying. |
| L153: rejects shell execution and resolves only supported path expansions | K | S.path-parser; G15. Literal expansion only; shell execution rejected. |
| L174: permits unchanged native code | K | S.pin-guard; G16. Same native can switch with no unfinished operation. |
| L180: refuses a differing native pin through current with absent barrier directory on rollback and zero link mutations | K | S.pin-guard; G16. Cross-native unbacked switch refuses with zero current/previous mutations. |
| L180: refuses a differing native pin through current with absent barrier directory on forward switch and zero link mutations | K | S.pin-guard; G16. Cross-native unbacked switch refuses with zero current/previous mutations. |
| L180: refuses a differing native pin through current with absent registry on rollback and zero link mutations | K | S.pin-guard; G16. Cross-native unbacked switch refuses with zero current/previous mutations. |
| L180: refuses a differing native pin through current with absent registry on forward switch and zero link mutations | K | S.pin-guard; G16. Cross-native unbacked switch refuses with zero current/previous mutations. |
| L191: ignores a well-formed stale barrier whose hashes differ from the installation | K | S.ignored-barriers; G11. Stale barrier cannot block same-pin switch and remains untouched. |
| L202: still refuses a differing native pin when a stale barrier names the candidate's hash | K | S.pin-guard; G16. Stale barrier cannot authorize a cross-pin switch. |
| L211: rejects a dangling state-record directory instead of treating it as absent | K | S.records; G02. Dangling state root refuses. |
| L217: refuses dangling current instead of treating it as a fresh installation | K | S.artifact; G17. Dangling current is not fresh setup. |
| L224: refuses backend resolver disagreement | K | S.artifact; G17. Backend native resolvers agree. |
| L234: refuses multiple native candidates even when both backends select the same file | K | S.artifact; G17. Multiple native candidates refuse. |
| L243: refuses missing native payload | K | S.artifact; G17. Missing native refuses. |
| L248: strict deploy coverage detects kaoiro-runner-launch.sh removed with its manifest entry | K | S.artifact; G17. Required deploy runtime member must exist even if omitted from manifest. |
| L248: strict deploy coverage detects kaoiro-runner-codex-state.mjs removed with its manifest entry | K | S.artifact; G17. Required deploy runtime member must exist even if omitted from manifest. |
| L256: prose-only changes do not invalidate runtime coverage | K | S.artifact; G17. Prose edits leave runtime verification valid. |
| L268: is an unknown action | K | S.removed-actions; G18. Unknown action refuses before state creation. |
| L274: fails as an unknown action, not on a lock, while .lock.update is held | K | S.removed-actions; G18/G19. Unknown action does not take/delete another lock or create state. |
| L274: fails as an unknown action, not on a lock, while .lock.links is held | K | S.removed-actions; G18/G19. Unknown action does not take/delete another lock or create state. |

## codexStateWorkflow.test.ts

| Baseline line / case | Class | Disposition |
|---|---|---|
| L93: runs the shipped helper between stop and switch/start | K | W.forward; G06/G12/G20. Shipped helper orders stop/snapshot/switch/start and omits credentials; replace acceptance hint with completed post-check. |
| L102: keeps stop failure in the same control flow as switch/start | K | W.source-recovery; G10/G21. Late snapshot/classification failure restarts unchanged source without switch, reports only minimal phase metadata. |
| L122: restores verified old state while retaining the current token | K | W.restore-resume; G06/G09. Verified history restored, refreshed token retained through shipped updater. |
| L145: publishes the accepted binding receipt only after explicit actual-start/history acceptance | D | S10 receipt publication after explicit acceptance; new post-start completion independently covered by G20. |
| L163: refuses acceptance without history evidence | D | S10 history-evidence gate. |
| L176: retires an accepted snapshot with history evidence and keeps its receipt | K | W.prune; G22. Snapshot deletion remains; replace evidence/receipt assertions with prune intent and retired status. |
| L176: retires an accepted snapshot with new-session evidence and keeps its receipt | K | W.prune; G22. Snapshot deletion remains; replace evidence/receipt assertions with prune intent and retired status. |
| L196: refuses retirement without either history or explicit new-session evidence | D | S15 evidence requirement; explicit prune requires no history evidence. |
| L206: refuses retirement when the current release no longer verifies | D | S15 current-release attestation before evidence retirement; snapshot disposal does not activate current code. Activation attestation stays in G17/G20. |
| L218: refuses restoring an older retained reference before stopping | D | S12 newest-only refusal; inverse older-snapshot success is W.restore-selection. |
| L233: refuses a corrupt backup before stop or state replacement | K | W.snapshot-binding; G12. Corrupt snapshot refuses before stop or home replacement. |
| L243: rejects a self-consistent snapshot with crossed release metadata before stop | K | W.snapshot-binding; G03. Self-consistent but crossed release metadata refuses before stop. |
| L261: refuses malformed retention metadata instead of releasing protected code | K | S.records; G02/G07. Unknown retention state refuses instead of unprotecting releases. |
| L273: rejects an otherwise valid wrong home before stop | K | W.path-agreement; G08. Requested home differs: refuse before stop. |
| L280: rejects a next-launch home mismatch even when the live home agrees | K | W.path-agreement; G08. Next-start home differs: refuse before stop. |
| L288: rejects a live home mismatch despite agreement with next launch | K | W.path-agreement; G08. Actual live home differs: refuse before stop. |
| L296: includes manager-selected runner.env in the next-launch binding | K | W.path-agreement; G08/G15. Resolve the manager-selected runner.env then compare paths. |
| L306: rejects runner.env changes after stopping even if the home stays the same | D | S9 same-path config-byte equality; replace with same-path edit pass plus changed-path post-stop refusal (G08). |
| L314: continues with an explicit warning while an external process holds state | K | W.writer-boundary; G23. Independent-writer limit has one warning and does not revive retired probes. |
| L324: refuses a service still active after stop with no switch or start | K | W.stopped; G21. Active-after-stop refuses with no snapshot, switch or start. |
| L336: handles switch failure before-move without starting the candidate | K | W.source-recovery; G09/G10. Preserve state, credentials and source-only recovery under switch faults; after durable intent restore is required even before link move. |
| L336: handles switch failure after-move without starting the candidate | K | W.source-recovery; G09/G10. Preserve state, credentials and source-only recovery under switch faults; after durable intent restore is required even before link move. |
| L336: handles switch failure start-attempted without starting the candidate | K | W.source-recovery; G09/G10. Preserve state, credentials and source-only recovery under switch faults; after durable intent restore is required even before link move. |
| L336: handles switch failure recovery-failure without starting the candidate | K | W.source-recovery; G09/G10. Preserve state, credentials and source-only recovery under switch faults; after durable intent restore is required even before link move. |
| L362: refuses a host without unified cgroup v2 before snapshot or switch | K | W.stopped; G21. Unified cgroup v2 required before stop/copy/switch. |
| L376: refuses code-only recovery if its original startup proof changes before-switch | K | W.source-recovery; G10. Durable phase is re-read at switch/start boundaries; start-intent cannot take code-only return. |
| L376: refuses code-only recovery if its original startup proof changes before-start | K | W.source-recovery; G10. Durable phase is re-read at switch/start boundaries; start-intent cannot take code-only return. |
| L394: refuses code-only recovery redirected away from the original source | K | W.source-recovery; G10. Never-started return targets recorded source only. |
| L409: budgets the migration DB copy before stopping the runner | K | W.capacity; G14. Diagnostic DB capacity gate runs before stop or sparse copy. |
| L428: charges sparse files by logical size and rejects insufficient capacity before stop | K | W.capacity; G14. Sparse logical size gate runs before stop. |
| L437: rejects unclassified files before stopping the source | K | W.classification; G13. Unknown file rejects before stop. |
| L443: refuses an already stopped forward source | K | W.forward; G21. New forward needs active source; resume has its explicit stopped-source rule. |
| L449: refuses a differing-native update without a state backup before stopping | K | W.pin-guard; G16. Cross-pin update requires snapshot before stop. |
| L462: keeps a retained reference on the state-aware path for same-native code-only switching | D | Old retained-reference blanket state-aware gate; N2 allows same-pin code-only switching without an unfinished operation. |
| L472: lets a token edit through the code-only update path once nothing is retained | K | W.same-pin; G16. No retained state permits ordinary code-only update after environment edit; state-aware path agreement is separate. |
| L472: lets a changed CODEX_HOME through the code-only update path once nothing is retained | K | W.same-pin; G16. No retained state permits ordinary code-only update after environment edit; state-aware path agreement is separate. |
| L521: abandons a forward stranded at prepared, after which the update retries | K | W.source-recovery; G10/G21. Stop-check failure has a usable recover exit and later new update; remove abandon/owner evidence. |
| L541: abandons a forward stranded at stopped before its snapshot wrote anything | K | W.source-recovery; G10/G13. Snapshot failure before stage has recover/failed exit and later update. |
| L554: treats an owner PID reused by another process as gone | D | S11/S15 PID-reuse authority; recovery depends on durable phase, not owner PID. |
| L563: treats an owner PID with no /proc entry as absent | D | S11/S15 absent-owner authority; no process-owner evidence in recovery. |
| L588: refuses a live owner and leaves the record unchanged | D | S11/S15 owner-liveness authorization. |
| L588: refuses a malformed owner and leaves the record unchanged | D | S11/S15 owner-proof schema. |
| L588: refuses phase snapshot-verified and leaves the record unchanged | D | S15 abandon restriction; v2 pre-start recovery is allowed. |
| L588: refuses phase switch-authorized and leaves the record unchanged | D | S11/S15 removed phase and abandon action. |
| L588: refuses phase start-attempted and leaves the record unchanged | K | W.source-recovery; G10. Its v2 start-intent counterpart cannot recover code-only. |
| L588: refuses phase awaiting-acceptance and leaves the record unchanged | D | S10/S15 removed phase and abandon action. |
| L588: refuses phase restored and leaves the record unchanged | D | S15 abandon restriction; explicit new restore/prune allowed. |
| L588: refuses phase retired and leaves the record unchanged | D | S15 abandon restriction; prune is idempotent. |
| L588: refuses mode restore and leaves the record unchanged | K | W.restore-resume; G09/G10. Replacement cannot be discarded as pre-start forward recovery. |
| L588: refuses mode code-recovery and leaves the record unchanged | D | S11/S15 separate code-recovery record and abandon restriction. |
| L588: refuses a staging path that is not its own and leaves the record unchanged | K | S.records; G02/G22. Only UUID-owned staging may be removed. |
| L588: refuses an existing snapshot directory and leaves the record unchanged | K | W.snapshot-residue; G22. Recover reconciles complete destination; no silent deletion. |
| L588: refuses a dangling symlink at the snapshot path and leaves the record unchanged | K | W.prune; G22. Refuse symlink instead of deleting its target. |
| L588: refuses an existing staging directory and leaves the record unchanged | K | W.snapshot-residue; G22. Record exact owned staging path/size before retryable removal. |
| L588: refuses an existing backup reference and leaves the record unchanged | D | S11 dual-registry existence test; no separate backup reference remains. |
| L588: refuses a legacy record and leaves the record unchanged | K | S.cutover; G05. Old unfinished record cannot be mutated by v2. |
| L599: refuses while .lock.update is already held | K | W.locks; G19. New resume/recover/prune preserve held lock and release only their own lock; replace abandon call. |
| L599: refuses while .lock.links is already held | K | W.locks; G19. New resume/recover/prune preserve held lock and release only their own lock; replace abandon call. |
| L610: refuses an accepted forward | D | S15 abandon on accepted forward; completed is now directly prunable/restorable. |

## Enumeration check

### Implementation-base reconciliation

Implementation base: `d3a0801370a11c6e84d566f92a549154369dbac2`.
The original six files contain 161 expanded cases / 128 declarations after
N1: S adds one previous-manifest compatibility case; W adds three N1 cases
and loses the S8 diagnostic-copy budget case. The four retired-file
candidates differ only by their first-import isolation guards.
These are source enumeration counts, not executed test results.

`codexStateKeepSafety.test.ts` contributes 25 cases / seven declarations,
making the base migration population 186 cases / 135 declarations:
127 K and 59 D. Additions to the implementation are counted separately.
The approved execution/commit plan is recorded in
[the implementation plan](https://github.com/sakuraiyuta/kaoiro/issues/709#issuecomment-6387663385).

| Current case group | Disposition / destination |
|---|---|
| S previous schema-1 manifest reader | K, S.snapshot/G12; keep old snapshot readability independently of record cutover |
| S WAL and capacity rewrites | K, S.snapshot/capacity/G12/G14; retain real WAL/source-byte and old-reader checks, logical bytes/reserve/inodes; omit already-retired diagnostic accounting mutations |
| W pre-existing foreign UID, SQLite without diagnostics, post-stop repopulation | Three K, W.stopped/source-recovery/G10/G21; no foreign-writer discovery or migration diagnostics |
| W original L409 diagnostic-copy budget | Removed by N1/S8; no N2 replacement; sparse logical-size gate remains |
| KeepSafety late-unknown/copy-fault/backup-fault/phase-fault (4) | K, W.source-recovery/snapshot-residue/G10/G21/G22; retain state, credentials, links, service result and usable recovery; rewrite old phase/dual-registry assertions |
| KeepSafety stop-result faults (3), activity-read faults (2) | K, W.stopped/source-recovery/G10/G21; preserve exit status and absence of unsafe subsequent mutations |
| KeepSafety late-link/late-release/links-held (3) | K, W.source-recovery/G10/G17/G19 |
| KeepSafety late-config/late-home (2) | D/S9 identity refusals; replace with same-path config/inode success twins, W.path-agreement/G08 |
| KeepSafety lost-owner (1) | D/S11; replace with durable-phase dead-worker recovery |
| KeepSafety unsafe phases (4) | K, W.source-recovery/G02/G10; use corresponding forbidden/unknown v2 states; old names remain cutover inputs |
| KeepSafety failed source startup/post-check (4) | K, W.source-recovery/forward/G20/G21 |
| KeepSafety failed restore, initially active/inactive (2) | K, W.restore-resume/source-recovery/G09/G10/G21; admission-time release/state survive cancellation/retry |
| N1's removed rejected-preflight owner-record nonmutation property | D/S11; owner record retires; this is a carried property, not an extra base case |
| W original L554/L563 PID reuse/absence | D/S11/S15 owner authority; retained recovery invariant is the N2 section-8 dead-worker interruption group, W.source-recovery/restore-resume/G09/G10 |
| P3 releaseCleanup owner-file-removal failure | D/S11; preserve the other two cleanup cases, failure propagation and lock retention |

P3's eight removed release/enrollment test files are not resurrected.
Its retained `acceptedForwardTransaction` export and direct receipt test
retire with N2. `codexHomeClassification` and wrapper home tests stay.
N1's frozen snapshot fixture stays. No old test is removed before its K
replacement and corresponding guard mutation have passed.

| File | Test declarations | Expanded cases |
|---|---:|---:|
| `codexReceipt.test.ts` | 39 | 39 |
| `codexLineage.test.ts` | 7 | 7 |
| `codexLineagePending.test.ts` | 6 | 8 |
| `codexLegacy.test.ts` | 10 | 10 |
| `codexState.test.ts` | 26 | 35 |
| `codexStateWorkflow.test.ts` | 37 | 59 |
| Total | 125 | 158 |
