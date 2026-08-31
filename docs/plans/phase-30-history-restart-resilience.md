---
title: Phase 30 — Restart resilience for display history (ADR-0051)
description: Implement replay on reconnect through the hydration handshake, remove DETS through the IA sidecar and per-pane projection contract, and resynchronize clients through the projection epoch.
status: done
phase: 30
depends_on: []
last_updated: 2026-08-08
---

# Phase 30 — Restart resilience for display history (ADR-0051)

## Goal

Implement [ADR-0051](../adr/0051-history-restart-resilience.md) so that every
operator terminal sees the same timeline even across a server restart. Remove
the server's `InterAgentHistory` DETS and reduce its durable state.

## Tasks

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| 30-1 | ADR-0051 specification review | ふじ | ✅ | 2 rounds (10 must-fixes total, all incorporated) → approve. Accepted with マスター approval (2026-08-08) |
| 30-2 | Finalize ADR + revise specs | クロエ | ✅ | Wire finalized: the hydration verdict is `hydration: {replay_required, replay_id?}` in the wrapper join reply (no dedicated S→W event); `replay_ia {replay_id, items:[{envelope, ingress_stamp}]}` is topic-bound; the send acknowledgment is `{ingress_stamp}` in the envelope push reply. protocol.md (the 5 ADR D8 points: join hydration verdict / `replay_ia` / ingress stamp (delivery + acceptance ack) / projection epoch / explicit `preserve_inter_agent` false), protocol-inter-agent.md (sidecar schema / pending journal namespace / generation / live-projection causal order), architecture.md |
| 30-3 | Existing-document amendment sweep | もも | ✅ | Completed 2026-08-08. ADR D8 targets: ADR-0014 A4 / ADR-0036 F3 / ADR-0030 D6 store count / protocol.md `preserve_inter_agent` and purge-store count / deployment.md DETS 8 kinds → 7 kinds. Added dated notes for the old DETS assumptions in phase-17 / 19 |
| 30-4 | server: per-pane projection contract | あお | ✅ | Completed 2026-08-08 (1493eb4). Volatile per-pane upsert API shared by live/replay. Live accept causal order is validate → assign stamp → upsert both panes → route; server-synthesized IA goes only to the recipient pane; identity = `ingress_stamp\|pane_agent_id`; clear filtering + final 200 cap use the same path (ADR D3-1/D6) |
| 30-5 | wrapper: record IA sidecar | あお | ✅ | Completed 2026-08-08 (186f542). Shared in agent-common for both engines. Receive = append before injection (with delivery stamp) / send = append when the transport acceptance ack (`{ingress_stamp}` reply) arrives; pending journal ({agent_id, reset_generation} namespace) → session bind; switch generation on /new and /clear (ADR D3-2/D3-5) |
| 30-6 | wrapper: hydration handshake + send IA replay | あお | ✅ | Completed 2026-08-08 (186f542). Wait for the join verdict (whether required + server replay_id) before starting replay; legacy fallback (verdict absent → existing startup replay); single-flight; empty-complete for a fresh session; sidecar → `replay_ia` send (ADR D2/D3-3) |
| 30-7 | server: hydration state management + replay ingress + DETS removal | あお | ✅ | Completed 2026-08-08 (1493eb4). Hydration invalidation conditions follow the ADR D2 addition (あお Q1). Added hydration state to AgentStates (in_flight uses replay_id + channel_owner CAS), join-reply verdict, pane-ownership validation + projection upsert for `replay_ia`, stamp vs. ClearWatermarks comparison, removal of InterAgentHistory and purge paths, and explicit `preserve_inter_agent: false` send (ADR D2/D3-3/D3-4) |
| 30-8 | dashboard: projection epoch resynchronization | あお | ✅ | Completed 2026-08-08 (150b3a2). Separate the new-connection buffer; on epoch mismatch discard the baseline (logs / clearWatermarks / replay marker / unread state) and merge only history and the new-connection buffer; epoch-absent fallback (ADR D4) |
| 30-9 | Documentation consistency sweep | もも | ✅ | Completed 2026-08-08. Synchronized README / plan index with implementation and review complete / awaiting dogfood. Documented replay 1MB chunks, oversize drop, and the live-buffer window for connection generations in specs. `KAOIRO_INTER_AGENT_HISTORY_PATH` is already unread, but an unused export remains in compose / dev.sh and is tracked in a deployment note |
| 30-10 | Implementation review | ふじ | ✅ | Completed in 3 rounds 2026-08-08 (round 1: 5 must-fixes → round 2: 3 remaining (R1–R3) → final confirmation approve, no remaining findings). Independent green verification; 3 spec additions also confirmed to match implementation. See “30-10 review points” and “30-10 must-fix responses” below for history and actions |
| 30-11 | Dogfood verification + atomic rollout | デフォルトくん + マスター | ✅ | Completed 2026-08-08. マスター manually performed the 3-layer update + reload of all tabs and visually confirmed transcript / IA restoration and matching displays after a server restart. Live IA sidecar connectivity was verified with stamped records on both send and receive (クロエ). The fact that pre-update IA is not restored is by migration cutover design. The 2 unused export lines (compose / dev.sh) are removed at close |

Status legend: ✅ done, 🟡 in progress, ⚠ partial, ⏳ not started,
⛔ blocked.

## Acceptance Criteria

Basic requirements:

- [x] After a server restart, the live wrapper's agent timeline restores the
      current session without operator action (both claude-code / codex)
- [x] **Without restarting the server**, send and receive live IA → F5 restores
      matching sender / receiver panes (live path after DETS removal, ADR D3-1)
- [x] IA bubbles restore through the sidecar + `replay_ia`, and replay never
      redistributes IA (no re-push to the peer or SDK reinjection)
- [x] The server implementation of `InterAgentHistory` DETS is removed and the
      deployment document has 7 runtime settings. The unused
      `KAOIRO_INTER_AGENT_HISTORY_PATH` export remains in compose / dev.sh and
      is tracked in the 30-9 deployment note
- [x] Tabs that were open before the restart do not continue showing pre-restart
      logs. Multiple terminals show the same display
- [x] Full F5 restoration and cross-terminal consistency while the server is
      running continue to work as before (no regression)
- [x] All tests are green (server `mix test` / wrapper `pnpm test` /
      dashboard `pnpm test`)

Failure matrix (from ふじ's review; (a)–(e), (h), (i), and (k) require
**deterministic automated tests**; (f), (g), and overall UX also use dogfood):

- [x] (a) Wrapper disconnects during partial replay (after reset) → reconnect
      requests it again and reaches a complete timeline [test]
- [x] (b) Join-verdict handshake: a `required: true` replay_id remains
      consistent across reset / `replay_ia` / complete, and hydration transitions
      use CAS. Startup replay does not run twice [test]
- [x] (c) Wrapper reconnect while the server is alive returns
      `required: false` and does not run unnecessary replay [test]
- [x] (d) A fresh session (session_id nil / no transcript) becomes hydrated via
      empty-complete [test]
- [x] (e) Cleared IA does not return after each of `/new` / `/clear` / rollback /
      old-session resume / `clear_history` (ingress-stamp comparison) [test]
- [x] (f) Even if one of sender / receiver is offline, the other pane restores
      independently [test + dogfood] — completed (30-11)
- [x] (g) Server-synthesized IA (direct error notification) restores through
      the receiving sidecar, and multiple notifications in one conversation are
      identified and coexist (`ingress_stamp|pane` identity) [test + dogfood] —
      completed (30-11)
- [x] (h) When transcript + IA exceeds 200 items, the final projection is capped
      at the newest 200 (201-item and 400-item boundaries) [test]
- [x] (i) With an epoch mismatch and a live envelope arriving before history,
      live rows are preserved and only ghosts disappear [test]
- [x] (j) Atomic maintenance rollout conditions (IA stop, simultaneous 3-layer
      update, reload all tabs) are performed as documented, and explicit
      `preserve_inter_agent: false` sending to old clients is confirmed [dogfood]
- [x] (k) Truncated or corrupt sidecar rows are skipped and replay continues
      [test]

## 30-10 review points (handoff from あお, 2026-08-08)

These are the points the implementer identified as involving judgment and worth
checking. Details are in the relevant commit messages and code annotations.

1. **`replay_ia` acceptance-line `agents:lobby` broadcast** (addition 1,
   150b3a2). This addresses an omission not described in the ADR/spec and is the
   highest-priority design judgment. `history_reset` sends
   `preserve_inter_agent: false`, so connected tabs drop IA, while `replay_ia`
   only upserts the projection and had no live notification; IA bubbles did not
   return until F5. Known rough edge: when a peer is offline and does not replay,
   a live tab also shows that IA in the peer's pane (the client fans out using
   `agent_id ∪ payload.to`) but reload removes it. Strict handling requires a wire
   field identifying the pane.
2. **Coverage of Q1's invalidate-trigger set** (1493eb4). Only the resume branch
   of `restore` and `resume_session` are covered. Runner-originated relaunch
   (crash-restart / `reset_session`) is intentionally out of scope.
3. **Implementation split for causal order** (1493eb4).
   `WrapperChannel.preflight_inter_agent/2` handles all rejection decisions;
   from `accept_inter_agent/6` onward the path only does upsert → peer push →
   broadcast → ack. Is that split faithful to the spec?
4. **`replay_ia` pane-injection surface**. Since the receiving pane contains an
   envelope in the peer's name, it cannot enforce `agent_id == topic`; the
   wrapper can inject an arbitrary `agent_id` envelope into its own pane. The
   impact is display in that pane only (as evaluated in the ADR threat model),
   but it should be explicitly confirmed.
5. **`AgentStates` state-shape change** (1493eb4). It is now
   `%{agents, hydration,
   epoch}`. Existing tests using `:sys.replace_state` were
   updated, but are there other dependencies on the raw state shape?
6. **When the sending sidecar records** (186f542). It records only when the ack
   arrives, so reject / timeout / lost ack are not recorded (accepted by D7 (e)).
   An ack without a stamp (old server) is also not recorded and emits an stderr
   warning.
7. **Dashboard `liveSinceJoin` window** (150b3a2). It covers only join → the
   `history` push and is emptied after push handling. Does that window match the
   intent of D4 step 1?

Additional note: even when the hydration tracker reaches its cap (1000), the
verdict returns `replay_required: true` (4f26cda). `:not_required` would falsely
claim that projection is safe and leave the timeline permanently empty. A
transcript replay works even without records; `replay_ia` is rejected as stale,
and the complete CAS also fails, so the next join requests it again.

## 30-10 must-fix responses (あお, 2026-08-08)

Five must-fixes + two should-fixes from round 1 were addressed. Key points for
the delta review:

| Item | Commit | Fix |
|---|---|---|
| M1 | c8ceec8 | Define `liveSinceJoin` as the connection-generation window from join to that connection's history push. Advance the generation and discard the buffer in `onJoined` (lobby join reply); accumulate only while `awaitingHistory`. Mirror `history_reset` / `history_cleared` / `agent_deleted` into the buffer. Put generation on the replay marker; on epoch discard, drop only the old generation |
| M2 | 2428304 / c8ceec8 | Broadcast restored rows as `history_replay_envelope {pane_agent_id, envelope}` (operator-only). The pane comes from the channel assign. The client injects only into the specified pane and does not fan out |
| M3 | c2f8a2a | Sort sidecar `read()` by `ingress_stamp` ascending, dedupe identical stamps, then take the newest 200 |
| M4 | c2f8a2a | Chunk `sendReplayIa` at 1MB of actual JSON byte length. Send multiple pushes for one `replay_id` before complete |
| M5 | c2f8a2a | `ServerLink#sendInterAgent` returns acceptance as a Promise and `send_to_agent` awaits it. Reject = error result; timeout / lost ack = delivery unknown; both release the reply waiter |
| S1 | 2428304 | Assert that both sender and receiver panes remain unchanged for 5 reject types |
| S2 | 2428304 | Pin (a) through replacement of partial residue with the complete next attempt |

Test reconstruction (response to the M1/M3 tests that had been handed their
assumptions as fixtures):

- `dashboard/test/projectionEpochWindow.integration.test.ts` — mount App.svelte,
  replace only `connectKaoiro`, and drive the **real handler sequence**. Includes
  6 cases for “old live → disconnect → new live → epoch-mismatch history” plus 2
  pane-scoped M2 cases. Confirmed by reverting each fix once and observing the
  corresponding test fail.
- `dashboard/test/replayEnvelopeWire.integration.test.ts` — pin the wiring from
  join reply → `onJoined` and `history_replay_envelope` → dedicated handler using
  the real Phoenix client.
- `wrapper/agent-common/test/ia_sidecar.test.ts` — reverse-order fixture that
  catches up stamp 1 after appending stamps 2..201.
- `wrapper/core/test/transport.test.ts` — assert as a premise that 200 × 60KB
  rows exceed 8MB before splitting, then confirm every chunk is below 8MB and all
  rows are retained.

S3 (known constraint, no action needed): the sidecar synchronously reads the full
set on every replay. Read cost grows linearly for long sessions. Filed as a
future task in [#192](https://github.com/sakuraiyuta/kaoiro/issues/192)
(2026-08-08, priority/low).

### Round-2 must-fix responses (あお, 2026-08-08)

ふじ confirmed M2/M3/M4/S1/S2 in round 2. The remaining 3 items + 1 should-fix
were addressed.

| Item | Fix |
|---|---|
| R1 | Extract the conversion that retains only the one session_boundary row carrying this reset's `request_id` for `onSessionResetCompleted(mode="clear")` into a helper, and apply it to both `logs` and `mirrorIntoLiveBuffer`. The mirror path now has 4 routes including clear |
| R2 | Move `#pendingInjections.delete` until acceptance is confirmed; do not delete on rejected. Delete on accepted / unknown (if delivery happened, sending a second #127 notice would give the peer contradictory messages) |
| R3 | Even for unknown acceptance, `await` a waiter that has already settled and extract its reply; if a reply exists, return the normal `sent + reply`. Arrival of the reply is evidence of delivery. An unknown with an active waiter follows the existing immediate-release + delivery-unknown path |
| should | `chunkReplayIaItems` **drops** a row that cannot fit within the budget by itself (sending it would only reject the frame, miss complete, and loop back to rejoin, matching D3-2's corrupt-row policy). Added because one guard line + a warning in `sendReplayIa` + 2 tests fit |

All tests were confirmed effective by mutation (R1: remove the mirror call / R2:
restore unconditional delete / R3: remove the settledReply branch → only the
corresponding test fails in each case).

## Dogfood verification scenario (30-11)

0. Deploy: ADR D6 maintenance procedure (stop all agents → update server /
   wrapper / dashboard together → reload all tabs).
1. While running: show the same agent on 2 terminals → F5 on both → same display.
2. Live IA: exchange several messages between agents → F5 **without restarting**
   → matching panes.
3. Restart: restart the server container while leaving one tab open → after the
   wrapper reconnects, the open tab and a new tab show the same current-session
   portion (no ghosts).
4. IA restoration: restart after an IA exchange → IA bubbles restore in both
   panes, with no duplicate messages delivered to the peer.
5. Clear: `/clear` a session containing IA → restart → cleared IA does not return.
6. Offline: an agent whose wrapper is stopped shows an offline tile + empty
   timeline after restart → resume restores history (regression check of the
   existing path).

## See Also

- ADR: [0051](../adr/0051-history-restart-resilience.md)
- Prerequisite ADRs: [0014](../adr/0014-session-resume-and-restore.md),
  [0030](../adr/0030-agent-directory-and-explicit-restore.md),
  [0036](../adr/0036-session-lifecycle-commands.md)
- Specs: [protocol](../specs/protocol.md),
  [protocol-inter-agent](../specs/protocol-inter-agent.md),
  [deployment](../specs/deployment.md)
