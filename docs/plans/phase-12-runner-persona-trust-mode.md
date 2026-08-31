---
title: Phase 12 — Runner Persona Acceptance: Allowlist/Blacklist Two-Mode Selection
description: ADR-0031 implementation phase. Introduce allowed_personas / blocked_personas in runner.config.json with accept-all as the default. Decisions are completed on the server side (AgentsChannel / HostRegistry); the existing personas field is retained for one release as a compatibility window.
status: done
phase: 12
depends_on: [phase-10-persona-server-sot]
last_updated: 2026-07-07
---

# Phase 12 — Runner Persona Acceptance: Two-Mode Selection

## Goal

Based on [ADR-0031](../adr/0031-runner-persona-trust-mode.md), allow the declaration
of “personas that can be started on this host,” previously fixed to the runner's
`personas[]` allowlist, to have **three states: allowlist / blacklist / accept-all**.
The default accept-all structurally eliminates the papercut of editing
`runner.config.json` every time a pack is added (recurred twice when fuji was
added).

Decisions are completed on the server side (`AgentsChannel` determines whether
spawn is allowed from the `PersonaAssets` set and policy), and the runner's role
is only to “declare the policy.” Retain the existing `personas: [...]` field for
one release as a compatibility window, operate compatibly as an allowlist with a
deprecation warning, and remove it in the next major release.

Remove special treatment for the `default` persona and allow it to be listed in
the blocklist/allowlist on equal terms with other ids (an empty spawnable set is
a valid state for a canary / preparing host; the dashboard explicitly shows an
empty picker).

## Acceptance Criteria

- [x] Omitting `personas` from `runner.config.json` operates as accept-all
- [x] `allowed_personas: ["ao"]` allows only ao to start (even when other packs have been ingested)
- [x] `blocked_personas: ["fuji"]` prevents only fuji from starting (all others are allowed)
- [x] `blocked_personas: ["default"]` excludes default from the spawn picker
- [x] A config containing both `allowed_personas` and `blocked_personas` is rejected
  fail-loud (both when starting the runner and when registering with the server)
- [x] A config containing only the existing `personas: [{id,...}]` operates as an
  allowlist-compatible config and emits deprecation warnings to runner stderr and
  the server Logger
- [x] A config containing both `allowed_personas` and `personas` fails loud
- [x] After a new pack is ingested on the server, a running blacklist-mode runner
  can spawn that pack without re-registering (the benefit of server-side decisions)
- [x] Special treatment in `HostRegistry.inject_default/1` has been removed
- [x] The `scripts/dev.sh` generated template is accept-all (no persona field or
  `blocked_personas: []`)
- [x] mix test / pnpm test / pnpm typecheck all pass (server 296 / runner 79 /
  wrapper 263 / dashboard 71)
- [x] One round of `/my-code-review-cycle` converged (must-fix 0, advisory 1:
  status drift resolved by checking off this plan)

## Tasks

### Stage phase-0 (protocol / foundation for the server-centralized SoT)

| # | Task | Status | Notes |
|---|------|--------|-------|
| A-1 | Add `allowed_personas?`/`blocked_personas?` to protocol `RunnerRegister`; make `personas?` optional (legacy) | ✅ | Wire is an array of id strings |
| A-2 | Add `PersonaAssets.all_personas/0` (list of id/name/sprite_set maps including packs + reserved default) | ✅ | Referenced by HostRegistry and AgentsChannel |
| A-3 | Rebuild `HostRegistry` as a `:policy`-holding type, remove `inject_default/1`, and change `snapshot/1` etc. to accept personas_pool | ✅ | Remove the `:personas` field from entries |
| A-4 | Make `RunnerChannel.parse_register/1` support two modes + exclusivity checks + legacy personas compatibility (Logger.warning) | ✅ | Both modes together or new+legacy yields `invalid_register` |
| A-5 | Wire callers of `AgentsChannel.resolve_persona/2` to pass personas_pool | ✅ | Decisions basically complete through get_public; retain the interface |
| A-6 | Update `HostRegistry` / `RunnerChannel` / `PersonaAssets` / `AgentsChannel` tests | ✅ | Pool arguments + three-mode matrix |

### Stage phase-1 (runner side)

| # | Task | Status | Notes |
|---|------|--------|-------|
| B-1 | Add `allowed_personas`/`blocked_personas` to `runner/src/config.ts`, make `personas` optional, and validate exclusivity | ✅ | Old personas deprecation goes to stderr |
| B-2 | Update `buildRegister` for the new wire | ✅ | Send one of the three states |
| B-3 | Remove `scheduleAllowlistCheck` / `fetchAndReport` / related constants from `runner/src/cli.ts` | ✅ | Unnecessary because decisions are completed on the server |
| B-4 | Update `runner/test/config.test.ts` (three modes + exclusivity + compatibility) | ✅ | |

### Stage phase-2 (cutover)

| # | Task | Status | Notes |
|---|------|--------|-------|
| C-1 | Change the `scripts/dev.sh` generated template to accept-all (only a `blocked_personas: []` hint) | ✅ | Preserve the behavior of not overwriting existing config |
| C-2 | Rewrite `docs/specs/personas.md` for two-mode support | ✅ | Explicitly document normal treatment of default / an empty spawnable set is allowed |
| C-3 | Promote ADR-0031 to `status: accepted` and update last_updated | ✅ | After confirming implementation completion and a clean `/my-code-review-cycle` |
| C-4 | Implementation commit → docs commit → push | ✅ | Japanese commits, separated at boundaries |

Status legend: ✅ done, 🟡 mostly done, ⚠ partial, ⏳ not started, ⛔ blocked.

### Additional implementation (unexpected secondary fixes)

Two bugs were detected during implementation dogfooding and fixed within this phase:

- `HostRegistry.public_entry/2` left `:policy` (a `{atom, MapSet}` tuple) in the
  operator snapshot, causing Jason.encode to crash with
  `Protocol.UndefinedError` and disabling all `hosts` pushes. Resolved with
  `Map.drop([:runner_pid, :policy])` and a regression test asserting Jason
  encodability. **A bug newly introduced by this ADR-0031 implementation**.
- A race called `wrapper/src/cli.ts onSetPermissionMode` before `host` was built,
  causing `TypeError: Cannot read properties of undefined (reading
  'setPermissionMode')`. This was **pre-existing but became certain to manifest**
  because of the frequent after_join pushes in the ADR-0030 restore path. Fixed by
  buffering it in `pendingPermissionMode` and applying it immediately after host
  construction (consistent with host.ts's design in which setPermissionMode
  before run() overwrites the initial mode).

## Open Questions Blocking This Phase

None (resolved in [ADR-0031](../adr/0031-runner-persona-trust-mode.md)).

## Out of Scope

The following are outside this phase ([ADR-0031](../adr/0031-runner-persona-trust-mode.md)
Non-Goals):

- per-token persona ACL (trust from server → runner)
- id versioning / wildcards / namespaces
- Lever on the common-footer side
- Dynamic mode switching
- Explicit alerts for hosts with zero spawnable personas

## See Also

- ADR: [0031](../adr/0031-runner-persona-trust-mode.md),
  [0029](../adr/0029-persona-server-sot-and-pack-distribution.md),
  [0023](../adr/0023-host-runner-architecture.md)
- Previous: [phase-10-persona-server-sot](phase-10-persona-server-sot.md)
