---
title: Phase 20 — LaunchDialog Engine Catalog Live Probe (Option E)
description: Make the LaunchDialog Claude model catalog live through a short-lived SDK probe and runner memory cache. Split the probe CLI into wrapper/claude-code, while runner handles cache/dedup/TTL/orchestration and server remains a thin relay.
status: done
phase: 20
depends_on: [18]
last_updated: 2026-07-15
---

# Phase 20 — LaunchDialog Engine Catalog Live Probe (Option E)

## Goal

Implement [ADR-0039](../adr/0039-engine-catalog-live-probe.md). Change
LaunchDialog's Claude model catalog from a fixed one-entry `default` floor to a
live, empirically verified source so that new Anthropic models (such as Sonnet
5) can be displayed without manual updates.

Split out a short-lived SDK probe as a dedicated CLI
(`kaoiro-claude-probe`) in wrapper/claude-code and launch it as a child process
from runner. Runner owns a memory-only last-known-good cache and dedup mutex,
and sends refreshes to the hosts broadcast through the existing
`RunnerLink.updateRegister()`. The server side is only a thin relay (no new
GenServer).

Responsibility split: runner is the catalog SoT, server is the engine-agnostic
relay, wrapper provides a probe CLI with the SDK dependency contained there,
and the client handles automatic/manual refresh and default fallback display.

## Acceptance Criteria

- [x] Measure an empirical spike establishing init→supportedModels→close with no
      prompt sent and zero side effects (session file diff 0 / tmpdir pollution 0 /
      no child process left behind) (phase-20-1, SDK 0.3.208).
- [x] Add `RefreshEngineCatalog` / `EngineCatalogResult` /
      `EngineCatalogFailReason` to `protocol/src/index.ts`.
- [x] Create `wrapper/claude-code/src/probe.ts` and publish it as
      `bin: kaoiro-claude-probe` through package.json exports + bin. The probe uses
      init.models as its primary source and falls back to `supportedModels()` only
      when undefined/empty. Use minimal-side-effect Options (isolated cwd /
      empty mcpServers/tools/hooks/agents/additionalDirectories); retain
      OAuth/keychain (`--bare` is forbidden).
- [x] Execute the probe CLI through a child process in
      `runner/src/claude_probe.ts` (do not bring a direct SDK dependency into
      runner). Implement timeout / abort / stdout parse / classifyError.
- [x] Give `runner/src/claude_catalog_cache.ts` a memory-only cache + TTL (1h) +
      last-known-good + dedup mutex. Preserve the cache when the probe fails.
- [x] Make `runner/src/engine_catalog_refresh.ts` handle payload validation,
      unsupported-engine gating, probe orchestration, updateRegister, and
      sending catalog_result. engine=codex immediately returns
      unsupported_engine without invoking the probe.
- [x] Add an `onRefreshEngineCatalog` callback and `sendCatalogResult` method to
      `runner/src/transport.ts`.
- [x] Wire the cache instance + handler in `runner/src/cli.ts`; apply the cache's
      last-known-good to updateRegister on config hot-reload.
- [x] Add an optional third argument `claudeCatalogOverride?` to
      `runner/src/config.ts` `buildRegister` (preserve backward compatibility;
      when specified, override the models of the claude-code entry).
- [x] Add `handle_in("refresh_engine_catalog", ...)` to
      `server/lib/kaoiro_server_web/channels/agents_channel.ex`
      (operator-only, `relay_to_runner_guarded` pattern). Add `catalog_result`
      to `intercept` and `handle_out` to guarantee operator-only delivery.
- [x] Add `handle_in("catalog_result", ...)` to
      `server/lib/kaoiro_server_web/channels/runner_channel.ex`
      (`forward_to_operators` pattern, host_id stamp).
- [x] Add `refreshEngineCatalog` / `onCatalogResult` /
      `EngineCatalogResult` to `dashboard/src/lib/protocol.ts` and defensive
      parsing in `parseCatalogResult`.
- [x] Add automatic refresh (force=false) when engine=claude-code is selected,
      a Claude-only manual refresh button (force=true), error display, and
      default fallback preservation to `dashboard/src/lib/LaunchDialog.svelte`.
- [x] Unit tests: `runner/test/claude_catalog_cache.test.ts` (TTL / force /
      dedup / failure preserves), `runner/test/engine_catalog_refresh.test.ts`
      (success / failure / unsupported_engine / malformed drop / cache-fresh
      skip), and a buildRegister override in `runner/test/config.test.ts`.
- [x] Integration tests: refresh_engine_catalog relay + operator-only intercept
      in `server/test/kaoiro_server_web/channels/agents_channel_test.exs`, and
      catalog_result forwarding in `runner_channel_test.exs`.
- [x] Correct the Context / Alternatives of `ADR-0037` from “impossible in
      principle” to “impossible under the register-only premise; mitigated by
      ADR-0039's short-lived probe (query generation).”
- [x] Related typecheck / test / format pass (commit after Fuji review).

## Tasks

| # | Target | Status |
|---|------|------|
| 20-1 | Empirical spike (probe side-effect verification with SDK 0.3.208) | ✅ |
| 20-2 | protocol event definitions (RefreshEngineCatalog / EngineCatalogResult) | ✅ |
| 20-3 | Split out the wrapper/claude-code probe CLI + bin entry | ✅ |
| 20-4 | runner probe client + cache + orchestrator + transport | ✅ |
| 20-5 | server relay (agents_channel + runner_channel + intercept/handle_out) | ✅ |
| 20-6 | client (protocol.ts + LaunchDialog automatic/manual refresh) | ✅ |
| 20-7 | unit + integration tests | ✅ |
| 20-8 | docs (ADR-0039 / phase-20 plan / ADR-0037 correction) | ✅ |
| 20-9 | verify both repos + Fuji review | ✅ |
| 20-10 | ADR-0039 F9 v1: initial catalog transport through WrapperConfig (A only) | ✅ |
| 20-11 | ADR-0039 F9 v2: B-equivalent short-lived probe inside wrapper + refresh_models_result correlation + probe launcher consolidation + defensive row shape (Fuji review turns 5→7) | ✅ |

## Notes

- Implementation was performed by Kuroe through kaoiro peer delegation; Fuji
  handled review and commit/push (2026-07-15). Commit / push / branch /
  installer execution followed review.
- Do not leave personal information (account.email etc.) in docs/test
  fixtures/logs/commit artifacts (Fuji's turn-5 instruction; redact
  thoroughly). Keep the spike record only at “OAuth authentication succeeded.”
- `settingsSources` was not found in SDK 0.3.208 `Options`, and user settings
  are therefore always loaded even in the probe subprocess (ADR-0039 F4 note).
  Minimize side effects with isolated cwd + `mcpServers: {}` / `tools: []`, etc.
- State the probe/wrapper account mismatch risk on multi-account hosts in the
  Consequences of ADR-0039 (single-account premise).
- Keep the Codex catalog unchanged (ADR-0035 F1). The live probe is Claude-only.
- Verification record (final): runner 171 pass (probe tests +2 = empty/all-row
  invalid), wrapper build ok (probe.js generated), client 176 pass (integration
  test 15: LaunchDialog 7 + pending store 6 + unmount async no-crash 1 +
  in-place hosts refresh no-refire 1), client svelte-check 337 files/0 errors,
  server mix test 409/410 (the sole failure is known #111 DETS non-isolation,
  non-regressive for this change).
- Fuji (kaoiro peer)'s independent real-probe execution (redacted record):
  PASS / exit 0 / elapsed ~1.59s / 6 models / `~/.claude/projects` file count
  diff 0 / no personal information in output / no probe process left behind.
  This reconfirmed that ADR-0039 F4's minimal-side-effect Options configuration
  works as empirically observed in the operator's environment.
