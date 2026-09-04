// Runner entry point — loads the runner config, connects to the kaoiro server
// on `runner:<host_id>`, registers the host, heartbeats, and supervises the
// host's wrapper processes on operator spawn/stop/restart (ADR-0023, phases
// 4-4a/4-4b), plus session enumeration / resume (4-5).
//
// Usage: node dist/cli.js [configPath] [--version]
//   configPath defaults to runner.config.json. --version prints the canonical
//   build identity (issues #228/#288) and exits without touching config or
//   network.
//   The auth token is read from KAOIRO_RUNNER_TOKEN. Leaving it unset only
//   disables the server's runner auth in :dev / :test — :prod is
//   fail-closed and rejects every runner, since runners have no
//   server-minted signed-token path (issue #138).

import type { EngineCatalogResult, EngineModelInfo } from "@kaoiro/protocol";
import { parseRunnerArgs } from "./args.js";
import {
  formatBuildIdentity,
  formatBuildRevision,
  loadBuildInfo,
} from "./build_info.js";
import { ClaudeCatalogCache } from "./claude_catalog_cache.js";
import { makeRefreshEngineCatalogHandler } from "./engine_catalog_refresh.js";
import { type CodexAuthMode, resolveCodexAuthMode } from "./codex-auth.js";
import { resolveAntigravityCatalog } from "./antigravity-catalog.js";
import {
  applyServerUrlOverride,
  buildRegister,
  loadRunnerConfig,
  type RunnerConfig,
  wrapperUrlFrom,
} from "./config.js";
import { changedFields } from "./config-diff.js";
import { watchRunnerConfig } from "./config-watcher.js";
import { makeLauncher } from "./spawn.js";
import { Supervisor } from "./supervisor.js";
import { RunnerLink } from "./transport.js";

/** Liveness ping cadence; matches the phoenix transport heartbeat default. */
const HEARTBEAT_MS = 30_000;

// Silent-death guard (ADR-0023 observability gap): without these handlers,
// a rejected promise or thrown exception outside a try/catch terminates the
// runner with no context in runner.log — dogfood sessions surface as
// "spawn押しても何も起きない" hours later. Log + exit(1) preserves Node
// 15+'s default fail-visible behavior while making the cause traceable.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `runner: unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
  );
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(
    `runner: uncaughtException: ${error.stack ?? error.message}\n`,
  );
  process.exit(1);
});

function isCodexEnabled(config: RunnerConfig): boolean {
  // Absent = bundled default (["claude-code", "codex"]), so codex ON.
  return config.capabilities?.includes("codex") ?? true;
}

function isAntigravityEnabled(config: RunnerConfig): boolean {
  // Absent = bundled default (config.ts BUNDLED_ENGINES includes
  // antigravity), so antigravity ON.
  return config.capabilities?.includes("antigravity") ?? true;
}

async function main(): Promise<void> {
  const { configPath, version } = parseRunnerArgs(process.argv.slice(2));
  // issue #228: checked BEFORE loadRunnerConfig — a first-run host with no
  // config yet (setup wizard not run) must still be able to answer
  // --version, and it must never touch the network.
  const buildInfo = loadBuildInfo();
  if (version) {
    process.stdout.write(`${formatBuildIdentity(buildInfo)}\n`);
    return;
  }
  // KAOIRO_RUNNER_SERVER_URL outranks the file (issue #140) — applied here
  // and again on every config-watcher reload below, so the precedence
  // holds across hot-reloads too.
  let config = applyServerUrlOverride(loadRunnerConfig(configPath));
  const token = process.env.KAOIRO_RUNNER_TOKEN;

  // Phase-24: explicit `codex.auth_mode` > doctor detection > "unknown"。
  // `resolveCodexAuthMode` never invokes doctor when the config declares
  // an explicit value, so a runner environment whose PATH has no `codex`
  // binary still gets the correct catalog (dogfood 環境依存回帰対策)。
  // Detection fails closed internally and never relays doctor output,
  // which may contain credential-presence details alongside the auth mode.
  let codexAuthMode: CodexAuthMode = await resolveCodexAuthMode({
    nextCodex: config.codex,
    nextEnabled: isCodexEnabled(config),
  });

  // ADR-0057 F6: register-time `agy models` probe. Quota-free, so a fresh
  // probe on every startup/reload is the whole refresh story — this engine
  // carries no TTL cache and is absent from LIVE_PROBE_ENGINES (no manual
  // refresh_engine_catalog support, engine_catalog_refresh.ts).
  let antigravityCatalog: EngineModelInfo[] | undefined =
    isAntigravityEnabled(config) ? await resolveAntigravityCatalog() : undefined;

  // link is assigned just below; the supervisor only calls sendResult after a
  // spawn arrives, long after assignment (mirrors the wrapper's host/link wiring).
  let link: RunnerLink;
  const supervisor = new Supervisor({
    hostId: config.host_id,
    cwdAllowlist: config.cwd_allowlist,
    launch: makeLauncher(),
    wrapperServerUrl: wrapperUrlFrom(config.server_url),
    codexAuthMode,
    ...(config.codex?.chatgpt_plan === undefined
      ? {}
      : { codexChatgptPlan: config.codex.chatgpt_plan }),
    ...(config.codex?.internal_subagents === undefined
      ? {}
      : { codexInternalSubagents: config.codex.internal_subagents }),
    ...(config.codex?.extra_models === undefined
      ? {}
      : { codexExtraModels: config.codex.extra_models }),
    ...(config.context_work_budget_percent === undefined
      ? {}
      : { contextWorkBudgetPercent: config.context_work_budget_percent }),
    // ADR-0039 F9 追補: a live getter (not a snapshot) so a probe that
    // finishes between spawns reaches the next child. Empty / null falls
    // back to the bootstrap floor server-side (resolveWrapperConfig).
    getClaudeEngineCatalog: () => claudeCatalog.getStale(),
    sendResult: (result) => link.sendSpawnResult(result),
    sendSessions: (sessions) => link.sendSessions(sessions),
    sendResetResult: (result) => link.sendResetResult(result),
  });

  // Option E, ADR-0039: memory-only last-known-good cache for the Claude
  // engine's launch catalog. `updateRegister` re-broadcasts the register
  // whenever a probe succeeds, so LaunchDialog picks up the fresh catalog
  // via the ordinary `hosts` broadcast — no server-side store needed.
  const claudeCatalog = new ClaudeCatalogCache();
  const handleRefreshEngineCatalog = makeRefreshEngineCatalogHandler({
    // Live getter (藤 must-fix 2): a hot-reload that changes host_id
    // reaches subsequent catalog_result replies without re-wiring the
    // handler.
    getHostId: () => config.host_id,
    cache: claudeCatalog,
    getCurrentConfig: () => config,
    getCodexAuthMode: () => codexAuthMode,
    updateRegister: (register) => link.updateRegister(register),
    sendCatalogResult: (result) => link.sendCatalogResult(result),
    buildInfo,
  });

  link = new RunnerLink(config.server_url, config.host_id, {
    ...(token === undefined || token === "" ? {} : { token }),
    register: buildRegister(
      config,
      codexAuthMode,
      undefined,
      buildInfo,
      antigravityCatalog,
    ),
    heartbeatMs: HEARTBEAT_MS,
    onSpawn: (payload) => supervisor.handleSpawn(payload),
    onStop: (payload) => supervisor.handleStop(payload),
    onRestart: (payload) => supervisor.handleRestart(payload),
    onEnumerateSessions: (payload) => supervisor.handleEnumerate(payload),
    onSwitchSession: (payload) => supervisor.handleSwitchSession(payload),
    onResetSession: (payload) => supervisor.handleResetSession(payload),
    onRefreshEngineCatalog: handleRefreshEngineCatalog,
  });

  process.stderr.write(
    `runner: host=${config.host_id} rev=${formatBuildRevision(buildInfo)} ` +
      `connecting to ${config.server_url}\n`,
  );

  // Persona trust policy is now judged server-side against
  // PersonaAssets.all_personas (ADR-0031), so a runner-side manifest
  // reconciliation is no longer meaningful — a new pack ingest reaches
  // blacklist-mode hosts without a re-register.

  // ---- Config hot-reload (dogfood/dev の DX 用) ----------------------------
  // watchRunnerConfig の onReload は同期。Reload 内で codex doctor を回す
  // ケースがあるので Promise chain で直列化する: 立て続けの保存で
  // detectCodexAuthMode が同時進行するのを避け、"最後の書き" が最終状態に
  // 反映される順序性を保つ。
  let reloadQueue: Promise<void> = Promise.resolve();
  const applyReload = async (next: RunnerConfig): Promise<void> => {
    const diff = changedFields(config, next);
    if (diff.length === 0) return;
    process.stderr.write(
      `runner: config reload — ${diff.join(", ")}\n`,
    );
    const prevCodexEnabled = isCodexEnabled(config);
    const nextCodexEnabled = isCodexEnabled(next);
    // Phase-24: hot reload の分岐は resolver に集約。explicit → explicit /
    // explicit → absent / absent → explicit / off → on / on → off の 5
    // 遷移が一貫して policy に従う。explicit set 時は必ず doctor 非呼出。
    codexAuthMode = await resolveCodexAuthMode({
      nextCodex: next.codex,
      nextEnabled: nextCodexEnabled,
      prevCodex: config.codex,
      prevEnabled: prevCodexEnabled,
      prevMode: codexAuthMode,
    });
    // ADR-0057 F6: re-probe on every reload while enabled (quota-free, no
    // TTL cache to preserve); clear the catalog when the operator disables
    // the capability so a stale probe result cannot outlive it.
    antigravityCatalog = isAntigravityEnabled(next)
      ? await resolveAntigravityCatalog()
      : undefined;
    supervisor.updateRuntimeConfig({
      cwdAllowlist: next.cwd_allowlist,
      wrapperServerUrl: wrapperUrlFrom(next.server_url),
      codexAuthMode,
      codexChatgptPlan: next.codex?.chatgpt_plan,
      codexInternalSubagents: next.codex?.internal_subagents,
      codexExtraModels: next.codex?.extra_models,
      contextWorkBudgetPercent: next.context_work_budget_percent,
      // Preserve the live probe getter across reloads (ADR-0039 F9 追補).
      getClaudeEngineCatalog: () => claudeCatalog.getStale(),
    });
    // Preserve any live-probed Claude catalog on reload so operators do not
    // silently regress to the bootstrap default entry (ADR-0039).
    const claudeOverride = claudeCatalog.getStale() ?? undefined;
    const nextRegister = buildRegister(
      next,
      codexAuthMode,
      claudeOverride,
      buildInfo,
      antigravityCatalog,
    );
    if (
      next.host_id !== config.host_id ||
      next.server_url !== config.server_url
    ) {
      process.stderr.write(
        `runner: reconnecting host=${next.host_id} to ${next.server_url}\n`,
      );
      link.reconnect(next.server_url, next.host_id, nextRegister);
    } else {
      link.updateRegister(nextRegister);
    }
    config = next;
  };
  const watcher = watchRunnerConfig(
    configPath,
    (next) => {
      reloadQueue = reloadQueue
        // Re-apply the env override on every reload (issue #140): without
        // this, a file save would silently revert server_url to the file
        // value and reconnect the runner to the wrong host.
        .then(() => applyReload(applyServerUrlOverride(next)))
        .catch((error) => {
          process.stderr.write(
            `runner: config apply failed: ${String(error)}\n`,
          );
        });
    },
    (error) => {
      // Fail-soft: 編集中の一時的な broken JSON を吸収する。次回保存で
      // 直っていれば debounce 経由でそのまま再ロードされる。
      process.stderr.write(
        `runner: config reload skipped (parse error): ${String(error)}\n`,
      );
    },
  );

  const shutdown = (): void => {
    watcher.close();
    supervisor.stopAll();
    link.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
