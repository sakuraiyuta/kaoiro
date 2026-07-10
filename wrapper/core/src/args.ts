// CLI argument parsing for the wrapper entry point, split out from cli.ts so
// it can be unit-tested without running main() on import.

import { parseArgs } from "node:util";

export interface CliArgs {
  configPath: string;
  prompt?: string | undefined;
  resume?: string | undefined;
}

// Positional [configPath] [prompt] plus the optional --resume <session_id>
// flag (ADR-0014 phase-1: start a wrapper continuing an existing SDK session;
// the id flows to the SDK query's `resume` option).
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { resume: { type: "string" } },
    allowPositionals: true,
  });
  return {
    configPath: positionals[0] ?? "kaoiro.config.json",
    prompt: positionals[1],
    resume: values.resume,
  };
}
