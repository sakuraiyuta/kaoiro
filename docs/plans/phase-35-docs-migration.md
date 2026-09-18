---
title: Phase 35 — Docs migration to the layered taxonomy
description: Move docs/specs (and the operations manual, README runbook sections, ADR-0058 appendices) into architecture / operations / reference / adr / evidence / contributing, one unit per commit, after the semantic sync of issue #368 Phase A.
status: in_progress
phase: 35
depends_on: []
last_updated: 2026-09-18
---

# Phase 35 — Docs migration to the layered taxonomy

## Goal

Execute [ADR-0060](../adr/0060-documentation-taxonomy-and-migration.md) for the
existing tree: every old page is moved, split or merged into the layered
folders following the migration table in
[issue #368](https://github.com/sakuraiyuta/kaoiro/issues/368) (the working
table, section level for the five largest files). Rules for each unit are in
[contributing/documentation.md](../contributing/documentation.md)
("Reorganizing existing pages"): one move commit per unit, in-repo references
updated in the same commit, an old-path stub whose headings resolve the
existing fragments, entry page updated, three reading paths walked, reviewer
≠ writer.

Phase A (semantic sync, 55 ledger rows) landed on develop 1a0d9ecb; this phase
is the move.

## Units

Paths: ops = operations update, perm = permission recovery, impl = adapter
implementation — the emphasis marks; all three are walked at every close.

| Unit | Scope | Paths | Status |
|---|---|---|---|
| U01 | envelope / channel index / versioning | ops perm impl | ⏳ |
| U02 | permission state / requests / sync-audit | perm impl | ⏳ |
| U03 | model-effort / capabilities | perm impl | ⏳ |
| U04 | session lifecycle / state machine | ops perm impl | ⏳ |
| U05 | display-history / IA sidecar | ops impl | ⏳ |
| U06 | tasks / subagent visibility | impl | ⏳ |
| U07 | attachments | impl | ⏳ |
| U08 | runner control / wrapper config | ops impl | ⏳ |
| U09 | persona delivery / injection / pack | ops impl | ⏳ |
| U10 | security / threat model / release audit | ops perm impl | In review |
| U11 | IA messages / conversations / admission | impl | ⏳ |
| U12 | IA dispatch / delivery ledger | perm impl | ⏳ |
| U13 | coordination monitoring | perm impl | ⏳ |
| U14 | directory / companion tools / peer routing | impl | ⏳ |
| U15 | per-engine IA tool authorization | perm impl | ⏳ |
| U16 | peer errors / synthetic notices | perm impl | ⏳ |
| U17 | session tools (compact / reset) | perm impl | ⏳ |
| U18 | server install / network / login / env | ops | ⏳ |
| U19 | runner install / config / wizard | ops impl | ⏳ |
| U20 | server update / rollback / transactions | ops | ⏳ |
| U21 | runner update / rollback / artifacts / service verification | ops | ⏳ |
| U22 | deployment troubleshooting | ops | ⏳ |
| U23 | UI design group (visual language, tokens, layout, motion) | perm | ⏳ |
| U24 | codex app-server architecture / reference + ADR-0058 evidence extraction | perm impl | ✅ |
| U25 | codex backend switch runbook | ops perm impl | ✅ |
| U26 | antigravity adapter / events / tools-permissions / evidence | perm impl | ⏳ |
| U27 | codex exec events / model catalog | perm impl | ✅ |
| U28 | claude events | perm impl | ⏳ |
| U29a | entry pages: overview, system-overview, scope, glossary; folder scaffolding; this plan | ops perm impl | ✅ |
| U29b | plugin-model split (extensions, adapter contract, claude model catalog) | impl | ⏳ |
| U30 | kept pages (personas, agent-operations): update references only | impl | ⏳ |
| U31 | protocol-external-human provisional marker | impl | ⏳ |
| U32 | entry page and specs residue, final | ops perm impl | ⏳ |
| U33 | runner development / build procedures | ops impl | ⏳ |

Writer rules: one writer per destination file; units that touch the same file
(ADR-0058 and the codex README for U24 / U25 / U27; the runner README for U19
/ U21 / U33) are serialised. Checker ≠ editor.

## Moved pages (old path → new path)

| Old | New | Unit |
|---|---|---|
| specs/overview.md | [architecture/overview.md](../architecture/overview.md) | U29a |
| specs/architecture.md | [architecture/system-overview.md](../architecture/system-overview.md) | U29a |
| specs/non-goals.md | [architecture/scope.md](../architecture/scope.md) | U29a |
| specs/glossary.md | [reference/glossary.md](../reference/glossary.md) | U29a |
| specs/codex-sdk-events.md | [reference/engines/codex-exec-events.md](../reference/engines/codex-exec-events.md) | U27 |
| specs/codex-sdk-events.md | [evidence/codex/exec-contract.md](../evidence/codex/exec-contract.md) | U27 |
| specs/codex-model-catalog.md | [reference/engines/codex-model-catalog.md](../reference/engines/codex-model-catalog.md) | U27 |
| specs/codex-model-catalog.md | [operations/codex-model-settings.md](../operations/codex-model-settings.md) | U27 |
| specs/codex-model-catalog.md | [evidence/codex/model-catalog.md](../evidence/codex/model-catalog.md) | U27 |
| ../../wrapper/codex/README.md (implementation) | [reference/engines/codex-app-server.md](../reference/engines/codex-app-server.md) | U24 |
| ../../wrapper/codex/README.md (implementation) | [reference/engines/codex-app-server-session.md](../reference/engines/codex-app-server-session.md) | U24 |
| ../../wrapper/codex/README.md (implementation) | [reference/engines/codex-app-server-events.md](../reference/engines/codex-app-server-events.md) | U24 |
| ../../wrapper/codex/README.md (implementation) | [reference/engines/codex-app-server-settings.md](../reference/engines/codex-app-server-settings.md) | U24 |
| ../../wrapper/codex/README.md (implementation) | [reference/engines/codex-app-server-history.md](../reference/engines/codex-app-server-history.md) | U24 |
| adr/0058-codex-app-server-turn-steer.md (Appendices A–C through increment 5e) | [evidence/codex-app-server/transport-spikes-2026-09-14.md](../evidence/codex-app-server/transport-spikes-2026-09-14.md) | U24 |
| adr/0058-codex-app-server-turn-steer.md (Appendices A–C through increment 5e) | [evidence/codex-app-server/stage1-compatibility.md](../evidence/codex-app-server/stage1-compatibility.md) | U24 |
| adr/0058-codex-app-server-turn-steer.md (Appendices A–C through increment 5e) | [evidence/codex-app-server/session-and-bridge.md](../evidence/codex-app-server/session-and-bridge.md) | U24 |
| adr/0058-codex-app-server-turn-steer.md (Appendices A–C through increment 5e) | [evidence/codex-app-server/projection-and-history.md](../evidence/codex-app-server/projection-and-history.md) | U24 |
| adr/0058-codex-app-server-turn-steer.md (Appendices A–C through increment 5e) | [evidence/codex-app-server/settings-and-permission.md](../evidence/codex-app-server/settings-and-permission.md) | U24 |
| adr/0058-codex-app-server-turn-steer.md (Appendices A–C through increment 5e) | [evidence/codex-app-server/host-composition.md](../evidence/codex-app-server/host-composition.md) | U24 |
| ../../wrapper/codex/README.md (implementation) | [architecture/codex-backends.md](../architecture/codex-backends.md) | U24 |
| docs/adr/0058-codex-app-server-turn-steer.md (increment 6) | [evidence/codex-app-server/backend-rollback-artifact.md](../evidence/codex-app-server/backend-rollback-artifact.md) | U25 |
| docs/operations/production.md (Codex backend section) | [operations/codex-backend-switch.md](../operations/codex-backend-switch.md) | U25 |
| wrapper/codex/README.md (backend contract) | [reference/configuration/runner.md](../reference/configuration/runner.md) | U25 |
| operations/production.md (Release note) | [Stage 6 landing record](https://github.com/sakuraiyuta/kaoiro/issues/348#issuecomment-5726375118) | U25; duplicate of existing issue record |
| specs/auth-and-authz.md | [architecture/security-boundaries.md](../architecture/security-boundaries.md) | U10 |
| specs/auth-and-authz.md; specs/protocol.md (Connection authentication) | [reference/security/authentication-authorization.md](../reference/security/authentication-authorization.md) | U10 |
| specs/auth-and-authz.md (common tool authorization; IA sections retained for U15) | [reference/security/tool-authorization.md](../reference/security/tool-authorization.md) | U10 |
| specs/auth-and-authz.md (release checklist) | [operations/security-release-audit.md](../operations/security-release-audit.md) | U10 |
| specs/threat-model.md | [architecture/security-threat-model.md](../architecture/security-threat-model.md) | U10 |
| specs/threat-model.md (constraints) | [reference/security/enforcement-boundaries.md](../reference/security/enforcement-boundaries.md) | U10 |
