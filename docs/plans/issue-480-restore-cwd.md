---
title: Preserve the launch cwd for session restore
status: approved
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

Native probes used the built `runClaudeCli` composition root, the real
`AgentHost`, and Claude Agent SDK 0.3.284. Only the server transport was replaced
with an observer; the child ran the real CLI. The tested CLI artifact was
`wrapper/claude-code/dist/cli.js`, SHA-256
`ebf0fbd474f2916b4d1a5c537525916129a06b9dca8912aba756474a0d43dbc5`.

- Bash `cd <real-git-worktree> && pwd` left `ext.cwd` at the launch cwd in the
  first turn. The transcript existed only under the launch project directory.
  A second wrapper launched from that cwd resumed the same session and recalled
  the prior marker, exit 0.
- Bash cd, then `/compact`, then another `pwd` in the same real host changed
  emitted `ext.cwd` to the worktree. The session ID remained
  `f886d5b3-61bf-473e-b159-0bfb02543cc4`; its transcript remained only under the
  launch project directory. A second wrapper from the original cwd resumed it
  and recalled the marker, exit 0. This observes a native trigger after cd;
  it does not distinguish the `CwdChanged` and session-init writers internally.
- A transport-only `/clear` after cd generated a new session ID
  (`04eeb206-1e29-40fa-a878-e1de67ea392f` to
  `c3cd20d5-3285-47bc-acbf-44d7ad182f5d`) in the same host. Both transcripts
  existed only under the launch project directory. The storage checker exited
  0; asserting existence under the moved project instead exited 1. Resuming
  the new ID from the launch cwd succeeded, exit 0. This deliberately bypasses
  the server's reserved-command gate and caused the host's existing admission
  fail-stop after the native clear; it establishes storage placement only.
- The real operator channel rejected an ordinary `/clear` instruction with
  `reserved_session_command`, exit 0. The supported reset uses `reset_session`,
  terminates the wrapper, and relaunches it without `--resume` at
  `entry.parsed.cwd`. A real-supervisor probe with an observed child boundary
  and default session queries against the native transcript confirmed the
  original cwd and absent resume ID on the fresh launch, exit 0. Live session
  switching likewise cycles the wrapper at its bound cwd. The CLI composition
  sets neither `forkSession` nor `resumeSessionAt`.

Native runs emitted the SDK warning that `bypassPermissions` shadows
`canUseTool`. Channel probes emitted the existing test-environment auth/admin
and temporary-cache-permission warnings. The deliberate raw-clear fail-stop is
excluded from claims of a supported reset succeeding. Channel reproduction
supplies the moved-cwd envelope itself; native probes establish external CLI
storage/resume behavior. The server fix does not depend on a particular native
trigger, and these separate probes are not one end-to-end restore test.

Probe artifacts are in `tmp/fuji-480-probes/` in the implementer's worktree;
they are disposable, excluded from commits, and are not product changes.

## Proposed contract and implementation

Restore, disconnected `resume_session`, and implicit session enumeration use
the agent-bound launch cwd. `AgentStates` continues storing and projecting
the latest reported `ext.cwd` (when the engine reports a change). The two
meanings must not share an overwrite policy. This follows
ADR-0014 F3's fixed host/cwd binding and the existing runner T1/T3 boundary.

Add `SessionPointers.record_session/5` for envelope ingestion. Its GenServer
handler atomically preserves an already-recorded cwd while accepting the
latest session ID and engine. If the pointer has no cwd, the first reported
cwd fills it, preserving direct-wrapper compatibility. Select the cwd, merge
fields, update memory, and persist within one handler invocation using shared
private merge/persistence code. Do not call or cast back to the same GenServer:
a self-call deadlocks, and requeueing separates the decision from the write.

Keep `SessionPointers.record/5` as the explicit seed/maintenance path, including
its existing non-nil overwrite semantics. The operator spawn handler already
uses it to seed the requested allowlisted cwd. Whether the seed or first
envelope is processed first, the seed wins and later session reports retain it.
Change wrapper-channel ingestion to call `record_session/5`. No new wire fields,
runner fallback, or wrapper runtime changes are needed.

Dashboard changes are out of scope. Its existing `cwd` label shows the last
reported execution directory, which can differ from the restore directory.
Document this distinction in the runner-control reference and recovery note.
Agent detail enumeration uses the pointer; LaunchDialog's explicit cwd is a
new-spawn input and is explicitly seeded through `record/5`.

Runner allowlist membership remains exact equality. A removed launch directory
or a launch cwd no longer in the host's allowlist still fails under existing
runner checks. A worktree's existence does not authorize launching there.

## Existing pointers and migration

The DETS schema stays unchanged; existing 3/4/5/6-tuples remain readable. A
correct legacy cwd remains usable and gains overwrite protection immediately.
An already-contaminated pointer contains no trustworthy original launch cwd,
regardless of whether its wrapper is live or offline. The new ingestion policy
also freezes a dirty live row rather than allowing a later envelope to repair
it accidentally.

The director's accepted decision is to retain these rows and document explicit
operator repair. Do not infer a cwd from its parent or the first allowlist entry,
scan allowed projects for automatic repair, or change T3. The following runbook
steps are documentation deliverables; this branch performs no production audit,
repair, deployment, or live-state mutation.

### Read-only pre/post-deployment audit

Run before deployment and again after the corrected server is running and
runners have registered. Query every pointer, including live rows, and compare
its cwd with its owning host's current exact allowlist. A missing host is an
unverifiable candidate; wait for that runner to register or compare with its
operator-confirmed current configuration rather than treating it as healthy.
Direct-wrapper rows may also appear and require operator judgment. A mismatch
is a repair candidate, not proof of its correct replacement cwd.

The runbook will use the current production release RPC, for example:

```sh
docker compose -f /path/to/deployment/docker-compose.yaml exec -T kaoiro \
  /app/bin/kaoiro_server rpc '
states = KaoiroServer.AgentStates.snapshot()
KaoiroServer.SessionPointers.all()
|> Enum.flat_map(fn {agent_id, pointer} ->
  host_id = KaoiroServerWeb.AgentId.host_id_from(agent_id)
  host = KaoiroServer.HostRegistry.get(host_id)
  reason = cond do
    is_nil(host) -> :host_not_registered
    pointer.cwd in host.cwd_allowlist -> nil
    true -> :cwd_not_allowed
  end
  if is_nil(reason), do: [], else: [%{
    agent_id: agent_id, host_id: host_id, cwd: pointer.cwd,
    session_id: pointer.session_id,
    state: get_in(states, [agent_id, "state"]), reason: reason
  }]
end)
|> Enum.sort_by(& &1.agent_id)
|> IO.inspect(limit: :infinity)'
```

This reads the running stores rather than opening their DETS files. Use the
canonical last-dot host parser, including host IDs containing dots. A probe
against the real application stores flagged live/offline mismatches and a
missing host, excluded an exactly allowlisted row, and left pointers unchanged
(exit 0). Mutating only the valid-row exclusion made that probe red (exit 2);
restoring it returned exit 0. Read snapshots are not an atomic inventory: rerun
if host registration, reset, deletion, or manual maintenance overlaps the audit.
Rows whose contaminated cwd is itself allowlisted are not detectable by this
comparison; known affected rows still need explicit inspection.

### Explicit repair after operator confirmation

Confirm the intended launch cwd from the original launch/configuration evidence,
its exact current host allowlist membership, and existence of the exact session
at that cwd using the runner's actual engine-specific `sessionExists` query on
that host. A nil session ID has no transcript check and uses the existing fresh
restore path. Do not repair an overlapping reset/switch/delete operation.

After those confirmations, use the corrected running release's existing
maintenance API; the runbook will include this concrete RPC shape:

```sh
docker compose -f /path/to/deployment/docker-compose.yaml exec -T kaoiro \
  /app/bin/kaoiro_server rpc '
agent_id = "<confirmed-agent-id>"
cwd = "<confirmed-launch-cwd>"
host = KaoiroServer.HostRegistry.get(KaoiroServerWeb.AgentId.host_id_from(agent_id))
true = is_map(host) and cwd in host.cwd_allowlist
before = KaoiroServer.SessionPointers.get(agent_id)
true = is_map(before)
KaoiroServer.SessionPointers.record(agent_id, nil, cwd)
after_repair = KaoiroServer.SessionPointers.get(agent_id)
true = after_repair == %{before | cwd: cwd}
IO.inspect(after_repair, limit: :infinity)'
```

The synchronous readback orders after the cast and verifies session ID, engine,
snapshot, and effort revision were retained. If it fails because a concurrent
update occurred, inspect the latest row and re-audit; do not overwrite those
fields or retry blindly. Before deployment, an active old writer could overwrite
a repaired cwd again, so repair after the corrected ingestion policy is live.
The exact RPC expression bodies extracted from this plan were exercised against
the real application stores, including snapshot and effort revision preservation
(exit 0). A non-allowlisted repair was rejected without changing the row;
removing just the repair allowlist precondition made that test red (exit 2).
These checks establish expression behavior, not a production Docker invocation.

Offline direct-wrapper rows without a registered host require registration or a
separately confirmed maintenance procedure; this command deliberately refuses
a host whose allowlist cannot be verified.

Deletion followed by a delayed session envelope can recreate a pointer through
bootstrap with the reported cwd. This pre-existing race is recorded as out of
scope; this change adds no deletion fencing.

Independent design review approved the plan. Implementation follows this
contract; recovery commands are maintained in the
[operations runbook](../operations/session-pointer-recovery.md).

## Verification and negative controls

- Real default-composition channel regression: operator spawn, session-bearing
  launch envelope, moved-cwd envelope, disconnect, restore. Assert the displayed
  cwd changes, the pointer/restore cwd stays at launch, and the session ID remains.
  Exercise both ordinary resume and fresh restore after explicit detach.
- Pointer tests: first cwd bootstrap, preservation across session-ID changes,
  nil-cwd reports, explicit seed/maintenance overwrite, snapshot preservation,
  both deterministic seed/envelope arrival orders (a synchronous `get` barrier
  after each cast), and DETS close/reopen persistence including old tuple formats.
- Runner regression: actual channel-produced restore payload reaches the real
  supervisor, retains exact allowlist/T3 checks, and launches with the original
  cwd and session ID. Use default session queries against an owned session file;
  keep native storage/resume evidence separate from that filesystem fixture.
- Mutations: remove the cwd-preservation branch and independently bypass the
  wrapper-channel call to it; the corresponding regression must fail. Route
  the explicit spawn seed through the preserving path (or make `record/5`
  preserve too): the envelope-first/seed-later test must fail. Remove the
  missing-cwd bootstrap fallback: the direct-wrapper bootstrap test must fail.
  Restore source before gates, and bind final results to the tested commit.
- Negative controls: non-allowlisted cwd launches zero children; a nonexistent
  session under an allowlisted cwd launches zero children; explicit maintenance
  repair succeeds without changing the stored snapshot or session ID.
- Gates: server `mix precommit` with full output retained on failure, runner
  `pnpm typecheck` / `pnpm test`, wrapper `pnpm typecheck` / `pnpm build` and
  affected Claude tests. Run the native cwd/resume probe again against the final
  built wrapper artifact after source changes, including cd/compact and
  same-host native clear storage placement; report their distinct roles,
  expected raw-clear fail-stop, warnings, and exit codes.

Update ADR-0014's cwd persistence contract, runner-control reference semantics,
and an operations recovery note for pre-existing contaminated pointers. Scope
excludes dynamic Codex cwd tracking, broader launch authorization, automatic
legacy project scanning, and production deployment/data mutation.

## Design-review round 1 disposition

Review baseline: plan SHA-256
`3a73e910206d25f83b81fa0b5b2a724a88f31501bcc1fd64e5b9c3d1d329fa98`,
commit `a5746c20278dc0a3e87943e280c42e3b91d2857d`.
Review artifact: `tmp/reviews/issue-480/design-r1-kuroe.md`, SHA-256
`6e2fb9f7148029e7d56cfb6a34a027ea373168cadc99ad1717f11b8cd92684a6`.

| ID | Disposition and reason |
| --- | --- |
| M1 | Adopted: same-host native clear after cd creates a new ID stored under the launch project; root-cwd resume succeeds. Corrected the supported reset premise: the operator channel refuses plain clear and runner reset replaces the process at the bound cwd. Native compaction was also measured: moved ext.cwd, unchanged session ID and launch-project storage. |
| M2 | Adopted: read-only audit before and after deployment covers live/offline rows, exact membership and missing hosts; candidates follow explicit repair. No automatic repair. |
| S1 | Adopted: separate channel injection from external CLI storage/resume evidence; fix is trigger-independent. Additional compact probe now observes moved ext.cwd, without attributing it to an unobserved hook. |
| S2 | Adopted via documentation: explicitly distinguish latest reported cwd from restore cwd; dashboard remains out of scope. |
| S3 | Adopted: one handler with shared private merge/persistence, no self-call/requeue; deterministic tests cover both arrival orders. |
| S4 | Adopted: add seed-route and bootstrap mutations; audit has valid-row negative control and its exclusion mutation was measured red. |
| N1 | Recorded: delayed post-delete envelope recreation remains an existing out-of-scope race. |
| N2 | Adopted: production release RPC maintenance call with nil session ID and synchronous full-row readback, plus verified-host and concurrent-update handling. |

## Design-review round 2 disposition

Review artifact: `tmp/reviews/issue-480/design-r2-kuroe.md`, SHA-256
`f10bccad18d6edfba602f66c841f4f9883e28c332ad9d7a2b9bb0aefc8e49f29`.
Verdict: approved, must 0 / should 1 / nit 2.

| ID | Disposition |
| --- | --- |
| S1 | Adopted: the recovery runbook identifies explicit-cwd runner enumeration and the actual built, engine-specific `sessionExists` query on the owning host. It distinguishes candidate listing from the T3 existence check. |
| N1 | Adopted: the runbook audit reports `no_cwd` separately from exact allowlist mismatches. |
| N2 | Adopted as a follow-up: the director will track dashboard display of reported cwd and restore cwd; this branch documents the distinction. |

The raw native `/clear` fail-stop is not a separate production defect: the
server rejects that instruction, and supported reset cycles the wrapper.
