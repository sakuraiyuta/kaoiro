---
title: Preserve the launch cwd for session restore
status: proposed
last_updated: 2026-10-02
related: [ADR-0014, issue-480]
---

# Preserve the launch cwd for session restore

## Problem and measured evidence

Baseline: `e1073d7db4505f693c00f69880c33941e75bde1f`.

A disposable Phoenix Channel test exercised the real operator `spawn`, wrapper
`envelope`, and operator `restore` handlers with the application-managed stores.
Spawn seeded `/home/yuta/git/kaoiro`; a session-bearing envelope reporting
`ext.cwd=/home/yuta/git/kaoiro/worktrees/fuji-480` replaced it; restore broadcast
that worktree cwd with the same session ID. Exit 0, one passing observation test.
Feeding that exact broadcast payload into the real runner `Supervisor.handleSpawn`
returned `cwd_not_found`, with zero launcher calls, although the worktree exists.
Changing only the probe's allowlist to the worktree bypassed that rejection and
returned `session_not_found`; the observation checker then exited 1 as expected.

A native probe used the built `runClaudeCli` composition root, the real
`AgentHost`, and Claude Agent SDK 0.3.284. Only its server transport was replaced
with an observer; its child ran the real CLI. A Bash command ran `cd` and `pwd`
inside a real Git worktree. The session transcript existed under the launch
project directory and did not exist under the worktree project directory.
Starting the same composition root from the original cwd with that session ID
recalled a marker from the prior turn, with exit 0. This establishes successful
resume from the launch cwd for this session. The probe did **not** observe an
`ext.cwd` change: it does not establish when the native `CwdChanged` hook fires.
The channel reproduction intentionally supplies the moved-cwd envelope itself.

Probe artifacts are in `tmp/fuji-480-probes/` in the implementer's worktree;
they are disposable, excluded from commits, and are not product changes.

## Proposed contract and implementation

Restore, disconnected `resume_session`, and implicit session enumeration use
the agent-bound launch cwd. `AgentStates` continues displaying the latest
`ext.cwd`. The two meanings must not share an overwrite policy. This follows
ADR-0014 F3's fixed host/cwd binding and the existing runner T1/T3 boundary.

Add `SessionPointers.record_session/5` for envelope ingestion. Its GenServer
handler atomically preserves an already-recorded cwd while accepting the
latest session ID and engine. If the pointer has no cwd, the first reported
cwd fills it, preserving direct-wrapper compatibility. Delegate the remaining
merge and persistence work to the existing record path.

Keep `SessionPointers.record/5` as the explicit seed/maintenance path, including
its existing non-nil overwrite semantics. The operator spawn handler already
uses it to seed the requested allowlisted cwd. Whether the seed or first
envelope is processed first, the seed wins and later session reports retain it.
Change wrapper-channel ingestion to call `record_session/5`. No new wire fields,
runner fallback, or wrapper runtime changes are needed.

Runner allowlist membership remains exact equality. A removed launch directory
or a launch cwd no longer in the host's allowlist still fails under existing
runner checks. A worktree's existence does not authorize launching there.

## Existing pointers and the decision required

The DETS schema stays unchanged; existing 3/4/5/6-tuples remain readable. A
correct legacy cwd remains usable and gains overwrite protection immediately.

An already-contaminated offline pointer contains no trustworthy original launch
cwd. Do not infer it from a parent directory or the first allowlist entry, and
do not widen T3 by scanning all allowed projects silently. Proposed handling:
retain the row and document an explicit operator repair. Confirm the original
launch cwd, exact current allowlist membership, and existence of the exact
session under that cwd using the runner's actual session query; then use the
existing explicit `SessionPointers.record/5` maintenance path and read back the
row before restoring. Preserve session ID, engine, snapshot, and effort revision.
No live pointer repair is included in this branch.

The director/operator must decide whether this conservative legacy handling is
acceptable or whether automatic recovery of contaminated rows is required.
Automatic recovery needs a separately reviewed policy for ambiguity, missing
sessions, changed allowlists, and fresh restores with no session ID. Hold source
implementation until the design review and this scope decision are resolved.

## Verification and negative controls

- Real default-composition channel regression: operator spawn, session-bearing
  launch envelope, moved-cwd envelope, disconnect, restore. Assert the displayed
  cwd changes, the pointer/restore cwd stays at launch, and the session ID remains.
  Exercise both ordinary resume and fresh restore after explicit detach.
- Pointer tests: first cwd bootstrap, preservation across session-ID changes,
  nil-cwd reports, explicit seed/maintenance overwrite, snapshot preservation,
  and DETS close/reopen persistence including old tuple formats.
- Runner regression: actual channel-produced restore payload reaches the real
  supervisor, retains exact allowlist/T3 checks, and launches with the original
  cwd and session ID. Use default session queries against an owned session file;
  keep native storage/resume evidence separate from that filesystem fixture.
- Mutations: remove the cwd-preservation branch and independently bypass the
  wrapper-channel call to it; the corresponding regression must fail. Restore
  source before gates, and bind final results to the tested commit.
- Negative controls: non-allowlisted cwd launches zero children; a nonexistent
  session under an allowlisted cwd launches zero children; explicit maintenance
  repair succeeds without changing the stored snapshot or session ID.
- Gates: server `mix precommit` with full output retained on failure, runner
  `pnpm typecheck` / `pnpm test`, wrapper `pnpm typecheck` / `pnpm build` and
  affected Claude tests. Run the native cwd/resume probe again against the final
  built wrapper artifact after source changes; report warnings and exit codes.

Update ADR-0014's cwd persistence contract, runner-control reference semantics,
and an operations recovery note for pre-existing contaminated pointers. Scope
excludes dynamic Codex cwd tracking, broader launch authorization, automatic
legacy project scanning, and production deployment/data mutation.
