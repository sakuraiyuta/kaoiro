import { createDeliverySnapshot, deliveryBehaviourRelay } from "./delivery-settings.js";
// Runner CLI runtime — loads the runner config, connects to the kaoiro server
// on `runner:<host_id>`, registers the host, heartbeats, and supervises the
// host's wrapper processes on operator spawn/stop/restart (ADR-0023, phases
// 4-4a/4-4b), plus session enumeration / resume (4-5). cli.ts calls this
// for the kaoiro entry, so the runtime remains import-safe.
//
// Usage: kaoiro runner [configPath] [--version]
//   configPath defaults to runner.config.json. --version prints the canonical
//   build identity (issues #218/#288) and exits without touching config or
//   network.
//   The auth token is read from KAOIRO_RUNNER_TOKEN. Leaving it unset only
//   disables the server's runner auth in :dev / :test — :prod is
//   fail-closed and rejects every runner, since runners have no
//   server-minted signed-token path (issue #133).

import { codexHome, codexHomeProblem } from "@kaoiro/codex";
import { ExternalEngines } from "./external-engines.js";
import type { EngineModelInfo, RunnerRegister } from "@kaoiro/protocol";
import { parseRunnerArgs } from "./args.js";
import {
  formatBuildIdentity,
  formatBuildRevision,
  loadBuildInfo,
} from "./build_info.js";
import {
  behaviourWarnings,
  readSetVariables,
  resolveHeartbeatLogging,
} from "./behaviour-settings.js";
import { ClaudeCatalogCache } from "./claude_catalog_cache.js";
import { makeRefreshEngineCatalogHandler, type RefreshEngineCatalogDeps } from "./engine_catalog_refresh.js";
import {
  CODEX_AUTH_MODE_UNSET_WARNING,
  resolveCodexAuthMode,
  shouldWarnUnsetCodexAuthMode,
} from "./codex-auth.js";
import { antigravityAuthProblem } from "./antigravity-auth.js";
import { resolveAntigravityCatalog } from "./antigravity-catalog.js";
import { resolveAgyVersion } from "./antigravity-version.js";
import { GrokCatalog, probeGrokCatalog, type GrokCatalogProbeOptions } from "./grok-catalog.js";
import { acpProbesSettled } from "./acp_probe.js";
import {
  DEFAULT_AGY_PROBE_TIMEOUT_MS,
  antigravityCatalogSnapshot,
  resolveAgyExecutable,
  type AgyExecutableResolution,
} from "@kaoiro/antigravity";
import {
  applyServerUrlOverride,
  buildRegister,
  effectiveCapabilities,
  loadRunnerConfig,
  type RunnerConfig,
  wrapperUrlFrom,
} from "./config.js";
import { configStamp, notifyConfigSaves } from "./config-watcher.js";
import { extraModelsOptions } from "./extra-models-options.js";
import { makeLauncher } from "./spawn.js";
import type { AntigravityMaxConfig } from "./permission_ceiling.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";
import { RunnerLink, type RunnerLinkOptions } from "./transport.js";

/** Liveness ping cadence; matches the phoenix transport heartbeat default. */
const HEARTBEAT_MS = 30_000;

// Silent-death guard (ADR-0023 observability gap): without these handlers,
// a rejected promise or thrown exception outside a try/catch terminates the
// runner with no context in runner.log — dogfood sessions surface as
// "spawn押しても何も起きない" hours later. Log + exit(1) preserves Node
// 15+'s default fail-visible behavior while making the cause traceable.
export function installRunnerUnhandledHandlers(): void {
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
}

/** Environment names that carry this runner's server credential: its own
 *  variable, and the two list variables the local launchers export. */
const RUNNER_CREDENTIAL_ENV = [
  "KAOIRO_RUNNER_TOKEN",
  "KAOIRO_RUNNER_TOKENS",
  "KAOIRO_LAUNCHER_RUNNER_TOKENS",
] as const;

// Every child inherits process.env, so the credential leaves it here, before
// the first child starts. The link keeps the value it was given.
function takeRunnerToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.KAOIRO_RUNNER_TOKEN;
  for (const name of RUNNER_CREDENTIAL_ENV) delete env[name];
  return token;
}

function isCodexEnabled(config: RunnerConfig): boolean {
  // Absent = bundled default (["claude-code", "codex"]), so codex ON.
  return config.capabilities?.includes("codex") ?? true;
}

function isAntigravityEnabled(config: RunnerConfig): boolean {
  // Absent = bundled default (config.ts BUNDLED_ENGINES includes
  // antigravity), so antigravity ON.
  return config.capabilities?.includes("antigravity") ?? true;
}

/** Host-local antigravity permission-switch ceilings for the supervisor
 *  (ADR-0057 F4c Stage B0, issue #359). Returns undefined when no axis is
 *  declared so the supervisor falls back to the launch-derived defaults. */
function antigravityMaxFrom(
  config: RunnerConfig,
): AntigravityMaxConfig | undefined {
  const a = config.antigravity;
  if (
    a === undefined ||
    (a.max_sandbox === undefined &&
      a.max_approval === undefined &&
      a.max_network_access === undefined)
  ) {
    return undefined;
  }
  return {
    ...(a.max_sandbox === undefined ? {} : { max_sandbox: a.max_sandbox }),
    ...(a.max_approval === undefined ? {} : { max_approval: a.max_approval }),
    ...(a.max_network_access === undefined
      ? {}
      : { max_network_access: a.max_network_access }),
  };
}

type RunnerLinkLike = Pick<
  RunnerLink,
  "sendSpawnResult" | "sendSessions" | "sendResetResult" | "sendStopAgent" | "sendCatalogResult" | "updateRegister" | "close"
>;

export interface RunnerCliDependencies {
  parseRunnerArgs?: typeof parseRunnerArgs;
  loadRunnerConfig?: typeof loadRunnerConfig;
  applyServerUrlOverride?: typeof applyServerUrlOverride;
  resolveCodexAuthMode?: typeof resolveCodexAuthMode;
  resolveAgyExecutable?: typeof resolveAgyExecutable;
  resolveAntigravityCatalog?: typeof resolveAntigravityCatalog;
  resolveAgyVersion?: typeof resolveAgyVersion;
  makeLauncher?: typeof makeLauncher;
  createSupervisor?: (options: SupervisorOptions) => Supervisor;
  createRunnerLink?: (
    serverUrl: string,
    hostId: string,
    options: RunnerLinkOptions,
  ) => RunnerLinkLike;
  catalogProbe?: RefreshEngineCatalogDeps["probe"];
  /** The Grok catalog probe's executable and environment, for tests. */
  grokCatalogProbe?: GrokCatalogProbeOptions;
  installSignalHandlers?: boolean;
}

export interface RunnerCliRuntime {
  supervisor: Supervisor;
  close(): void;
}

export async function runRunnerCli(
  dependencies: RunnerCliDependencies = {},
  argv: string[] = process.argv.slice(2),
): Promise<RunnerCliRuntime | undefined> {
  const startup = new AbortController();
  const interrupt = () => startup.abort();
  const handleSignals = dependencies.installSignalHandlers ?? true;
  if (handleSignals) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
  }
  try {
    return await startRunner(dependencies, argv, startup.signal);
  } catch (error) {
    if (!startup.signal.aborted || error !== startup.signal.reason) throw error;
  } finally {
    if (handleSignals) {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

async function startRunner(
  dependencies: RunnerCliDependencies, argv: string[], signal: AbortSignal,
): Promise<RunnerCliRuntime | undefined> {
  const parseArgs = dependencies.parseRunnerArgs ?? parseRunnerArgs;
  const loadConfig = dependencies.loadRunnerConfig ?? loadRunnerConfig;
  const applyOverride = dependencies.applyServerUrlOverride ?? applyServerUrlOverride;
  const resolveCodex = dependencies.resolveCodexAuthMode ?? resolveCodexAuthMode;
  const resolveExecutable = dependencies.resolveAgyExecutable ?? resolveAgyExecutable;
  const probeCatalog = dependencies.resolveAntigravityCatalog ?? resolveAntigravityCatalog;
  function resolveCatalog(config: RunnerConfig, executable: AgyExecutableResolution, timeout: number) {
    const problem = antigravityAuthProblem(config.antigravity?.auth, process.cwd());
    if (problem === null) return probeCatalog(executable, timeout);
    process.stderr.write(`runner: skipping agy models: ${problem}\n`);
    return antigravityCatalogSnapshot();
  }
  const resolveVersion = dependencies.resolveAgyVersion ?? resolveAgyVersion;
  const createLauncher = dependencies.makeLauncher ?? makeLauncher;
  const createSupervisor = dependencies.createSupervisor ?? ((options) => new Supervisor(options));
  const createRunnerLink = dependencies.createRunnerLink
    ?? ((serverUrl, hostId, options) => new RunnerLink(serverUrl, hostId, options));
  const { configPath, version, json } = parseArgs(argv);
  // issue #218: checked BEFORE loadRunnerConfig — a first-run host with no
  // config yet (setup wizard not run) must still be able to answer
  // --version, and it must never touch the network.
  const buildInfo = loadBuildInfo();
  if (version) {
    process.stdout.write(`${json ? JSON.stringify(buildInfo) : formatBuildIdentity(buildInfo)}\n`);
    return;
  }
  const before = configStamp(configPath);
  const fileConfig = loadConfig(configPath);
  const config = applyOverride(fileConfig);
  const token = takeRunnerToken(process.env);

  // issue #469: a deprecated behaviour variable that is invalid stops the
  // runner here instead of failing every later wrapper launch. A variable
  // that is set is not relayed (the wrapper reads it itself), so the relay
  // holds only the file values.
  for (const line of behaviourWarnings(fileConfig, readSetVariables(config, process.env))) {
    process.stderr.write(line);
  }
  const appliedDelivery = createDeliverySnapshot(config);
  const behaviourRelay = deliveryBehaviourRelay(config, process.env, appliedDelivery);
  const heartbeatLogging = resolveHeartbeatLogging(config, process.env);

  const external = await ExternalEngines.discover(config, configPath, signal);
  signal.throwIfAborted();

  // Explicit `codex.auth_mode` is used verbatim; unset resolves to "unknown"
  // without running `codex doctor` (issue #1214).
  const codexAuthMode = await resolveCodex({
    nextCodex: config.codex,
    nextEnabled: isCodexEnabled(config),
  });

  // Antigravity publishes the catalog and CLI version observed at startup.
  signal.throwIfAborted();
  const antigravityExecutable: AgyExecutableResolution | undefined =
    isAntigravityEnabled(config)
      ? resolveExecutable(config.antigravity?.cli_path)
      : undefined;
  const antigravityProbeTimeoutMs: number | undefined =
    config.antigravity?.probe_timeout_ms ?? DEFAULT_AGY_PROBE_TIMEOUT_MS;
  const antigravityCatalog: EngineModelInfo[] | undefined =
    antigravityExecutable === undefined
      ? undefined
      : await resolveCatalog(
          config, antigravityExecutable,
          antigravityProbeTimeoutMs,
        );
  signal.throwIfAborted();
  const antigravityVersion: string | null =
    antigravityExecutable === undefined
      ? null
      : await resolveVersion(antigravityExecutable, antigravityProbeTimeoutMs);
  signal.throwIfAborted();
  if (antigravityVersion !== null) {
    process.stderr.write(`runner: antigravity agy version ${antigravityVersion}\n`);
  }
  process.stderr.write(`runner: codex home=${codexHome()}\n`);
  const codexHomeIssue = codexHomeProblem();
  if (codexHomeIssue !== null) {
    process.stderr.write(
      `runner: error — ${codexHomeIssue}; Codex launches are refused until it is fixed\n`,
    );
  }
  if (
    shouldWarnUnsetCodexAuthMode({
      nextCodex: config.codex,
      nextEnabled: isCodexEnabled(config),
    })
  ) {
    process.stderr.write(CODEX_AUTH_MODE_UNSET_WARNING);
  }

  // link is assigned just below; the supervisor only calls sendResult after a
  // spawn arrives, long after assignment (mirrors the wrapper's host/link wiring).
  let link: RunnerLinkLike;
  const supervisor = createSupervisor({
    hostId: config.host_id,
    cwdAllowlist: config.cwd_allowlist,
    wrapperServerUrl: wrapperUrlFrom(config.server_url),
    codexAuthMode,
    codexBackend: config.codex?.backend,
    ...(config.codex?.chatgpt_plan === undefined
      ? {}
      : { codexChatgptPlan: config.codex.chatgpt_plan }),
    ...(config.codex?.internal_subagents === undefined
      ? {}
      : { codexInternalSubagents: config.codex.internal_subagents }),
    ...extraModelsOptions(config),
    antigravityAuth: config.antigravity?.auth,
    antigravityExecutable,
    antigravityProbeTimeoutMs,
    antigravityMax: antigravityMaxFrom(config),
    behaviourRelay,
    ...(config.context_work_budget_percent === undefined
      ? {}
      : { contextWorkBudgetPercent: config.context_work_budget_percent }),
    // ADR-0039 F9 追補: a live getter (not a snapshot) so a probe that
    // finishes between spawns reaches the next child. Empty / null falls
    // back to the bootstrap floor server-side (resolveWrapperConfig).
    getClaudeEngineCatalog: () => claudeCatalog.getStale(),
    launch: createLauncher(undefined, id => external.command(id)),
    externalCatalog: id => appliedRegister.engines?.find(row => row.id === id && row.operations?.spawn),
    sendResult: (result) => link.sendSpawnResult(result),
    sendSessions: (sessions) => link.sendSessions(sessions),
    sendResetResult: (result) => link.sendResetResult(result),
    sendStopAgent: (agentId) => link.sendStopAgent(agentId),
  });

  // Option E, ADR-0039: memory-only last-known-good cache for the Claude
  // engine's launch catalog. `updateRegister` re-broadcasts the register
  // whenever a probe succeeds, so LaunchDialog picks up the fresh catalog
  // via the ordinary `hosts` broadcast — no server-side store needed.
  const claudeCatalog = new ClaudeCatalogCache();
  const grokCatalog = new GrokCatalog(probeGrokCatalog, dependencies.grokCatalogProbe ?? {});
  const handleRefreshEngineCatalog = makeRefreshEngineCatalogHandler({
    getHostId: () => config.host_id,
    cache: claudeCatalog,
    ...(dependencies.catalogProbe === undefined ? {} : { probe: dependencies.catalogProbe }),
    getCurrentConfig: () => config,
    getDeliverySnapshot: () => appliedDelivery,
    getCodexAuthMode: () => codexAuthMode,
    // Live getter: threads the already-probed Antigravity catalog into a
    // Claude-only refresh's rebuilt register, so it does not regress to the
    // pinned snapshot.
    getAntigravityCatalog: () => antigravityCatalog,
    getAntigravityCliVersion: () => antigravityVersion ?? undefined,
    getGrokCatalog: () => grokCatalog.current(),
    updateRegister: (register) => {
      const next = external.register(register, config);
      link.updateRegister(next);
      appliedRegister = next;
    },
    sendCatalogResult: (result) => link.sendCatalogResult(result),
    buildInfo,
  });

  let appliedRegister: RunnerRegister = external.register(buildRegister(
      config,
      antigravityVersion ?? undefined,
      codexAuthMode,
      undefined,
      buildInfo,
      antigravityCatalog,
      appliedDelivery,
      grokCatalog.current(),
    ), config);

  link = createRunnerLink(config.server_url, config.host_id, {
    ...(token === undefined || token === "" ? {} : { token }),
    register: appliedRegister,
    heartbeatMs: HEARTBEAT_MS,
    logHeartbeats: () => heartbeatLogging,
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

  // issue #646: the Grok catalog probe starts only once the link and the
  // shutdown path exist, so close() can abort it before stopAll. A newer
  // refresh aborts the one in flight. Until one answers, the register
  // carries the last good catalog, else the default entry.
  let closed = false;
  const refreshGrokCatalog = (): void => {
    if (closed) return;
    if (!effectiveCapabilities(config).includes("grok")) {
      grokCatalog.abort();
      return;
    }
    void grokCatalog.refresh().then((changed) => {
      if (!changed || closed) return;
      const next = external.register(buildRegister(
        config,
        antigravityVersion ?? undefined,
        codexAuthMode,
        claudeCatalog.getStale() ?? undefined,
        buildInfo,
        antigravityCatalog,
        appliedDelivery,
        grokCatalog.current(),
      ), config);
      link.updateRegister(next);
      appliedRegister = next;
    });
  };

  const watcher = notifyConfigSaves(configPath, before);

  const close = (): void => {
    closed = true;
    grokCatalog.abort();
    watcher.close();
    supervisor.stopAll();
    link.close();
  };
  if (dependencies.installSignalHandlers ?? true) {
    // Grok probes end their process groups with a bounded TERM/KILL
    // teardown; exiting before it finishes would orphan a member that
    // ignores SIGTERM.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      close();
      void acpProbesSettled().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
  refreshGrokCatalog();
  return {
    supervisor,
    close,
  };
}
