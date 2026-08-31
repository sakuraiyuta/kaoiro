---
title: Compaction resume and lifecycle log
description: Implement the wrapper-local resume_prompt for request_compact and retention of the session_lifecycle timeline with an operator query.
status: done
phase: 33
depends_on: []
last_updated: 2026-08-31
---

# Phase 33 — Compaction resume and lifecycle log

Implement [ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md).
Issue #200 is the parent. Use feature-local stages A/B/C (to avoid collision
with the project-wide phase numbering).

## Stage A — wrapper-local resume (the original request for issue #200)

- [x] Add an optional `resume_prompt` parameter to `request_compact` (Claude
      wrapper only; echo it in the approval dialog like reason)
- [x] When observing `compact_boundary`, serialize and inject the fixed prefix
      template + the verbatim resume_prompt into the instruction queue as a user
      turn
- [x] Regression test that omission behaves exactly as it does now
- [x] Implement and test the injection-path MUST (fixed template; model-derived
      verbatim content is limited to the resume_prompt body)

Acceptance: live verification that an approved compact with resume_prompt
automatically resumes the agent's work after compaction completes. Zero server
changes. Implementation and automated tests are complete (2026-08-31). Live
verification (resumption on an actual compact_boundary) has not been performed.

## Stage B — session_lifecycle recording

- [x] Add a wrapper→server `session_lifecycle` event (kind / trigger / occurrence
      time)
- [x] Wrapper producer: compact start/complete/failed (trigger: request_compact,
      resolved from the wrapper's own FIFO reservation queue; falls back to the
      SDK's own account — `sdk_auto` / `manual`, director裁定 2026-08-31 —
      when the queue has no entry for this boundary), threshold-notice firing,
      resume_reserved / resume_fired, conversation_reset
- [x] Merge server-side disconnect / reconnecting / reconnected / session_reset
      started / completed into the same timeline (a reset-driven rejoin
      records only `session_reset_completed`, never also `reconnected`)
- [x] Retain in DETS (10,000 entries per agent by default; discard oldest;
      configurable with `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT`)

Acceptance: `docs/specs/protocol.md`'s `session_lifecycle` row documents the
finalized `kind`/`trigger` enumeration. Implementation and automated tests
(wrapper + server) are complete (2026-08-31).

## Stage C — operator query

- [x] Add an operator pull-query event (`require_operator` gate, same shape as
      `list_conversations`)
- [x] Update the event table in protocol.md (together with the implementation)

Acceptance: `list_session_events` returns one agent's `session_lifecycle`
timeline (`{ agent_id }` request, format-validated only — no existence
check, so a deleted agent's retained history stays queryable; see
`docs/specs/protocol.md`'s row for the full schema and the retention
rationale). No pagination in this first cut; wire egress size is issue
#278's concern. Implementation and automated tests are complete
(2026-08-31).

## Out of scope

- Dashboard timeline UI ([lifecycle-timeline-ui](../open-questions/lifecycle-timeline-ui.md),
  separate issue)
- Compact observation for the Codex engine
  ([codex-lifecycle-observability](../open-questions/codex-lifecycle-observability.md),
  deferred)
- Triggering automatic compaction (retain the existing P2 decision)
