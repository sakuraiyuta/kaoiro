# Plans

Proceed through the phases in order (do not skip them). The Status column maps
each plan's frontmatter `status` to a legend symbol; even when `done`, use 🟡
when follow-ups have been spun out into issues.

| Phase | File | Status | Description |
|-------|------|--------|------|
| 0 | [phase-0-project-setup](phase-0-project-setup.md) | ✅ | Project planning and repository setup |
| 1 | [phase-1-wrapper-state-machine](phase-1-wrapper-state-machine.md) | 🟡 | One wrapper + state machine. Only live-drive verification (1-5) of `waiting_permission` remains incomplete |
| 1.5 | [phase-1.5-minimal-server-client](phase-1.5-minimal-server-client.md) | ✅ | Minimal server + minimal client (vertical slice) |
| 2 | [phase-2-client-character](phase-2-client-character.md) | ✅ | Client + character + expressions |
| 3 | [phase-3-server-multiagent](phase-3-server-multiagent.md) | ✅ | Server aggregation + multiple agents + bidirectional communication |
| 3.5 | [phase-3.5-response-display](phase-3.5-response-display.md) | 🟡 | Response display (making the bundled dashboard practical). Stage polish (R-5–R-7, [issue #21](https://github.com/sakuraiyuta/kaoiro/issues/21)) remains |
| 3.6 | [phase-3.6-dashboard-separation](phase-3.6-dashboard-separation.md) | ✅ | Separate dashboard directory + bundled cleanup |
| 4 | [phase-4-host-runner](phase-4-host-runner.md) | ✅ | Host-resident runner (spawn/supervision/host registration, [ADR-0023](../adr/0023-host-runner-architecture.md)). Distribution (4-7) was completed as a self-contained Node-based tarball after withdrawing the single-binary approach ([ADR-0018](../adr/0018-runner-distribution.md) revision). Automating asset uploads to releases is [#140](https://github.com/sakuraiyuta/kaoiro/issues/140) |
| 5 | [phase-5-i18n](phase-5-i18n.md) | ⏳ | Pre-beta English translation process |
| 6 | [phase-6-emotion-filter](phase-6-emotion-filter.md) | ⏳ | Emotion filter (flavoring). Shelved for the time being (decision by マスター on 2026-08-02) |
| 7 | [phase-7-file-upload](phase-7-file-upload.md) | ✅ | File upload (attachment ingestion, [ADR-0025](../adr/0025-file-upload-wire-and-wrapper-rendering.md)) |
| 8 | [phase-8-inter-agent-messaging](phase-8-inter-agent-messaging.md) | ✅ | Inter-agent messaging (coordinated conversation among multiple AI agents, [issue #17](https://github.com/sakuraiyuta/kaoiro/issues/17) closed). Stage C remains / Stage D is carried forward to [ADR-0044](../adr/0044-coordination-injection-hitl.md), [#87](https://github.com/sakuraiyuta/kaoiro/issues/87), and [#18](https://github.com/sakuraiyuta/kaoiro/issues/18) (closed on 2026-08-02) |
| 9 | [phase-9-external-human-messaging](phase-9-external-human-messaging.md) | ⏳ | External-human messaging (Discord, bidirectional transport / one-way authority, [ADR-0028](../adr/0028-external-human-messaging.md)) |
| 10 | [phase-10-persona-server-sot](phase-10-persona-server-sot.md) | ✅ | Server-aggregated persona SoT + zip-pack distribution, [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md) |
| 11 | [phase-11-agent-directory-and-restore](phase-11-agent-directory-and-restore.md) | ✅ | Persistent agent identity across server restarts and explicit client restore (bulk/individual), [ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md), [issue #41](https://github.com/sakuraiyuta/kaoiro/issues/41) |
| 12 | [phase-12-runner-persona-trust-mode](phase-12-runner-persona-trust-mode.md) | ✅ | Choose the runner's persona acceptance policy between allowlist / blocklist modes (unset defaults to accept-all), [ADR-0031](../adr/0031-runner-persona-trust-mode.md) |
| 13 | [phase-13-wrapper-multipackage-restructure](phase-13-wrapper-multipackage-restructure.md) | ✅ | Materialize the wrapper's multi-package structure (`core` + `agent-common` + `claude-code` + `codex`, 4 packages), [ADR-0017](../adr/0017-wrapper-multientity-packages.md) / [ADR-0032](../adr/0032-codex-adapter.md) F1 |
| 14 | [phase-14-codex-adapter](phase-14-codex-adapter.md) | ✅ | Codex adapter implementation (F2-F9, two-axis permission UI, engine selector, moving inter-agent tools to the common Tool description layer), [ADR-0032](../adr/0032-codex-adapter.md) / [ADR-0033](../adr/0033-permission-model-dual-axis.md) |
| 15 | [phase-15-wrapper-ux-parity](phase-15-wrapper-ux-parity.md) | ✅ | Resolve Claude / Codex UX asymmetry (symmetrical model resolution path and `ext.model_source`, two-axis permission UI, session capabilities, resume-difference detection), [ADR-0034](../adr/0034-session-capabilities-advertisement.md) |
| 16 | [phase-16-codex-model-switch](phase-16-codex-model-switch.md) | ✅ | Mid-session Codex model/effort switch while keeping the session alive (3 stages: pending → effective → rollback), [ADR-0035](../adr/0035-codex-model-catalog-and-mid-session-switch.md) |
| 17 | [phase-17-session-lifecycle-commands](phase-17-session-lifecycle-commands.md) | ✅ | Treat `/new` and `/clear` as first-class session lifecycle commands (four-stage request_id correlation + session_boundary marker), [ADR-0036](../adr/0036-session-lifecycle-commands.md) |
| 18 | [phase-18-claude-model-catalog-live](phase-18-claude-model-catalog-live.md) | ✅ | Unify the Claude model catalog through SDK measurements and reduce the launch-bootstrap default floor, [ADR-0037](../adr/0037-claude-model-catalog-live-refresh.md) |
| 19 | [phase-19-codex-internal-subagents-toggle](phase-19-codex-internal-subagents-toggle.md) | ✅ | Codex internal sub-agent toggle and named-peer routing contract, [ADR-0038](../adr/0038-codex-internal-subagents-toggle.md) |
| 20 | [phase-20-engine-catalog-live-probe](phase-20-engine-catalog-live-probe.md) | ✅ | Make the LaunchDialog model catalog live with a short-lived SDK probe + runner memory cache (Option E), [ADR-0039](../adr/0039-engine-catalog-live-probe.md) |
| 21 | [phase-21-context-usage-capability](phase-21-context-usage-capability.md) | ✅ | Make context-usage display capability-driven and withdraw estimated projection on the Codex side, [ADR-0040](../adr/0040-context-usage-capability.md) |
| 22 | [phase-22-resume-privilege-restoration](phase-22-resume-privilege-restoration.md) | ✅ | Reapply the three privilege axes (sandbox / network_access / permission_mode) on resume (P0), [ADR-0014](../adr/0014-session-resume-and-restore.md) F1 addendum |
| 23 | [phase-23-resume-model-effort-restoration](phase-23-resume-model-effort-restoration.md) | 🟡 | Reapply model / effort / `*_source` on resume (P1). Dogfood manual verification (23-9) awaits the master's live confirmation |
| 24 | [phase-24-codex-auth-mode-explicit](phase-24-codex-auth-mode-explicit.md) | 🟡 | Explicitly declare the Codex auth mode in runner config. Dogfood manual verification (24-7) awaits the master's live confirmation |
| 25 | [phase-25-fresh-restore-without-session](phase-25-fresh-restore-without-session.md) | ✅ | Fresh-restore of an offline agent without a session_id using only the snapshot, [ADR-0030](../adr/0030-agent-directory-and-explicit-restore.md) D8 addendum |
| 26 | [phase-26-oauth-allowlist-login](phase-26-oauth-allowlist-login.md) | 🟡 | Dashboard OAuth login (Google/GitHub/Nextcloud) + text allowlist; token authentication coexists only when KAOIRO_CLIENT_TOKENS is configured, [ADR-0042](../adr/0042-oauth-allowlist-login.md) / [issue #65](https://github.com/sakuraiyuta/kaoiro/issues/65). Implementation tasks 26-1–26-12 are complete and pushed; remaining are provider registration and live E2E by the master. The allowlist role downgrade not affecting active sockets is [#148](https://github.com/sakuraiyuta/kaoiro/issues/148) |
| 27 | [phase-27-list-agents-metadata](phase-27-list-agents-metadata.md) | ✅ | Add 6 operational-status fields to `list_agents` (remaining context / session start / turn count / last activity / IA conversation status / rate_limits), [issue #150](https://github.com/sakuraiyuta/kaoiro/issues/150) / [ADR-0021](../adr/0021-role-information-disclosure-policy.md) F6 (inter-agent disclosure) |
| 28 | [phase-28-agent-initiated-session-ops](phase-28-agent-initiated-session-ops.md) | ✅ | Self-awareness of context fatigue and session reset / compact requested by the agent at the turn boundary, [ADR-0043](../adr/0043-agent-initiated-session-reset.md) / [issue #158](https://github.com/sakuraiyuta/kaoiro/issues/158) |
| 29 | [P29](phase-29-footer-and-persona-cache.md) | 🟡 | footer / cache |
| | | | Implementation complete, under review (ADR-0045 / ADR-0046) |
| 30 | [phase-30-history-restart-resilience](phase-30-history-restart-resilience.md) | ✅ | Restart-resilient display history — DETS removal through hydration handshake and IA sidecar, projection-epoch resynchronization, [ADR-0051](../adr/0051-history-restart-resilience.md) (accepted; rollout and dogfood completed 2026-08-08) |
| 31 | [phase-31-responsive-ui](phase-31-responsive-ui.md) | ⏳ | Equal three-size responsive dashboard — breakpoint and sheet-mechanism foundation, lobby / AgentDetail / surrounding UI, [ADR-0052](../adr/0052-responsive-three-tier-layout.md) |
| 32 | [phase-32-subagent-workflow-visibility](phase-32-subagent-workflow-visibility.md) | 🟡 | Visualize internal sub-agent/workflow activity — wrapper detection, server aggregation (operator-only), dashboard ring above the agent, [ADR-0019](../adr/0019-subagent-workflow-entity-and-task-envelope.md) / [ADR-0047](../adr/0047-task-envelope-schema.md) / [ADR-0048](../adr/0048-task-aggregation-delivery.md) |
| | | | Implementation complete, under internal review (awaiting こはく confirmation, external review, and commit/push) |
| 33 | [phase-33-compaction-resume-lifecycle](phase-33-compaction-resume-lifecycle.md) | 🟡 | Automatic resume after compaction (wrapper-local `resume_prompt`) and a server-retained `session_lifecycle` timeline with an operator pull query, [ADR-0055](../adr/0055-compaction-resume-and-lifecycle-log.md). Live verification of automatic resume on an actual `compact_boundary` awaits the master's confirmation |
| 34 | [phase-34-antigravity-adapter](phase-34-antigravity-adapter.md) | ⏳ | Third engine `antigravity` driving the `agy` CLI headless per turn — hook-based permission gate with mid-session two-axis policy, CLI bridge for kaoiro tools, rules-file persona injection, [ADR-0057](../adr/0057-antigravity-adapter.md). Stage 0 HITL (Q1 permission substrate) pending |

## Feature-local plans

Feature-local plans without a roadmap number. They contain the target feature's
phase-0 / phase-1 as sections within the plan (independent of the project's
phase-N).

None are currently registered (the former `persona-personality-injection` was
superseded by [ADR-0029](../adr/0029-persona-server-sot-and-pack-distribution.md)
and subsequently carried forward to
[phase-10-persona-server-sot](phase-10-persona-server-sot.md)).

## Future

(Formerly: "adapter extensions (Codex, etc.)" and "structuring the wrapper
into multi-entity packages" were approved to start as phase-13 / phase-14 on
2026-07-10. See [ADR-0032](../adr/0032-codex-adapter.md). "wrapper/runner
distribution" was settled as a tarball under phase-4's 4-7.)

## Status legend

- ✅ done
- 🟡 mostly done, followups remaining
- ⚠ partial — important spec items missing
- ⏳ not started
- ⛔ blocked
