---
title: Upgrade the bundled dashboard to a minimum of battery-included clients (to allow adding new protocols)
status: accepted
date: 2026-06-17
opened: 2026-06-17
supersedes: []
superseded_by: null
related_specs: [non-goals, overview, architecture, protocol]
related_adrs: [7, 12, 25, 36, 41]
---

# ADR-0020 — Upgraded the bundled dashboard to a minimum of battery-included clients

## Status

Accepted

## Context

dogfooding(kaoiro drives Claude Code on a daily basis)
The included dashboard corresponds to claude.ai / Claude Code GUI
There is a required function. Main operations that are missing in the current situation: interrupts during generation, files
Upload, skip completion, client update, model / effort ,
actual number display.

[ADR-0012](0012-response-display-and-dashboard-scope.md) is already included in Dash
The board has been upgraded from "minimum" to "information rich operator console". However,
The linear pull is not the number of functions**Is it necessary to persist on a new public protocol surface / server?**」
Note**The richness that requires the new protocol remains gated**.

All of the above features**New Public Protocol Face**Required (disco ed, available)
skill Publish list, upload forward, update control, select dialog relay). Current
ADR-0012 ADR-0012

Publish Policy: kaoiro can be done quickly ( ing initial settings)
"battery included" If you need more / customer custom, your own client
to kaoiro.nvim.
[ADR-0007](0007-client-separation-reference-dashboard.md) Client separation
Compatibility with the policy.

## Decision

- **(F1) Included Dashboard with "battery-included minimum utility client"
permission Provides a state where minimum dialogue operation is completed by a single unit immediately after implementation.
- **(F2) Revise ADR-0012 line and allow adding new public protocol surfaces**.
Required operation for minimum operation (sus , upload, skill completion, client update, etc.)
New  e-Note / message for model / effort.) is acceptable. Protocol
Published and versioned
  ([ADR-0007](0007-client-separation-reference-dashboard.md) /
[ADR-0015](0015-protocol-version-stamping.md))
dogfooding
- **(F3) Still non-scope**ADR-0012
- Conversation Authoring Environment (Full Chat).
- Server conversation / file persistence (coming issue #24). Upload
File**wrapper-local**Principle.
- High functionality of external client class.
- **(F4)Body feature by individual issue**Heavy specification (file)
upload) passes my-spec-elicitation before implementation.
- Update [non-goals](../specs/non-goals.md) according to this decision.

## Consequences

### Positive

- You can drive Claude Code on a single dashboard and dogfooding goes on.
- An additional protocol surface is alwaysthe relevant entryd with the included client and theternal client
(e.g., kaoiro.nvim) is the foundation of implementation (conforming with ADR 7’s dogfooding spirit).

### Negative

- Increased public protocol surfaces and increased backward compatibility.
- Dashboard maintenance (extension following ADR-0012).

### Neutral

- ServerChat and full-chat continue to be non-scoped and keeps obese teeth.
- Existing dashboard function issue(#34 etc.) will change the premise of priority in this decision,
Re-priority.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
|Maintain ADR-0012 line pulling (not riching required for new protocols)|All interruptions, uploading, etc. fall into non-scope and dogfooding is not established|
|Implementing these functions only on the client (kaoiro.nvim, etc.)|Contrary to "battery included" without minimum use only with the bundle. Introductory housing rises|
|Unblock server server (full client)|Risk of hypertrophy and secrets-at-rest. No minimum utility required, and theternal of the ex  client|

## Related

-COs: [non-goals](../specs/non-goals.md),
  [overview](../specs/overview.md),[architecture](../specs/architecture.md),
[protocol](../specs/protocol.md)
-> ADR: [0007](0007-client-separation-reference-dashboard.md)
(client separation/consolidation policy),
[0012](0012-response-display-and-dashboard-scope.md)
-  issue: Suspended / Upload / skill Completion (#Clients/ Client Update /
Model・effortFile / Token quantity / Operation file confirmation.
- Origin: my-idea- ef
  dogfooding」).
