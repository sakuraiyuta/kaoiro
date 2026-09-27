# Evidence

Dated measurements and their limits, one topic per subdirectory. Each file is
a frozen record of what was measured on a given date — do not edit a past
entry; add a new dated file for a new measurement instead.

## antigravity/

Antigravity (`agy` CLI) adapter measurements.

- [cli-contract.md](antigravity/cli-contract.md) — customization and headless-MCP observations for the Antigravity CLI adapter
- [conversation-summaries-schema.md](antigravity/conversation-summaries-schema.md) — `agy` 1.2.11 session-metadata schema and synthetic SQLite read behavior
- [gate-tool-observations.md](antigravity/gate-tool-observations.md) — gate tool-step correlation observations
- [print-mode-background-tasks.md](antigravity/print-mode-background-tasks.md) — `agy --print` background-task promotion/loss behavior (issue #377)

## claude/

Claude Agent SDK adapter measurements.

- [issue-401/postchange-2026-09-26.md](claude/issue-401/postchange-2026-09-26.md) — post-change wrapper-build verification run for issue #401
- [sdk-boundaries-2026.md](claude/sdk-boundaries-2026.md) — Claude SDK notification and permission boundary observations
- [subagent-workflow-detection.md](claude/subagent-workflow-detection.md) — whether a workflow-spawned child agent surfaces as its own task event

## codex/

Codex exec-mode SDK measurements (pre-app-server transport).

- [exec-contract.md](codex/exec-contract.md) — exec SDK event contract and state-derivation verification
- [model-catalog.md](codex/model-catalog.md) — Codex model-catalog plan/auth/doctor observations

## codex-app-server/

Codex app-server transport migration (ADR-0058) — historical excerpts, one file per increment area.

- [backend-rollback-artifact.md](codex-app-server/backend-rollback-artifact.md) — Stage 1 increment 6, packaged rollback artifact
- [host-composition.md](codex-app-server/host-composition.md) — Host composition increments
- [projection-and-history.md](codex-app-server/projection-and-history.md) — Projection/history increments
- [session-and-bridge.md](codex-app-server/session-and-bridge.md) — Session/bridge increments
- [settings-and-permission.md](codex-app-server/settings-and-permission.md) — Settings/permission increments
- [stage1-compatibility.md](codex-app-server/stage1-compatibility.md) — Stage 1 compatibility gate, 2026-09-18
- [transport-spikes-2026-09-14.md](codex-app-server/transport-spikes-2026-09-14.md) — Transport spikes, 2026-09-14

## deployment/

Runner/server deployment measurements.

- [runner-service-isolation.md](deployment/runner-service-isolation.md) — cgroup isolation between a `systemd-run --no-block` caller and its detached worker unit
- [runner-user-systemd-linger.md](deployment/runner-user-systemd-linger.md) — user-systemd instance restart behavior without `loginctl enable-linger`

## issue-407/

Inter-agent message-crossing investigation (issue #407), oldest first.

- [2026-09-26-call-provenance.md](issue-407/2026-09-26-call-provenance.md) — tool-call provenance at engine ingress (round 4)
- [2026-09-26-cross-turn.md](issue-407/2026-09-26-cross-turn.md) — delayed inter-agent calls across SDK turn boundaries (round 6)
- [2026-09-26-implementation.md](issue-407/2026-09-26-implementation.md) — implementation-candidate content-bound checks
- [2026-09-26-interrupt-comparison.md](issue-407/2026-09-26-interrupt-comparison.md) — reply-binding vs. interruption option comparison (joint review)
- [2026-09-26-round8.md](issue-407/2026-09-26-round8.md) — round-8 reconnect and adapter regression checks
- [2026-09-26-round9.md](issue-407/2026-09-26-round9.md) — round-9 channel-lifecycle verification

## issue-408/

Pre-turn account rate-limit snapshots (issue #408).

- [2026-09-26-pre-turn-rate-limits.md](issue-408/2026-09-26-pre-turn-rate-limits.md) — initial probe of per-turn rate-limit snapshot availability

## issue-422/

Claude background-task notification-lifecycle investigation (issue #422), oldest first.

- [2026-09-27-notification-turn.md](issue-422/2026-09-27-notification-turn.md) — original background-notification reply-origin reproduction
- [2026-09-27-prompt-boundary.md](issue-422/2026-09-27-prompt-boundary.md) — SDK 0.3.280 hook observations for option A
- [2026-09-27-notification-admission.md](issue-422/2026-09-27-notification-admission.md) — Claude notification-admission verification (superseded by round 2)
- [2026-09-27-notification-admission-round2.md](issue-422/2026-09-27-notification-admission-round2.md) — correction and artifact for round 1
- [2026-09-27-notification-admission-round3.md](issue-422/2026-09-27-notification-admission-round3.md) — artifact and decision
- [2026-09-27-notification-admission-round3-native.md](issue-422/2026-09-27-notification-admission-round3-native.md) — native-gate artifact and scope, supersedes round 3's test-only inference
- [2026-09-27-notification-admission-round4.md](issue-422/2026-09-27-notification-admission-round4.md) — measurement contract before implementation
- [2026-09-27-implementation-gate.md](issue-422/2026-09-27-implementation-gate.md) — implementation-gate result: the uncommitted option-A candidate did not pass
