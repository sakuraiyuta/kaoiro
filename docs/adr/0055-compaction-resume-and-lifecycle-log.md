---
title: Auto resume after compaction and retention of session lifecycle time series
status: accepted
date: 2026-08-31
opened: 2026-08-09
supersedes: []
superseded_by: null
related_specs: [protocol-inter-agent, protocol]
related_adrs: [43]
---

# ADR-0055 — Automatic resume after compaction and session lifecycle log

## Status

Accepted (2026 (2031, the operator’s discretion in issue #200).
[phase-33](../plans/phase-33-compaction-resume-lifecycle.md)

## Context

agent does not return to work after compaction (2026 (2009)
wait input). The current operation is the use rate of `list_agents` by director
If the director itself is compact, it does not happen manually.
(issue #200) In addition to the operator, when each agent is
compaction / clear-reinit / disconnect
There is no time series, the problem occurs in memory and scatter log per session
dependent (2026 31 operator request).

The starting point of the review is the existing notification at the session restart (planned disconnect)
`reconnecting` / `reconnected` Syn  envel )
However, the existing mechanism is the direction of "inform others to reboot"
compaction does not include cutting, so it lacks the premise of return detection. while compaction
wrapper can be local observation with `compact_boundary` log.
Specification.

## Decision

separation requests to two layers.

wrapper. Home
`request_compact` add optional `resume_prompt` and when booking
(When full context is present) the agent itself. wrapper
If `compact_boundary` is observation, the prefix template +
resume prompt serialization instruction queue same as threshold notification
Inject as user turn via. When omitted, it is perfectly matched with the current situation (opt-in).
Claude engine If the wrapper drops during compaction, the booking

2. The server keeps the transition record in time series. Home
Event 1 `session_lifecycle` (CO / trigger / occurrence time)
wrapper to observation (compact start/complete, session reset, threshold notification)
ignition, resume fired
disconnect / reconnect to the same time series. Retention is DETS
Persistent, destroyed in old order with 10,000 defaults per agent, and env
(`SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT`) Record toerer
No notifications. `require_operator`
first cut).

## Rejected

- **Delivery via resume server** (complete event + vel envel  return) —
Resume reliability depends on server reciprocating. Possible observation requires a record layer independently
We will explain why you can ship to server.
- **`reconnecting`/`reconnected` Direct flow of mechanism** — the direction of notification is reversed,
Missing the premise of cutting and return detection.
New individual events

- **in-memory ring buffer retention** — you can't re-start.
The writing frequency is low, the burden of persistence is small.
- ** Simultaneous implementation of Dashboard Timeline UI** — Scope hypertrophy.
  [lifecycle-timeline-ui](../open-questions/lifecycle-timeline-ui.md)
separation and issue #175 redefining this record as a consumer.

## Consequences

- The work co ation over compaction is automated by self-writing instructions at the time of booking, and the
Manual kick operation (and blank at director's own compact) is unnecessary.
- resume reserved / resume fired remains time series, so wrapper disappears
It is possible to distinguish the case where the reservation disappears.
- codex engine is only available in this disconnect system.
  ([codex-lifecycle-observability](../open-questions/codex-lifecycle-observability.md)
pending).
- Auto compaction (#158 decision P2: operator approval required)
Not touched.
