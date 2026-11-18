// The command that starts this same kaoiro again (ADR-0076). The runner uses
// it to start a wrapper, and a wrapper uses it for the scripts it starts.

import { fileURLToPath } from "node:url";

let entryPath: string | undefined;

/** Records the kaoiro entry this process started from. The entry module calls
 *  it once with its own `import.meta.url`: Node resolves symlinks for the main
 *  module, so this is the real path inside the release, whereas
 *  `process.argv[1]` keeps the `current` link and would start a child from
 *  whichever release that link points at later. */
export function registerSelfEntry(entryUrl: string): void {
  entryPath = fileURLToPath(entryUrl);
}

/** `[node, ...node options, entry]`; the caller appends a subcommand. The
 *  whole `process.execArgv` is passed on unfiltered, which is what keeps a
 *  runner started under `tsx` able to start its children. */
export function selfCommand(): string[] {
  if (entryPath === undefined) {
    throw new Error("no kaoiro entry is registered: start through the kaoiro entry point");
  }
  return [process.execPath, ...process.execArgv, entryPath];
}
