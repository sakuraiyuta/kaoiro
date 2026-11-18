// CLI argument parsing for the wrapper entry point, split out from cli.ts so
// it can be unit-tested without running main() on import.

import { parseArgs } from "node:util";

export interface CliArgs {
  configPath: string;
}

/** A command line that is not `run <launch file>`. The kaoiro entry exits 64
 *  on it. */
export class CliUsageError extends Error {
  override name = "CliUsageError";
}

// `run <launch file>` is the only form a wrapper starts with (ADR-0076). The
// initial prompt and the resume target are fields of the launch file, so they
// never reach the process list.
export function parseCliArgs(argv: string[]): CliArgs {
  const usage = new CliUsageError("usage: kaoiro wrapper <engine> run <launch file>");
  let positionals: string[];
  try {
    // No option is defined, so parseArgs rejects every `--flag`.
    ({ positionals } = parseArgs({ args: argv, allowPositionals: true }));
  } catch {
    throw usage;
  }
  const [verb, configPath, ...rest] = positionals;
  if (verb !== "run" || configPath === undefined || rest.length > 0) throw usage;
  return { configPath };
}
