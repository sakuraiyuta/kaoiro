---
title: Phase 25 — Fresh-restore of an offline agent without session_id
description: Resolve the issue where an agent restarted entirely (dogfood.sh) immediately after /clear or before speaking appears as an offline restore candidate but restore is rejected as :no_session and becomes ⚠. Even without session_id, fresh-spawn it from cwd/engine/persona/snapshot and reapply the resume snapshot so it returns as an agent with the same model/effort/engine/permission settings.
status: done
phase: 25
depends_on: [22, 23]
last_updated: 2026-07-23
---

# Phase 25 — Fresh-restore of an offline agent without session_id

## Goal

When runner/wrapper/server/client are all restarted with dogfood.sh or similar,
allow an agent that was immediately after `/clear` or had not spoken yet
(without reporting a session_id) to be restored from the dashboard as a
**fresh session with the same model / effort / engine / permission settings as
before**.

## Symptoms and root cause (confirmed by investigation 2026-07-23)

Symptom: after a full restart, an agent that only started a new session through
`/clear` appears as an offline restore candidate, but clicking restore shows ⚠
(sticky spawn_error icon) and cannot restore it.

Cause chain:

1. `/clear` explicitly sets session_id to **nil** through
   `SessionPointers.detach_session`, as required by the ADR-0036 F3 addendum
   (retain cwd / engine / snapshot). An unspoken session also never reports a
   session_id because the SDK does not emit init (ADR-0014 Q-A4). Both pointers
   therefore have the shape `%{session_id: nil, cwd, engine, snapshot}`.
2. After a full restart, the agent is shown as an offline tile from
   AgentDirectory, and the restore button is unconditionally shown as required
   by ADR-0030 D8.
3. The server restore handler's `session_pointer/1`
   (`agents_channel.ex`) requires `is_binary(session_id)`, so it rejects with
   `{:error, :no_session}` → `spawn_result` error → ⚠. The only recovery path
   is deletion followed by a manual relaunch.

All information needed for restore is already persisted: persona
(AgentDirectory), cwd / engine (SessionPointers), and model / model_source /
effort / effort_source / permission_mode / sandbox / network_access (the
pointer's resolved snapshot—the wrapper optimistically stamps `ext.effective`
from the first state_change (phase-15 15-4b), so it is recorded even before a
conversation). The only missing piece is a path that restores a pointer without
session_id through fresh spawn + snapshot reapplication.

## Decision (design)

**fresh-restore**: When the target pointer has `session_id: nil` and has cwd,
put a new optional flag `apply_resume_snapshot: true` in a spawn payload without
`resume_session_id` and relay it to runner. Only for this flagged fresh spawn,
runner applies the same `applyResumeSnapshot` as the resume path (including the
5-case pair rule) to ParsedSpawn before launching.

- **Runner remains the SSOT for snapshot application** (retain the Phase 22
  section of the ADR-0014 F1 addendum: the server is only a relay and must not
  duplicate top-level representations). Do not expand the snapshot into
  top-level launch picks on the server; that would duplicate the 5-case pair
  rule in Elixir and cause `*_source` stamps to lie.
- **T3 / F4 are unnecessary**: no session file is read, so no existence check or
  same-session lock is involved. Go directly to `#launchSpawn`.
- **LaunchDialog fresh spawn is unchanged**: an unflagged fresh spawn still does
  not apply a snapshot (Fuji D1; do not silently overwrite an operator's launch
  choice).
- **Backward compatibility**: an old runner ignores the unknown field and
  degrades to a fresh spawn with engine defaults (restore succeeds, settings are
  defaults). An old server → new runner is completely unchanged because no flag
  arrives.
- A pointer with a nil snapshot (very old records, for example) omits
  `resume_snapshot` from the payload; runner application is a no-op and fresh
  restore uses engine defaults (fail-soft, preferable to being unable to
  restore).

## Scope / Tasks

| # | Task | File | Status |
|---|---|---|---|
| 25-1 | Add `SpawnMessage.apply_resume_snapshot?: boolean` to the protocol and update the `resume_snapshot` doc comment to say it accompanies resume_session_id or apply_resume_snapshot | `protocol/src/index.ts` | done |
| 25-2 | Relax session_pointer/1 to require cwd while allowing nil session_id (return `{:ok, session_id_or_nil, cwd, engine}`). Keep `:no_session` for a missing pointer / missing cwd | `server/lib/kaoiro_server_web/channels/agents_channel.ex` | done |
| 25-3 | In `build_restore_payload`, omit `resume_session_id` and put `"apply_resume_snapshot" => true` when session_id is nil (retain current behavior for a binary) | same | done |
| 25-4 | Adjust `resume_disconnected` (explicit operator session pick) to obtain only cwd/engine from the pointer, so explicit resume works with a nil pointer session_id | same | done (the `session_pointer/1` relaxation makes a separate change unnecessary) |
| 25-5 | Server tests: (a) restore of a nil-session pointer broadcasts spawn with no resume_session_id + apply_resume_snapshot + resume_snapshot, (b) preserve :no_session for missing pointer / missing cwd, (c) allow resume_disconnected with nil-session pointer + explicit sid | `server/test/kaoiro_server_web/channels/agents_channel_test.exs` | done (5 cases added, all 433 server tests green) |
| 25-6 | Runner: `parseSpawn` optional boolean `apply_resume_snapshot` into `ParsedSpawn.applyResumeSnapshot`; in the fresh branch of `handleSpawn`, apply `applyResumeSnapshot(parsed, parsed.resumeSnapshot, engine)` only when flagged, then `#launchSpawn` (no T3/F4) | `runner/src/supervisor.ts` | done |
| 25-7 | Runner tests: (a) flagged fresh spawn with snapshot launches model/effort/permission_mode/sandbox/network_access from snapshot, (b) unflagged fresh spawn does not apply it (regression), (c) flag without snapshot uses engine defaults | `runner/test/supervisor.test.ts` | done (4 cases added, all 236 runner tests green) |
| 25-8 | Docs: add the field to the spawn message in `docs/specs/protocol.md` and add fresh-restore supplements to ADR-0030 (D8) / ADR-0014 (F1 addendum) | docs | done |
| 25-9 | Manual dogfood verification (below) | — | done (master acceptance 2026-07-23, no issues) |

**Out of scope**:

- No client changes (the restore button is already unconditional; on success,
  existing logic removes ⚠).
- Fresh-restore fallback after a T3 failure where session_id exists but JSONL is
  gone (not in this reproduction; use another phase if needed).
- Restore failure while the host runner remains offline (existing behavior).

## Verification (25-9 dogfood)

1. Launch a Claude agent with explicit model/effort/permission → restart all
   services with dogfood.sh before it speaks → restore → confirm it is live
   with the same settings (dashboard model / effort / permission and
   `ext.effective`).
2. Run `/clear` on an agent with conversation history → restart everything
   before it speaks → restore → confirm it is live with the same effective
   settings as before `/clear` (the snapshot survives detach).
3. Perform step 1 with a Codex agent (sandbox / network_access match snapshot).
4. Regression: confirm ordinary restore with session_id, LaunchDialog fresh
   spawn, reset (/new, /clear), and switch_session remain unchanged (test suite
   + visual check).

## Risks

- If the `ext.effective` stamped by the wrapper on the first state_change is
  sparse for an engine or timing reason, fresh-restore demotes only those
  missing values to the engine default (safe side). 25-5/25-7 guarantee only
  that values present in the snapshot are restored.
- Even if `apply_resume_snapshot` is abused, the snapshot has already passed
  server write-side + runner read-side double sanitization and uses the same
  trust boundary as the existing resume path (ADR-0014 F1 addendum). It does
  not add a new privilege-escalation surface.
