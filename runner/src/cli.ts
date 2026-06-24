// Runner entry point — loads the runner config, connects to the kaoiro server
// on `runner:<host_id>`, registers the host, and heartbeats to stay live
// (ADR-0023, phase 4-4a). Process supervision (spawn/stop/restart) and session
// enumeration / resume arrive in later phases.
//
// Usage: node dist/cli.js [configPath]
//   configPath defaults to runner.config.json. The auth token is read from
//   KAOIRO_RUNNER_TOKEN (unset = the server's runner auth is disabled, dev).

import { parseRunnerArgs } from "./args.js";
import { loadRunnerConfig, buildRegister } from "./config.js";
import { RunnerLink } from "./transport.js";

/** Liveness ping cadence; matches the phoenix transport heartbeat default. */
const HEARTBEAT_MS = 30_000;

function main(): void {
  const { configPath } = parseRunnerArgs(process.argv.slice(2));
  const config = loadRunnerConfig(configPath);
  const token = process.env.KAOIRO_RUNNER_TOKEN;

  const link = new RunnerLink(config.server_url, config.host_id, {
    ...(token === undefined || token === "" ? {} : { token }),
    register: buildRegister(config),
    heartbeatMs: HEARTBEAT_MS,
  });

  process.stderr.write(
    `runner: host=${config.host_id} connecting to ${config.server_url}\n`,
  );

  const shutdown = (): void => {
    link.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
