---
title: Elevate the bundled dashboard into a battery-included minimum practical client (allow additions to the new protocol surface)
status: accepted
date: 2026-06-17
opened: 2026-06-17
supersedes: []
superseded_by: null
related_specs: [non-goals, overview, architecture, protocol]
related_adrs: [7, 12, 25, 36, 41]
---

# ADR-0020 — Elevate the Bundled Dashboard into a Battery-Included Minimum Practical Client

## Status

Accepted

## Context

To advance dogfooding (driving Claude Code routinely through kaoiro’s own dashboard), the bundled dashboard needs the minimum operations equivalent to claude.ai / the Claude Code GUI. The main operations currently missing are: interrupting generation, file upload, skill input completion, client updates, model / effort selection, and displaying the actual token count.

[ADR-0012](0012-response-display-and-dashboard-scope.md) has already elevated the bundled dashboard from “minimal” to an “information-rich operator console.” However, its boundary was “not the number of functions, but **whether a new public protocol surface / server persistence is required**,” and rich functionality requiring a **new protocol surface was still gated**.

Every missing function above requires a **new public protocol surface** (an interrupt operation, publication of the available skill list, upload transfer, update control, and relay of a selection dialog). With the current ADR-0012 boundary, they would fall out of scope.

Public policy: kaoiro aims to be “battery included,” so that a user can do minimum work immediately after installation (apart from initial setup). Anyone needing more or customer customisation should build a custom client (with the kaoiro.nvim Neovim plugin as the intended direction). This is compatible with the client-separation policy in [ADR-0007](0007-client-separation-reference-dashboard.md).

## Decision

- **(F1) Position the bundled dashboard as a “battery-included minimum practical client.”** Provide a state in which minimum interactive operation is self-contained immediately after installation.
- **(F2) Revise the boundary in ADR-0012 and allow additions to the new public protocol surface.** New operations / messages needed for minimum practical use (interrupt, upload, skill completion, client update, model / effort selection) are permitted. Because the protocol is public and versioned ([ADR-0007](0007-client-separation-reference-dashboard.md) / [ADR-0015](0015-protocol-version-stamping.md)), the added surface will also be dogfooded in the bundled client.
- **(F3) Still out of scope** (the latter part of ADR-0012 remains):
  - Turning it into a conversation-authoring environment (full chat).
  - Persistence of conversations / files on the server (future issue #24). Files such as uploads follow the principle of **wrapper-local landing and server pass-through**.
  - Feature richness at the level of external clients (the domain of custom clients).
- **(F4) Track concrete functions in individual issues.** For items with heavy specification work (file upload), run my-spec-elicitation before implementation.
- Update [non-goals](../specs/non-goals.md) to match this decision.

## Consequences

### Positive

- Claude Code can be used practically from the dashboard alone, advancing dogfooding.
- The added protocol surface is continuously verified in the bundled client and becomes an implementation foundation for external clients (kaoiro.nvim, etc.), consistent with ADR-0007’s dogfooding spirit.

### Negative

- The public protocol surface grows, broadening the responsibility to maintain backward compatibility.
- The dashboard’s maintenance surface grows further (an extension following ADR-0012).

### Neutral

- Server persistence and full chat remain out of scope, so the guard against bloat remains.
- Existing dashboard function issues (such as #34) have a changed priority premise under this decision and are subject to reprioritisation.

## Alternatives Considered

| Option | Why rejected |
|--------|--------------|
| Keep ADR-0012’s boundary (rich functionality requiring a new protocol surface is disallowed) | Interrupt, upload, and all similar functions would be out of scope, making dogfooding impossible |
| Implement these functions only in custom clients (kaoiro.nvim, etc.) | The bundled client would not be minimally practical by itself, contrary to “battery included.” It would raise the barrier to adoption |
| Also unlock server persistence (turn it into a full client) | Bloat and the risk of secrets-at-rest. Unnecessary for minimum practical use; it belongs to external clients |

## Related

- specs: [non-goals](../specs/non-goals.md) (updated by this decision), [overview](../specs/overview.md), [architecture](../specs/architecture.md), and [protocol](../specs/protocol.md) (additional operations).
- Related ADRs: [0007](0007-client-separation-reference-dashboard.md) (client separation and bundled-client policy), [0012](0012-response-display-and-dashboard-scope.md) (this decision revises its boundary).
- Tracking issues: interrupt / upload / skill completion (#34) / client update / model and effort selection / actual token count / confirmation of operation files.
- Origin: my-idea-brief (scratch note “implement a full set of functions equivalent to the claude.ai GUI for dogfooding”).
