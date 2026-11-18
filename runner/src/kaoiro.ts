// The single kaoiro entry point (ADR-0076). The runner, the setup wizard and
// every wrapper start here, so a checkout and a release share one start path.
//
//   kaoiro runner [config]      kaoiro --version [--json]
//   kaoiro setup
//   kaoiro wrapper <engine> <verb> ...     (the verbs are in engines.ts)
//
// Each command imports its module when it runs. No module decides from
// `process.argv` whether it is the entry.

import {
  CliUsageError,
  recoveryExitCode,
  registerSelfEntry,
  writeRedactedStderr,
} from "@kaoiro/wrapper-core";
import { ENGINES, isEngine } from "./engines.js";

registerSelfEntry(import.meta.url);

async function entryStderrLine(
  engine: string | undefined,
  error: unknown,
): Promise<string> {
  if (engine !== "grok" || error instanceof CliUsageError) {
    return `${String(error)}\n`;
  }
  const { GrokLaunchError } = await import("@kaoiro/grok/dist/grok/errors.js");
  const detail = error instanceof GrokLaunchError
    ? error.message
    : "grok wrapper failed";
  return `[kaoiro] ${detail}\n`;
}

const argv = process.argv.slice(2);
const [command, ...rest] = argv;

if (command === "runner" || command === "--version") {
  (await import("./cli.js")).runRunner(command === "runner" ? rest : argv);
} else if (command === "setup") {
  await (await import("./setup-cli.js")).runSetupWizard();
} else if (command === "engines") {
  await (await import("./engine_install.js")).runEngines(rest);
} else {
  const [engine, verb, ...args] = rest;
  const verbs = command === "wrapper" && isEngine(engine) ? ENGINES[engine].verbs : undefined;
  const run = verbs !== undefined && verb !== undefined && Object.hasOwn(verbs, verb)
    ? verbs[verb]
    : undefined;
  if (run === undefined) {
    process.stderr.write(
      "usage: kaoiro runner [config] | --version [--json] | setup | wrapper <engine> <verb> ...\n",
    );
    process.exitCode = 64;
  } else {
    try {
      await run(args);
    } catch (error) {
      writeRedactedStderr(await entryStderrLine(engine, error));
      process.exitCode = error instanceof CliUsageError ? 64 : recoveryExitCode(error);
    }
  }
}
