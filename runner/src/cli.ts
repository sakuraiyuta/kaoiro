// Runner entry point — loads the runner config, connects to the kaoiro server
// on `runner:<host_id>`, registers the host, heartbeats, and supervises the
// host's wrapper processes on operator spawn/stop/restart (ADR-0023, phases
// 4-4a/4-4b). Session enumeration / resume arrive in phase 4-5.
//
// Usage: node dist/cli.js [configPath]
//   configPath defaults to runner.config.json. The auth token is read from
//   KAOIRO_RUNNER_TOKEN (unset = the server's runner auth is disabled, dev).

import { parseRunnerArgs } from "./args.js";
import { buildRegister, loadRunnerConfig } from "./config.js";
import { makeLauncher } from "./spawn.js";
import { Supervisor } from "./supervisor.js";
import { RunnerLink } from "./transport.js";

/** Liveness ping cadence; matches the phoenix transport heartbeat default. */
const HEARTBEAT_MS = 30_000;

function main(): void {
  const { configPath } = parseRunnerArgs(process.argv.slice(2));
  const config = loadRunnerConfig(configPath);
  const token = process.env.KAOIRO_RUNNER_TOKEN;

  // link is assigned just below; the supervisor only calls sendResult after a
  // spawn arrives, long after assignment (mirrors the wrapper's host/link wiring).
  let link: RunnerLink;
  const supervisor = new Supervisor({
    hostId: config.host_id,
    cwdAllowlist: config.cwd_allowlist,
    launch: makeLauncher(),
    sendResult: (result) => link.sendSpawnResult(result),
    sendSessions: (sessions) => link.sendSessions(sessions),
  });

  link = new RunnerLink(config.server_url, config.host_id, {
    ...(token === undefined || token === "" ? {} : { token }),
    register: buildRegister(config),
    heartbeatMs: HEARTBEAT_MS,
    onSpawn: (payload) => supervisor.handleSpawn(payload),
    onStop: (payload) => supervisor.handleStop(payload),
    onRestart: (payload) => supervisor.handleRestart(payload),
    onEnumerateSessions: (payload) => supervisor.handleEnumerate(payload),
  });

  process.stderr.write(
    `runner: host=${config.host_id} connecting to ${config.server_url}\n`,
  );

  const shutdown = (): void => {
    supervisor.stopAll();
    link.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
