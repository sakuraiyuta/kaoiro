# docs

kaoiro documentation. Each subfolder has a README index.

| Folder | Content |
|--------|------|
| [specs/](specs/) | Feature specifications (by topic) |
| [plans/](plans/) | Phase-based implementation plans and status |
| [open-questions/](open-questions/) | Unresolved issues |
| [adr/](adr/) | Architecture decision records |

## What to read first

1. [specs/overview.md](specs/overview.md) — What kaoiro is
2. [plans/README.md](plans/README.md) — Current phases and remaining work
3. [open-questions/README.md](open-questions/README.md) — Items requiring decisions

## ADR Index

<!-- adr-index:start -->
| # | Title | Status |
|---|-------|--------|
| [0001](adr/0001-agent-sdk-integration.md) | Adopt Claude Agent SDK as the integration approach | accepted |
| [0002](adr/0002-local-wrapper-websocket-topology.md) | The wrapper runs locally, with WebSocket connecting to the central server | accepted |
| [0003](adr/0003-persona-identity-persistence.md) | Persona identity persistence | accepted |
| [0004](adr/0004-client-rendering-staged.md) | Rendering starts with static variants; animation/3D selectable in the future | accepted |
| [0005](adr/0005-access-control-oauth-stub.md) | Access control is OAuth + RBAC; the prototype is a stub | accepted |
| [0006](adr/0006-doc-language-i18n.md) | Documentation/UI is Japanese; full English translation before beta | accepted |
| [0007](adr/0007-client-separation-reference-dashboard.md) | Client separated as a separate project; reference dashboard included | accepted |
| [0008](adr/0008-persona-asset-distribution.md) | Server-managed persona assets; manifest + content-addressed delivery | superseded |
| [0009](adr/0009-client-transport.md) | Client connections unified on Phoenix Channels | accepted |
| [0010](adr/0010-protocol-precisification.md) | Finalize only empirically verified envelope type/payload; reserve the rest as names | accepted |
| [0011](adr/0011-phase3-reliability-and-auth.md) | Phase 3 reliability and authentication policy (seq / permission correlation / tokens) | accepted |
| [0012](adr/0012-response-display-and-dashboard-scope.md) | Revised response display and included dashboard scope | accepted |
| [0013](adr/0013-user-token-cookie-persistence.md) | Persist the user token in an httpOnly cookie (reload resilience) | accepted |
| [0014](adr/0014-session-resume-and-restore.md) | Wrapper recovery and existing-session summoning through session resume | accepted |
| [0015](adr/0015-protocol-version-stamping.md) | Add version to all communication and warn on mismatch (best-effort acceptance) | accepted |
| [0016](adr/0016-error-body-relay.md) | Relay the wrapper error body to the client (result.error_message) | accepted |
| [0017](adr/0017-wrapper-multientity-packages.md) | Wrapper multi-entity package structure (three-layer pnpm workspace) | accepted |
| [0018](adr/0018-runner-distribution.md) | Distribution of wrapper/runner (OS-specific single binary, CLI only, Gitea release) | accepted |
| [0019](adr/0019-subagent-workflow-entity-and-task-envelope.md) | Treat subagent/workflow as child entities with a dedicated envelope type | accepted |
| [0020](adr/0020-dashboard-battery-included-client.md) | Elevate the bundled dashboard into a battery-included minimum practical client (allow additions to the new protocol surface) | accepted |
| [0021](adr/0021-role-information-disclosure-policy.md) | Information disclosure policy for viewer / operator roles — allow-list approach and per-envelope matrix | accepted |
| [0022](adr/0022-pending-permission-authoritative-source.md) | Make state_change.ext the authoritative source for pending_permission — demote the permission_request envelope to an initial notification | accepted |
| [0023](adr/0023-host-runner-architecture.md) | Host-resident runner — supervisor only, 1 process = 1 agent, TypeScript/Node single binary | accepted |
| [0024](adr/0024-agent-instance-identity-and-spawn-auth.md) | Agent instance identity and spawn authentication — persona = type / agent_id = instance, runner-unified issuance-based authentication | accepted |
| [0025](adr/0025-file-upload-wire-and-wrapper-rendering.md) | File-upload wire and wrapper-internal rendering | accepted |
| [0026](adr/0026-persona-personality-injection.md) | Persona prompt injection — SDK systemPrompt.append + wrapper-bundled md | superseded |
| [0027](adr/0027-askuserquestion-envelope.md) | Add dedicated envelopes (question_request / question_response) and waiting_question state for AskUserQuestion | accepted |
| [0028](adr/0028-external-human-messaging.md) | External human messaging — make humans participants in an external channel, one-way authority, discord-wrapper topology | accepted |
| [0029](adr/0029-persona-server-sot-and-pack-distribution.md) | Server-aggregated persona SoT, distributed as zip packs and applied with auto-watch | accepted |
| [0030](adr/0030-agent-directory-and-explicit-restore.md) | Persistent agent identity across server restarts and explicit client restore (bulk/individual) | accepted |
| [0031](adr/0031-runner-persona-trust-mode.md) | Choose between two runner persona acceptance modes: allowlist or blacklist | accepted |
| [0032](adr/0032-codex-adapter.md) | Adding a Codex adapter and materialising a multi-package wrapper structure | accepted |
| [0033](adr/0033-permission-model-dual-axis.md) | Extend the common permission-model abstraction to two axes: sandbox × approval | accepted |
| [0034](adr/0034-session-capabilities-advertisement.md) | Envelope advertisement of session capabilities | accepted |
| [0035](adr/0035-codex-model-catalog-and-mid-session-switch.md) | Restore the Codex model catalog and define the mid-session switch contract | accepted |
| [0036](adr/0036-session-lifecycle-commands.md) | Treat /new and /clear as first-class session lifecycle commands | accepted |
| [0037](adr/0037-claude-model-catalog-live-refresh.md) | Unify the Claude model-catalog live path through SDK measurement and reduce the launch-bootstrap default floor | accepted |
| [0038](adr/0038-codex-internal-subagents-toggle.md) | Runner toggle for Codex internal sub-agents and the named-peer routing contract | accepted |
| [0039](adr/0039-engine-catalog-live-probe.md) | Make the LaunchDialog model catalog live with a short-lived SDK probe + runner memory cache (Option E) | accepted |
| [0040](adr/0040-context-usage-capability.md) | Make context-window usage display capability-driven without projecting estimated Codex usage | accepted |
| [0041](adr/0041-operator-measurement-schema.md) | Measurement schema for operator permission latency and dashboard display conditions | proposed |
| [0042](adr/0042-oauth-allowlist-login.md) | Dashboard OAuth individual authentication (Google/GitHub/Nextcloud) + allowlist | accepted |
| [0043](adr/0043-agent-initiated-session-reset.md) | Session reset requested by the agent itself at a turn boundary | accepted |
| [0044](adr/0044-coordination-injection-hitl.md) | Automatic injection of a common coordination-guideline footer and autonomy within assigned responsibilities under an ad hoc director | accepted |
| [0045](adr/0045-footer-file-externalization.md) | Externalizing the common footer — system-footer.md and user-footer.md | accepted |
| [0046](adr/0046-persona-cache-relocation.md) | Externalize the extraction cache from the persona ingestion directory | accepted |
| [0047](adr/0047-task-envelope-schema.md) | Formal name and payload schema for the task envelope | accepted |
| [0048](adr/0048-task-aggregation-delivery.md) | Server aggregation, progress throttling, and snapshots for tasks | accepted |
| [0049](adr/0049-tasklist-on-task-envelope.md) | Carrying Tasklist (todo) on the task envelope | accepted |
| [0050](adr/0050-principal-model-and-graded-access-control.md) | Principal model — separate user/agent types, three role levels, and additive per-pair permissions | accepted |
| [0051](adr/0051-history-restart-resilience.md) | Restart-resilient display history — reconnect replay, IA sidecar, and epoch replacement | accepted |
| [0052](adr/0052-responsive-three-tier-layout.md) | Convert the dashboard to an equal three-size responsive layout | accepted |
| [0053](adr/0053-build-identity.md) | Introduce build identity and separate it from the protocol version | accepted |
| [0054](adr/0054-fatigue-as-orthogonal-persona-modifier.md) | Treat fatigue as a persona modifier separate from protocol state | accepted |
| [0055](adr/0055-compaction-resume-and-lifecycle-log.md) | Automatic resume after compaction and retaining a session-lifecycle timeline | accepted |
| [0056](adr/0056-project-calver-build-version.md) | Adopt one lockstep CalVer project version and explicit build channels | accepted |
<!-- adr-index:end -->

Regenerate: `scripts/build-adr-index.sh docs` (skill `my-docs-restructure`). Do not edit inside the markers manually.

## Update flow

- Specification change → edit `specs/<slug>.md` and update `status`
- Specification ambiguity → add `open-questions/<slug>.md`
- Important decision → create `adr/NNNN-<slug>.md` and update the referenced spec
- Phase progress → update the table in `plans/phase-N-<slug>.md`
