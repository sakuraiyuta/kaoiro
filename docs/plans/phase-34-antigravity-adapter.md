---
title: Phase 34 — Antigravity adapter (third engine, agy CLI headless)
description: Implement ADR-0057 — wrapper/antigravity package driving the agy CLI per turn, hook-based permission gate with mid-session two-axis policy, CLI bridge for kaoiro tools, rules-file persona injection, catalog from `agy models`, and the protocol / runner / server / dashboard wiring for engine id `antigravity`.
status: planned
phase: 34
depends_on: [phase-14-codex-adapter, phase-33-compaction-resume-lifecycle]
last_updated: 2026-09-04
---

# Phase 34 — Antigravity adapter (third engine, agy CLI headless)

## Goal

Implement [ADR-0057](../adr/0057-antigravity-adapter.md) F1–F7 so that an
`antigravity` agent can be launched from LaunchDialog, shows the same state
granularity as the other engines, carries its persona, answers operator
permission requests, and uses `send_to_agent` / `ask_user_question`
through the CLI bridge. Measured substrate:
[antigravity-cli-events](../specs/antigravity-cli-events.md).

## Acceptance Criteria

1. Host with `antigravity` in capabilities lists the engine in LaunchDialog
   with the `agy models` catalog; spawn / resume / interrupt / close work
   end to end (issue #181 criterion 1).
2. State: `thinking` / `tool_running(tool_name)` / `waiting_permission` /
   `waiting_input` / `done` / `error` derive from the stream-json events per
   the spec table; `ext.engine = "antigravity"`, `ext.model_source` stamped.
3. Persona: the rules file carries personality + footer; tone verified on
   two personas (same check as ADR-0032 F3, 2026-07-11).
4. Permission: with default axes a `run_command` produces a
   `waiting_permission` round trip; deny is visible to the model as the hook
   reason; `setPermissionMode` changes take effect on the next tool call.
   Gate fails closed on socket loss (test) and on wrapper deadline (test).
5. Tools: `list_agents` / `send_to_agent` / `whoami` / `ask_user_question`
   work through the bridge; a pending question holds the turn.
6. Rate limits from `-p /usage` appear in `list_agents` / whoami.
7. Release: tarball carries `@kaoiro/antigravity` with `runtimeAssets`
   (`dist/bridge.js`, `dist/hook.js`); `verify-release` sentinels updated.
8. Docs: spec promoted to `accepted` with Stage A live-verification notes;
   protocol.md / plugin-model.md engine tables updated.

## Tasks

### Stage 0 — decisions (HITL)

| # | Task | Owner |
|---|---|---|
| 0.1 | ADR-0057 Q1: run the `--dangerously-skip-permissions` + gate hook probe on the host; record `init.permission_mode` and the hook deny result in the spec | operator |
| 0.2 | Design review of ADR-0057 / spec (kuroe) | kuroe |

### Stage A — adapter core

| # | Task | Notes |
|---|---|---|
| A1 | `protocol` `EngineKind` + `antigravity`; `pnpm-workspace.yaml`; `wrapper/package.json` fan-out; `runner/package.json` dep | wiring map in ADR-0057 F1 |
| A2 | `wrapper/antigravity` skeleton copied from `wrapper/codex` (package.json with `kaoiro.runtimeAssets`, tsconfigs, vitest config, `src/index.ts`) | |
| A3 | `adapter.ts`: stream-json line → `AdapterEvent` (pure, table-driven) + tests from recorded fixtures | fixtures: the 2026-09-04 probe outputs |
| A4 | `host.ts`: per-turn spawn, closed stdin, `--conversation`, interrupt (SIGTERM), exit-without-result → error, session_capabilities stamp | reuse Codex `TurnWatchdog` |
| A5 | customization dir writer: `.agents/rules/AGENTS.md`, `.agents/hooks.json`, `.agents/skills/kaoiro/SKILL.md`; regenerate on persona/display-name sync; cleanup on close | |
| A6 | `hook.ts` (→ `dist/hook.js`): stdin → wrapper socket `permission` request → stdout decision; fail-closed; Q3 measurements (timeout bound, env inheritance) recorded in the spec | |
| A7 | permission policy in the wrapper: ADR-0057 F4 table; `PermissionBroker` wiring; `setPermissionMode` mutable; unit tests per cell of the table | |
| A8 | `bridge.ts` CLI (`list` / `call`) over `ToolHost`; `ask_user_question` blocking semantics; `inter_agent` descriptors | |
| A9 | `catalog.ts` static 1.1.8 snapshot + runner `agy models` probe; `KAOIRO_ANTIGRAVITY_DEFAULT_MODEL`; source resolution | |
| A10 | runner: `ENGINE_PACKAGES`, `BUNDLED_ENGINES`, `buildRegister` branch, `supervisor` validation, `P0_FIELDS_BY_ENGINE` (`sandbox`, `approval`), `sessions.ts` enumeration, `setup.ts` choices | |
| A11 | server: `@engine_values`, `wrapper_channel` engine guard, tests | |
| A12 | dashboard: sandbox × approval knobs shown for `antigravity` (approval selectable, unlike Codex); AgentDetail permission panel | |
| A13 | scripts / release: `dev.sh`, `dogfood.sh`, `build-release-manifest.mjs`, `verify-release.mjs`, `runtimeAssetDeclarations` / `releaseFixture` tests | |
| A14 | dogfood on the dev host with two personas; promote spec to accepted; ADR-0057 status → accepted | |

### Stage B — parity extras

| # | Task |
|---|---|
| B1 | `-p /usage` rate-limit probe per turn boundary → `rate_limits` |
| B2 | history replay from `transcript_full.jsonl` (format measurement first) |
| B3 | session enumeration metadata from `conversation_summaries.db` |
| B4 | setup wizard: `agy` presence / version check; Q1 fallback writes `toolPermission` when chosen |
| B5 | context usage (per-model window table) — only if a source of truth exists |

## Open Questions Blocking This Phase

- ADR-0057 Q1 (Stage 0.1) blocks merging Stage A.
- ADR-0057 Q2 / Q3 are measured inside Stage A (A5 / A6) and may change the
  rules text or the gate.

## See Also

- [ADR-0057](../adr/0057-antigravity-adapter.md)
- [antigravity-cli-events](../specs/antigravity-cli-events.md)
- [phase-14-codex-adapter](phase-14-codex-adapter.md) (template phase)
