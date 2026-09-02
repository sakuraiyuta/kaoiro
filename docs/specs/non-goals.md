---
title: Non-goals
description: Areas kaoiro does not address initially: multi-user RBAC/multi-tenancy, animation/3D rendering, modification of agent implementations, advanced sentiment analysis, and turning the bundled dashboard into a conversation-authoring environment or persistent history.
status: accepted
related: [overview]
---

# Non-goals

## Purpose

States explicitly what kaoiro does not address initially. Scope is defined in
[overview](overview.md).

## Definition

Not done initially; may be considered in the future:

- **Modifying or building agent implementations**. kaoiro remains a wrapper and
  visualization layer.
- **Advanced sentiment analysis**. Initially, it is minimal flavoring only
  ([plans/phase-6-emotion-filter](../plans/phase-6-emotion-filter.md)).
- **Multi-user access, fine-grained RBAC, and multi-tenant isolation**. OAuth
  identity authentication itself was implemented in phase-26 (Google / GitHub /
  Nextcloud + a text allowlist,
  [ADR-0042](../adr/0042-oauth-allowlist-login.md)), but roles remain the two
  values `operator` and `viewer`; there is neither finer division such as an
  approver role nor an agent-ownership boundary (a single-tenant assumption).
  The original stub policy is [ADR-0005](../adr/0005-access-control-oauth-stub.md);
  current boundaries are documented in the Known gaps of
  [auth-and-authz](auth-and-authz.md).
- **Advanced animation/3D rendering**. The prototype switches between static
  expression variants
  ([ADR-0004](../adr/0004-client-rendering-staged.md)).
- **Making the client implementation richer (it remains a separate project)**.
  Diverse clients (Electron GUI / terminal CUI / neovim plugin, etc.) remain
  separate projects (repositories); the only bundled component is a reference
  dashboard for the browser
  ([ADR-0007](../adr/0007-client-separation-reference-dashboard.md)).
  The bundled dashboard may, however, extend to an **information-rich operator
  console** that is minimally useful on its own: a state list, expressions,
  approvals, instruction input, and response display
  ([ADR-0012](../adr/0012-response-display-and-dashboard-scope.md)). The original
  boundary was not “number of features,” but whether it required a **new public
  protocol surface or server persistence**. [ADR-0020](../adr/0020-dashboard-battery-included-client.md)
  raised this to a **battery-included, minimally useful client** and permits the
  **addition of public protocol surface required for minimum usefulness**
  (interrupts, uploads, skill completion, client updates, and model/effort
  selection, etc.). The following remain out of scope: becoming a conversation
  authoring environment (a full chat), **server-side persistence of
  conversations/files** (future issue #24), and capabilities on the level of
  external clients.
- **Antivirus scanning of uploaded files**. This is left to the host OS or an
  external AV solution. Neither wrapper, server, nor client runs AV
  ([ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)).

## See Also

- Related specs: [overview](overview.md)
- ADRs: [0004](../adr/0004-client-rendering-staged.md),
  [0005](../adr/0005-access-control-oauth-stub.md),
  [0042](../adr/0042-oauth-allowlist-login.md),
  [0007](../adr/0007-client-separation-reference-dashboard.md),
  [0012](../adr/0012-response-display-and-dashboard-scope.md),
  [0020](../adr/0020-dashboard-battery-included-client.md)
