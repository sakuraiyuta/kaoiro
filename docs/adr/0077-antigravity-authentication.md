---
title: Declare Antigravity authentication before launch
status: accepted
date: 2026-11-22
related_adrs: [57]
---

# ADR-0077 — Declare Antigravity authentication before launch

## Decision

The runner requires an explicit Google Cloud authentication method before
launching an Antigravity wrapper or requesting its model catalog. Personal
sign-in and AI Studio keys are outside the supported methods.
The operator chose Cloud ADC and sign-in with a selected Google Cloud project
in [issue #1181](https://github.com/sakuraiyuta/kaoiro/issues/1181).
The [Antigravity Additional Terms](https://antigravity.google/terms) restrict
access through third-party software and distinguish administrator-governed
Cloud offerings. The operator deferred AI Studio key support pending
clarification of the business API key provision.

## Consequences

The runner checks the declaration, environment markers and accessibility of
the ADC source. It does not open credentials or infer the account or project.
Project-selected sign-in is an operator declaration: the runner cannot
distinguish it from a cached personal sign-in. The same limit applies to the
model catalog probe. Credential precedence with both sign-ins present has
not been measured. See the [measurement](../evidence/antigravity/agy-1.5.14-authentication.md)
and [host setup](../operations/runner-install.md#antigravity-authentication).

The check applies to each new wrapper. A refused restart retains its existing
child, which can still start engine processes. Stop that agent explicitly
when withdrawing authorization. A refused automatic crash restart has no
request to correlate and reports the diagnostic in the runner journal.
The separate version probe remains available.
