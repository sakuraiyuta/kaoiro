---
title: Phase 34 — Antigravity adapter (third engine, agy CLI headless)
description: Implement ADR-0057 — wrapper/antigravity package driving the agy CLI per turn, hook-based permission gate with a wrapper-side two-axis policy (axes fixed at spawn in Stage A), CLI bridge for kaoiro tools, rules-file persona injection, catalog from `agy models`, and the protocol / runner / server / dashboard wiring for engine id `antigravity`.
status: planned
phase: 34
depends_on: [phase-14-codex-adapter, phase-33-compaction-resume-lifecycle]
last_updated: 2026-09-05
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
   reason. Gate fails closed on socket loss, wrapper deadline, and missing
   nonce (tests); a tool step without a preceding gate request kills the
   child and errors the session (test with the hook removed); the bridge
   auto-allow rejects every shell-injection fixture (tests).
5. Tools: `list_agents` / `send_to_agent` / `whoami` / `ask_user_question`
   work through the bridge; a pending question holds the turn.
6. (Stage B1) Rate limits from `-p /usage` appear in `list_agents` / whoami.
7. Release: tarball carries `@kaoiro/antigravity` with `runtimeAssets`
   (`dist/bridge.js`, `dist/hook.js`); `verify-release` sentinels updated.
8. Docs: spec promoted to `accepted` with Stage A live-verification notes;
   protocol.md / plugin-model.md engine tables updated; threat-model.md and
   auth-and-authz.md carry the new boundary (ADR-0057 F8).

## Tasks

### Stage 0 — go / no-go measurements and decisions

| # | Task | Outcome that closes it |
|---|---|---|
| 0.1 | ADR-0057 Q1 — done 2026-09-04 by the operator | per-process flag confirmed (`always-proceed`, hook fires); recorded in the spec |
| 0.2 | Q2: `--add-dir` workspace-root semantics — done 2026-09-04 | both `--add-dir <cwd>` and `<agent dir>` are passed (ADR-0057 F2) |
| 0.3 | Q3: env inheritance and hook-timeout behaviour — done 2026-09-04 | recorded in the spec; deadline ordering fixed in `host.ts` constants |
| 0.4 | Design review (kuroe) round 1 — done 2026-09-04 | every must-fix resolved or dispositioned in ADR-0057 |

### Stage A — adapter core

| # | Task | Notes |
|---|---|---|
| A1 | `protocol` `EngineKind` + `antigravity`; `approval` added beside `sandbox` on `SpawnRequest` / `SpawnMessage` / `ResolvedSnapshotExt`; `ext.permission.enforcement`; `pnpm-workspace.yaml`; `wrapper/package.json` fan-out; `runner/package.json` dep | ADR-0057 F1 + F4c |
| A2 | `wrapper/antigravity` skeleton copied from `wrapper/codex` (package.json with `kaoiro.runtimeAssets`, tsconfigs, vitest config, `src/index.ts`) | |
| A3 | `adapter.ts`: stream-json line → `AdapterEvent` (pure, table-driven) + tests from recorded fixtures | fixtures: the 2026-09-04 probe outputs |
| A4 | `host.ts`: per-turn spawn, closed stdin, `--conversation`, interrupt (SIGTERM), exit-without-result → error, session_capabilities stamp | reuse Codex `TurnWatchdog` |
| A5 | customization dir writer: `.agents/rules/AGENTS.md`, `.agents/hooks.json`, `.agents/skills/kaoiro/SKILL.md`; regenerate before every spawn, SHA verify after every turn (tamper → error); stale sweep deletes only dirs carrying a valid owner marker; cleanup on close | |
| A6 | `hook.ts` (→ `dist/hook.js`): stdin → wrapper socket `permission` request (with per-spawn nonce) → stdout decision; fail-closed with client deadline | |
| A6b | gate self-verification (F4b): `-p /hooks` registration check before first turn; completion-keyed tool-step ↔ gate-request correlation invariant (measured classes only) with kill + `antigravity_gate_unobserved_tool` on violation; gate-socket close resolves the broker entry; tests inject a missing hook and a missing nonce as negative controls | |
| A7 | `gate.ts`: tool-class table (spec SoT) + `init.tools` diff, F4 cell table incl. `network_access`, customization-dir and `Cwd` denies, bridge whole-string match (F5) with injection tests (`;`, `&&`, `|`, `$(…)`, newline, extra argv, non-base64 payload); `PermissionBroker` wiring; `setPermissionMode` rejects (F4c) | |
| A8 | `bridge.ts` CLI (`list` / `call`) over `ToolHost`; `ask_user_question` blocking semantics; `inter_agent` descriptors | |
| A9 | `catalog.ts` static 1.1.26 snapshot + account-default entry (F6) + runner `agy models` probe; `KAOIRO_ANTIGRAVITY_DEFAULT_MODEL`; source resolution | |
| A10 | runner: `ENGINE_PACKAGES`, `BUNDLED_ENGINES`, `buildRegister` branch, `supervisor` validation + `approval` relay, `P0_FIELDS_BY_ENGINE` (`sandbox`, `approval`, `networkAccess`), `sessions.ts` enumeration, `setup.ts` choices | |
| A11 | server: `@engine_values`, `wrapper_channel` engine guard, tests | |
| A12 | dashboard: sandbox × approval × network knobs for `antigravity` (approval selectable at spawn); AgentDetail permission panel with the advisory-sandbox badge; account-default catalog entry | |
| A13 | scripts / release: `dev.sh`, `dogfood.sh`, `build-release-manifest.mjs`, `verify-release.mjs`, `runtimeAssetDeclarations` / `releaseFixture` tests | |
| A14 | threat-model.md / auth-and-authz.md (and deployment.md if Q1 falls back) per ADR-0057 F8 | |
| A15 | dogfood on the dev host with two personas; promote spec to accepted; ADR-0057 status → accepted | |

### Stage B — parity extras

| # | Task |
|---|---|
| B0 | two-axis mid-session control message + dashboard controls (ADR-0057 F4c) |
| B1 | `-p /usage` rate-limit probe per turn boundary → `rate_limits` |
| B2 | history replay from `transcript_full.jsonl` (format measurement first) |
| B3 | session enumeration metadata from `conversation_summaries.db` |
| B4 | setup wizard: `agy` presence check; runner reports `agy --version` and re-runs the gate registration check on a version change |
| B5 | context usage (per-model window table) — only if a source of truth exists |
| B6 | `antigravity.extra_models` (issue #292 part A for this engine, reusing the codex helpers) — **done in #292** |
| B7 | server test for an antigravity spawn with the `approval` key entirely absent (review advisory) |

## Open Questions Blocking This Phase

- None — Stage 0 is closed.

## See Also

- [ADR-0057](../adr/0057-antigravity-adapter.md)
- [antigravity-cli-events](../specs/antigravity-cli-events.md)
- [phase-14-codex-adapter](phase-14-codex-adapter.md) (template phase)
