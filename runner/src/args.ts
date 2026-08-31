// CLI argument parsing for the runner entry point, split out from cli.ts so it
// can be unit-tested without running main() on import.

import { parseArgs } from "node:util";

export interface RunnerCliArgs {
  configPath: string;
  /** issue #228/#288: `--version` prints the build identity and exits, without
   *  touching config / network. */
  version: boolean;
}

// Positional [configPath], defaulting to runner.config.json in the cwd.
export function parseRunnerArgs(argv: string[]): RunnerCliArgs {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { version: { type: "boolean", default: false } },
  });
  return {
    configPath: positionals[0] ?? "runner.config.json",
    version: values.version === true,
  };
}
