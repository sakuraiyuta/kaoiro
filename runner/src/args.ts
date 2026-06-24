// CLI argument parsing for the runner entry point, split out from cli.ts so it
// can be unit-tested without running main() on import.

import { parseArgs } from "node:util";

export interface RunnerCliArgs {
  configPath: string;
}

// Positional [configPath], defaulting to runner.config.json in the cwd.
export function parseRunnerArgs(argv: string[]): RunnerCliArgs {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  return { configPath: positionals[0] ?? "runner.config.json" };
}
