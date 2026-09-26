---
title: Input-bound inter-agent replies
description: Use negotiated server comparison and single-use inline reply authorization instead of automatic interruption.
status: accepted
date: 2026-09-26
related_adrs: [32, 36, 38, 57]
---

# ADR-0062 — Input-bound inter-agent replies

## Context

A peer message can be accepted while the receiving engine is still executing an
older input. Replies based on that older input can then cross a correction or
closure proposal. Delivery ack and queue receipt do not establish which input
produced a tool call. Calls can also survive their originating turn.

## Decision

Use the [reply-basis contract](../reference/inter-agent/reply-basis.md): immutable
actual-input defaults, server comparison at atomic admission, bounded inline
recovery with explicit ownership/ack, and unpredictable single-use tickets for
same-turn replies. Bind ordinary tool sends to their originating engine turn and
recheck immediately before the send sink. Negotiate v1; accept old wrappers as
unprotected during rollout. Validated internal notices have a closed exception.

The operator approved this design on 2026-09-26. Claude and Codex implementation
can proceed while Antigravity native measurement is outstanding. Landing requires
that measurement decision and implementation review; full-engine protection must
not be inferred from common ToolHost tests.

## Alternatives and consequences

Manual basis entry on every send adds transcription retries without proving
cognition. An automatic default from actual input addresses the observed stale
input while retaining explicit, ticket-authorized inline responses. A mutable
wrapper-wide default could let concurrent or delayed calls borrow later input.

Unconditional interruption cancels work on acknowledgements and ordinary informs,
can leave partial side effects, and differs across engines. It neither rolls back
external writes nor substitutes for atomic send admission. Selected interruption
remains a future option. Engine-native fold/steer work is tracked separately in
issue #412. ADR-0036 F6's refusal to automatically interrupt busy reset operations
remains unchanged; this decision adds no automatic interrupt or reset.

Tickets add schema/result fields and local retry errors. Their purpose is
unpredictability before input handoff, not secrecy from transcripts. Definite
transient rejection can renew authorization; unknown delivery cannot safely do so.
Engine binding, recovery ownership, and server comparison are one integrated
landing, with layer-specific commits and checks. Issue #407 remains open for
cross-thread cases and the required operational before/after comparison.
