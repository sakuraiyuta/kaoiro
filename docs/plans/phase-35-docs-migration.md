---
title: Phase 35 — Docs migration to the layered taxonomy
description: Move docs/specs (and the operations manual, README runbook sections, ADR-0058 appendices) into architecture / operations / reference / adr / evidence / contributing, one unit per commit, after the semantic sync of issue #368 Phase A.
status: in_progress
phase: 35
depends_on: []
last_updated: 2026-09-19
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
| U01 | envelope / channel index / versioning | ops perm impl | ✅ |
| U02 | permission state / requests / sync-audit | perm impl | ✅ (rationale folded into architecture/security-boundaries.md) |
| U03 | model-effort / capabilities | perm impl | ✅ (capability advertisement from plugin-model.md folded in) |
| U04 | session lifecycle / state machine | ops perm impl | ✅ (rationale folded into architecture/system-overview.md) |
| U05 | display-history / IA sidecar | ops impl | ⏳ |
| U06 | tasks / subagent visibility | impl | ✅ (measurement split to evidence/claude) |
| U07 | attachments | impl | ✅ |
| U08 | runner control / wrapper config | ops impl | ✅ (no architecture page; rationale = ADR-0024 D1) |
| U09 | persona delivery / injection / pack | ops impl | ✅ (U09a pack-format, U09b delivery / injection) |
| U10 | security / threat model / release audit | ops perm impl | ✅ |
| U11 | IA messages / conversations / admission | impl | ✅ |
| U12 | IA dispatch / delivery ledger | perm impl | ✅ |
| U13 | coordination monitoring | perm impl | ✅ |
| U14 | directory / companion tools / peer routing | impl | ✅ |
| U15 | per-engine IA tool authorization | perm impl | ⏳ |
| U16 | peer errors / synthetic notices | perm impl | ✅ |
| U17 | session tools (compact / reset) | perm impl | ✅ |
| U18 | server install / network / login / env | ops | ⏳ |
| U19 | runner install / config / wizard | ops impl | ⏳ |
| U20 | server update / rollback / transactions | ops | ⏳ |
| U21 | runner update / rollback / artifacts / service verification | ops | ⏳ |
| U22 | deployment troubleshooting | ops | ⏳ |
| U23 | UI design group (visual language, tokens, layout, motion) | perm | ✅ reachability (U23a); design / layout pending |
| U24 | codex app-server architecture / reference + ADR-0058 evidence extraction | perm impl | ✅ |
| U25 | codex backend switch runbook | ops perm impl | ✅ |
| U26 | antigravity adapter / events / tools-permissions / evidence | perm impl | ✅ (mechanical move; dedup pass optional) |
| U27 | codex exec events / model catalog | perm impl | ✅ |
| U28 | claude events | perm impl | ✅ |
| U29a | entry pages: overview, system-overview, scope, glossary; folder scaffolding; this plan | ops perm impl | ✅ |
| U29b | plugin-model split (extensions, adapter contract, claude model catalog) | impl | ✅ (capability advertisement retained for U03) |
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
| specs/agent-sdk-events.md | [reference/engines/claude-events.md](../reference/engines/claude-events.md) | U28 |
| specs/persona-pack-schema.md | [reference/personas/pack-format.md](../reference/personas/pack-format.md) | U09 |
| specs/responsive-reachability.md | [reference/ui/responsive-reachability.md](../reference/ui/responsive-reachability.md) | U23 |
| specs/plugin-model.md (extension architecture) | [architecture/extensions.md](../architecture/extensions.md) | U29b |
| specs/plugin-model.md (EngineAdapter contract) | [reference/engines/adapter-contract.md](../reference/engines/adapter-contract.md) | U29b |
| specs/plugin-model.md (Claude model catalog) | [reference/engines/claude-model-catalog.md](../reference/engines/claude-model-catalog.md) | U29b |
| specs/plugin-model.md (session capability advertisement retained) | [specs/plugin-model.md](../specs/plugin-model.md) | U03 pending |
| specs/antigravity-cli-events.md | [architecture/antigravity-adapter.md](../architecture/antigravity-adapter.md) | U26 |
| specs/antigravity-cli-events.md | [reference/engines/antigravity-events.md](../reference/engines/antigravity-events.md) | U26 |
| specs/antigravity-cli-events.md | [reference/engines/antigravity-tools-permissions.md](../reference/engines/antigravity-tools-permissions.md) | U26 |
| specs/antigravity-cli-events.md | [evidence/antigravity/cli-contract.md](../evidence/antigravity/cli-contract.md) | U26 |
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
| specs/protocol-inter-agent.md (Purpose; Overview) | [architecture/inter-agent-messaging.md](../architecture/inter-agent-messaging.md) | U11 |
| specs/protocol-inter-agent.md (envelope.type: "inter_agent_message"; Inner envelope(`payload` schema); kind enum (nine values); Reserved `envelope.type` and version) | [reference/inter-agent/messages.md](../reference/inter-agent/messages.md) | U11 |
| specs/protocol-inter-agent.md (Conversation owner and tie-breaker; Hard limits (config + mechanical enforcement); Memory-reclamation TTL (config, not a hard limit); Conversation lifecycle and post-close handling (issue #167); CID reuse is not a contract (issue #167 review S2)) | [reference/inter-agent/conversations.md](../reference/inter-agent/conversations.md) | U11 |
| specs/protocol-inter-agent.md (Explicitly supplied unknown conversation_id (issue #252)) | [reference/inter-agent/conversation-admission.md](../reference/inter-agent/conversation-admission.md) | U11 |
| specs/protocol-inter-agent.md (Dispatch-confirmation ledger; Negotiated gap recovery) | [reference/inter-agent/delivery.md](../reference/inter-agent/delivery.md) | U12 |
| specs/protocol-inter-agent.md (Receiver-side behavior; Coalescing contract; Synchronous reply wait) | [reference/inter-agent/send-and-wait.md](../reference/inter-agent/send-and-wait.md) | U12 |
| specs/protocol-inter-agent.md (Coalescing opening paragraph) | [architecture/inter-agent-messaging.md#dispatch-and-coalescing](../architecture/inter-agent-messaging.md#dispatch-and-coalescing) | U12; replaces v1 separate architecture/inter-agent-dispatch page |
| specs/protocol-inter-agent.md (monitoring rationale; Stall interpretation; provisional defaults; deliberate omissions) | [architecture/coordination-monitoring.md](../architecture/coordination-monitoring.md) | U13 |
| specs/protocol-inter-agent.md (Rally; Stall contract; Wire; Configuration; Observation path) | [reference/inter-agent/coordination-monitoring.md](../reference/inter-agent/coordination-monitoring.md) | U13 |

| specs/protocol-inter-agent.md (Channel events; Peer-directory boundary; list_agents / whoami) | [reference/inter-agent/directory.md](../reference/inter-agent/directory.md) | U14 |
| specs/protocol-inter-agent.md (send acceptance / rejection) | [reference/inter-agent/send-and-wait.md#send-acceptance-and-rejection](../reference/inter-agent/send-and-wait.md#send-acceptance-and-rejection) | U14 |
| specs/protocol-inter-agent.md (Destination-resolution guidance) | [contributing/peer-routing.md](../contributing/peer-routing.md) | U14 |
| specs/protocol-inter-agent.md (Unresponsive notices; Error codes; Sources; stale_turn notice structure; Server-synthesized rules; Receiver handling) | [reference/inter-agent/errors.md](../reference/inter-agent/errors.md) | U16 |
| specs/protocol-inter-agent.md (Session operation tool — request_compact; Threshold notice; request_session_reset) | [reference/inter-agent/session-tools.md](../reference/inter-agent/session-tools.md) | U17 |
| specs/protocol.md (Purpose; Design intent) | [architecture/message-topology.md](../architecture/message-topology.md) | U01 |
| specs/protocol.md (Terms and hierarchy; Envelope v0; ext.engine) | [reference/protocol/envelope.md](../reference/protocol/envelope.md) | U01 |
| specs/protocol.md (Types and payload (v0 settled); Wrapper-owned stderr error diagnostics) | [reference/protocol/events.md](../reference/protocol/events.md) | U01 |
| specs/protocol.md (Directional message types (v0 settled); Client transport) | [reference/protocol/channels.md](../reference/protocol/channels.md) | U01 |
| specs/protocol.md (Versioning policy; Version inventory — Client → server, Server → wrapper, Server → runner, Runner → server, Wrapper → server, Server → client, Permanent carve-out attach_chunk, Receiver validation, Non-map payload handling) | [reference/protocol/versioning.md](../reference/protocol/versioning.md) | U01 |
| specs/protocol.md (Two-axis `ext.permission` — introductory paragraph only) | [architecture/security-boundaries.md#permission-control-two-axis-model](../architecture/security-boundaries.md#permission-control-two-axis-model) | U02 (H2 section on the existing page, not a new architecture/permission-control.md — only 1 paragraph of design rationale after the field contract split out, per U12 precedent of not spinning up a page for 1-2 paragraphs) |
| specs/protocol.md (Two-axis `ext.permission` — field contract, per-engine stamping, Antigravity local-mode rules, deprecation; Requested, submitted, and effective state) | [reference/protocol/permission-state.md](../reference/protocol/permission-state.md) | U02 |
| specs/protocol.md (Permission changes at an execution boundary; Request, relay, and acknowledgement) | [reference/protocol/permission-requests.md](../reference/protocol/permission-requests.md) | U02 |
| specs/protocol.md (Persistence, join synchronization, and resume; Permission lifecycle audit) | [reference/protocol/permission-sync-audit.md](../reference/protocol/permission-sync-audit.md) | U02 |
| specs/protocol.md (`ext.model_source` / `ext.effort_source`; `ext.resume_snapshot` / `ext.effective` / `ext.resume_drift`; `ext.pending_model` / `ext.pending_effort` / `ext.switch_error` / `ext.effort_reset`) | [reference/protocol/model-effort.md](../reference/protocol/model-effort.md) | U03 |
| specs/protocol.md (`ext.session_capabilities`); specs/plugin-model.md (Session capability advertisement — field contract) | [reference/protocol/capabilities.md](../reference/protocol/capabilities.md) | U03 |
| specs/plugin-model.md (Session capability advertisement — introductory paragraph and Reason bullet only) | [architecture/extensions.md#session-capability-advertisement](../architecture/extensions.md#session-capability-advertisement) | U03 (H2 section on the existing page, not a new page — same U12-precedent deviation as U02's permission-control section; director approved) |
| specs/protocol.md (Planned wrapper cycle; Projection hydration and restart resilience; Session visibility semantics; Session resume and restoration — field contract; Identity and persona) | [reference/protocol/session-lifecycle.md](../reference/protocol/session-lifecycle.md) | U04 |
| specs/protocol.md (State-machine state set v0) | [reference/protocol/state-machine.md](../reference/protocol/state-machine.md) | U04 |
| specs/protocol.md (Rolling deploy paragraph from Planned wrapper cycle; Session resume and restoration's opening sentence) | [architecture/system-overview.md#session-ownership-and-continuity](../architecture/system-overview.md#session-ownership-and-continuity) | U04 (H2 section on the existing page, not a new architecture/session-ownership.md — same U02/U03-precedent deviation for a 2-paragraph design-rationale residue; director approved) |
| specs/file-upload.md (Purpose; Responsibilities; UI model; Constraints — client-normative-policy bullet) | [architecture/attachments.md](../architecture/attachments.md) | U07 |
| specs/protocol.md (File-upload wire); specs/file-upload.md (Terminology; Supported file types/MIME; Size/count/in-flight limits; Transfer wire; Reject path; Extended meaning of interrupt; TTL and fail-safe; Constraints — 5 wire bullets; Open Questions) | [reference/protocol/attachments.md](../reference/protocol/attachments.md) | U07 |
| specs/file-upload.md (Wrapper-internal rendering; Fit-to-SDK; Constraints — rendering bullet) | [reference/engines/attachment-rendering.md](../reference/engines/attachment-rendering.md) | U07 |
| specs/protocol.md (Runner control messages; Client → server launch control) | [reference/protocol/runner-control.md](../reference/protocol/runner-control.md) | U08 (architecture side none — the persona-as-type/agent_id-as-instance rationale in the launch-control intro stays whole in this page, linked to ADR-0024 D1, its authoritative source; director approved) |
| specs/protocol.md (WrapperConfig fields relayed by the runner) | [reference/configuration/wrapper.md](../reference/configuration/wrapper.md) | U08 |
| specs/protocol.md (`task_type: "tasklist"` addendum); specs/subagent-tasks.md (Source data; Dedicated envelope type `task`; Recipient: operator only; Concurrency and lifecycle; Constraints; See Also) | [reference/protocol/tasks.md](../reference/protocol/tasks.md) | U06 |
| specs/subagent-tasks.md (Purpose; Entity model; Implementation stages; Detecting child agents — Policy paragraph only) | [architecture/subagent-visibility.md](../architecture/subagent-visibility.md) | U06 |
| specs/subagent-tasks.md (Detecting child agents inside workflows — intro, Verification environment, Observed raw SDK messages, Conclusion) | [evidence/claude/subagent-workflow-detection.md](../evidence/claude/subagent-workflow-detection.md) | U06 (evidence layer, per director's ruling: measured ≠ implemented — the Policy paragraph that this measurement supports stays in architecture/subagent-visibility.md, one paragraph, not split further) |
| specs/protocol.md (Persona asset distribution; Personality prompt delivery); specs/persona-personality-injection.md (Data model; Prompt delivery (WS handshake); Constraints — 5 bullets; Open Questions; See Also) | [reference/protocol/persona-delivery.md](../reference/protocol/persona-delivery.md) | U09b |
| specs/persona-personality-injection.md (Purpose; Application model; Scope; Constraints — 2 SHOULD bullets) | [architecture/personality-injection.md](../architecture/personality-injection.md) | U09b |
| specs/persona-personality-injection.md (Injection into the SDK; Constraints — 1 bullet) | [reference/engines/personality-injection.md](../reference/engines/personality-injection.md) | U09b |
| specs/persona-personality-injection.md (Common footer; Changeable scope; Constraints — 4 bullets) | [reference/configuration/personality.md](../reference/configuration/personality.md) | U09b |
| specs/protocol-inter-agent.md (IA sidecar and display restoration — Recording, Session lifecycle, Restore, Relation to resume reconstruction) | [reference/storage/inter-agent-sidecar.md](../reference/storage/inter-agent-sidecar.md) | U05 (architecture side none — the opening design sentence stays whole in this page, linked to ADR-0051, its authoritative source; only a 1-line cross-link was added to architecture/inter-agent-messaging.md's existing Related-topics list; director approved) |
| specs/protocol-inter-agent.md (Projection hydration and restart resilience) | already in [reference/protocol/session-lifecycle.md](../reference/protocol/session-lifecycle.md) | U04 (no further move; director confirmed session-lifecycle.md remains its home) |
