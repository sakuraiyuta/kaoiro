---
title: Compaction resume and lifecycle log
description: Implement the wrapper-local resume_prompt for request_compact and retention of the session_lifecycle timeline with an operator query.
status: in_progress
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

- [ ] Add a wrapper→server `session_lifecycle` event (kind / trigger / occurrence
      time)
- [ ] Wrapper producer: compact start/complete (trigger: request_compact /
      sdk_auto), threshold-notice firing, resume_reserved / resume_fired
- [ ] Merge server-side disconnect / reconnect / session reset into the same
      timeline
- [ ] Retain in DETS (10,000 entries per agent by default; discard oldest;
      configurable with `SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT`)

## Stage C — operator query

- [ ] Add an operator pull-query event (`require_operator` gate, same shape as
      `list_conversations`)
- [ ] Update the event table in protocol.md (together with the implementation)

## Out of scope

- Dashboard timeline UI ([lifecycle-timeline-ui](../open-questions/lifecycle-timeline-ui.md),
  separate issue)
- Compact observation for the Codex engine
  ([codex-lifecycle-observability](../open-questions/codex-lifecycle-observability.md),
  deferred)
- Triggering automatic compaction (retain the existing P2 decision)
