// Runner entry point — loads the runner config, connects to the kaoiro server
// on `runner:<host_id>`, registers the host, heartbeats, and supervises the
// host's wrapper processes on operator spawn/stop/restart (ADR-0023, phases
// 4-4a/4-4b). Session enumeration / resume arrive in phase 4-5.
//
// Usage: node dist/cli.js [configPath]
//   configPath defaults to runner.config.json. The auth token is read from
//   KAOIRO_RUNNER_TOKEN (unset = the server's runner auth is disabled, dev).

import { parseRunnerArgs } from "./args.js";
import { type CodexAuthMode, detectCodexAuthMode } from "./codex-auth.js";
import {
  buildRegister,
  loadRunnerConfig,
  type RunnerConfig,
  wrapperUrlFrom,
} from "./config.js";
import { watchRunnerConfig } from "./config-watcher.js";
import { makeLauncher } from "./spawn.js";
import { Supervisor } from "./supervisor.js";
import { RunnerLink } from "./transport.js";

/** Liveness ping cadence; matches the phoenix transport heartbeat default. */
const HEARTBEAT_MS = 30_000;

/** Config-reload diff: which top-level fields differ. `codex` is a whole-object
 *  compare so a chatgpt_plan change surfaces as one entry ("codex"). Uses
 *  JSON.stringify equality — parseRunnerConfig builds fields in a stable order
 *  so a byte-identical config produces byte-identical JSON. */
function changedFields(prev: RunnerConfig, next: RunnerConfig): string[] {
  const fields: (keyof RunnerConfig)[] = [
    "host_id",
    "server_url",
    "cwd_allowlist",
    "capabilities",
    "personas",
    "allowed_personas",
    "blocked_personas",
    "codex",
  ];
  const changed: string[] = [];
  for (const field of fields) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      changed.push(field);
    }
  }
  return changed;
}

function isCodexEnabled(config: RunnerConfig): boolean {
  // Absent = bundled default (["claude-code", "codex"]), so codex ON.
  return config.capabilities?.includes("codex") ?? true;
}

async function main(): Promise<void> {
  const { configPath } = parseRunnerArgs(process.argv.slice(2));
  let config = loadRunnerConfig(configPath);
  const token = process.env.KAOIRO_RUNNER_TOKEN;

  // Detection fails closed internally and never relays doctor output, which
  // may contain credential-presence details alongside the auth mode.
  let codexAuthMode: CodexAuthMode = isCodexEnabled(config)
    ? await detectCodexAuthMode()
    : "unknown";

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
    sendResult: (result) => link.sendSpawnResult(result),
    sendSessions: (sessions) => link.sendSessions(sessions),
    sendResetResult: (result) => link.sendResetResult(result),
  });

  link = new RunnerLink(config.server_url, config.host_id, {
    ...(token === undefined || token === "" ? {} : { token }),
    register: buildRegister(config, codexAuthMode),
    heartbeatMs: HEARTBEAT_MS,
    onSpawn: (payload) => supervisor.handleSpawn(payload),
    onStop: (payload) => supervisor.handleStop(payload),
    onRestart: (payload) => supervisor.handleRestart(payload),
    onEnumerateSessions: (payload) => supervisor.handleEnumerate(payload),
    onSwitchSession: (payload) => supervisor.handleSwitchSession(payload),
    onResetSession: (payload) => supervisor.handleResetSession(payload),
  });

  process.stderr.write(
    `runner: host=${config.host_id} connecting to ${config.server_url}\n`,
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
    // codex を新規 ON にした場合のみ doctor を再走。ON のまま / OFF のまま
    // なら現在の mode を維持し、OFF にした場合は unknown に戻す。
    if (nextCodexEnabled && !prevCodexEnabled) {
      codexAuthMode = await detectCodexAuthMode();
    } else if (!nextCodexEnabled) {
      codexAuthMode = "unknown";
    }
    supervisor.updateRuntimeConfig({
      cwdAllowlist: next.cwd_allowlist,
      wrapperServerUrl: wrapperUrlFrom(next.server_url),
      codexAuthMode,
      codexChatgptPlan: next.codex?.chatgpt_plan,
    });
    const nextRegister = buildRegister(next, codexAuthMode);
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
        .then(() => applyReload(next))
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
