---
title: Automatic resume after compaction and retaining a session-lifecycle timeline
status: accepted
date: 2026-08-31
opened: 2026-08-09
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, protocol]
related_adrs: [43]
---

# ADR-0055 — Automatic resume after compaction and retaining a session-lifecycle timeline

## Status

Accepted (2026-08-31, an operator decision in the spec elicitation for issue #200).
Implementation: [phase-33](../plans/phase-33-compaction-resume-lifecycle.md).

## Context

After compaction, an agent does not return to work on its own (measured on
2026-08-09: it stopped in waiting_input after compression completed). Current
operations have the director manually kick it after seeing a sharp drop in
`list_agents` usage, but nobody can do so when the director itself
compacts (issue #200). In addition, operators have no timeline for later
tracing when each agent transitioned through compaction / clear-reinit /
disconnect, or by which operation. When problems occur, debugging depends on
session-by-session memory and scattered logs (operator request, 2026-08-31).

The starting point for consideration was a server-mediated approach modeled on
the existing notifications at session restart (the planned-disconnect
`reconnecting` / `reconnected` synthetic envelopes), but that
mechanism is oriented toward “telling **others** about one's own restart”, and
compaction does not involve a disconnect, so it lacks the premise for detecting
resumption. Meanwhile, completion of compaction is already specified as a local
observation by the wrapper through a `compact_boundary` log.

## Decision

Separate the requirements into two layers.

1. **Complete resume delivery locally in the wrapper.**
   Add optional `resume_prompt` to `request_compact` and have the agent
   write it at reservation time (while full context is available). When the
   wrapper observes `compact_boundary`, inject the fixed prefix template
   plus the verbatim resume_prompt as a user turn through the serialized
   instruction queue, the same path used by the threshold notice. If omitted,
   behavior is exactly unchanged (opt-in). Claude engine only. If the wrapper
   crashes during compaction, the reservation may be lost.
2. **Have the server retain the transitions chronologically.**
   Report wrapper-observable transitions (compaction start/completion, session
  reset, threshold-notice firing, resume_reserved / resume_fired)
   to the server with one new event, `session_lifecycle`
   (kind / trigger / occurrence time), and merge server-known disconnect /
   reconnect into the same timeline. Persist it in DETS, discard oldest entries
   first with a default of 10,000 per agent, and make the limit configurable
   through the env
   (`SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT`). Recording does not notify
   peers. Use an operator-facing pull query (a `require_operator` gate,
   same shape as `list_conversations`) as the first cut.

## Rejected

- **Server-mediated resume delivery** (completion event + synthetic envelope
  returned) — resume reliability would depend on a server round trip. The
  observability requirement is met independently by the recording layer, so
  there is no reason to put delivery on the server as well.
- **Directly reuse the `reconnecting`/`reconnected` mechanism** — the
  notification direction is reversed, and it lacks the premise for detecting
  disconnection and recovery.
- **Add individual events per kind** — each new kind would require a protocol
  revision.
- **Keep an in-memory ring buffer** — debugging across a restart would be
  impossible. The write frequency is low and the persistence burden is small.
- **Implement the dashboard timeline UI at the same time** — scope expansion.
  Split it into [lifecycle-timeline-ui](../open-questions/lifecycle-timeline-ui.md)
  and redefine issue #175 as a consumer of this recording layer.

## Consequences

- Work can continue across compaction automatically through the self-written
  instruction made at reservation time, removing the director's manual-kick
  operation (and the gap when the director itself compacts).
- Because resume_reserved / resume_fired remain in the
  timeline, it is possible to determine afterward when a reservation was lost
  because the wrapper disappeared.
- For now, the codex engine contributes only disconnect-related events to the
  timeline (pending in
  [codex-lifecycle-observability](../open-questions/codex-lifecycle-observability.md)).
- This does not touch the mechanism that triggers automatic compaction
  (decision P2 for issue #158: operator approval required).
