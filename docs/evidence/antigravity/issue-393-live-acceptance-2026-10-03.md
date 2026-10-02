---
title: "Issue 393 live acceptance, 2026-10-03"
description: One-turn live check of the stale terminal quota error and follow-up usage state.
status: measured
related: [antigravity-events]
---

# Issue 393 live acceptance, 2026-10-03

The production `runAntigravityCli` composition ran inside
`scripts/run-antigravity-test-namespace.py`, with an outer 600-second timeout.
The probe resumed the most recently modified retained diagnostic conversation
whose transcript contained the captured `RESOURCE_EXHAUSTED` / `Resets in 0s`
marker. The conversation id, account identifiers, and credentials were not
recorded. Exactly one model turn was sent; the follow-up `/usage` command was a
quota-free CLI command.

Stage 1 reproduced the stale terminal marker in a `result` error. Stage 2
observed the completed peer notice as `rate_limit`, an initial `state_change`
with the blocked overlay, and a later `state_change` with positive same-family
usage after the production usage probe. The later state update did not revise
the completed peer notice.

The same run also logged a separate out-of-turn `result` with status `ERROR`;
the host discarded it as an out-of-turn event. This observation is retained as
diagnostic context and is not treated as a second peer turn or a second
acceptance result.

The one-turn Vitest acceptance command exited 0. Its temporary test file was
removed after the run so no local account transcript discovery logic remains
in the package. The sanitized captured input/output fixtures used by the
deterministic host test are committed alongside this note.
