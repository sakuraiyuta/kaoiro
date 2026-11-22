import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fake = fileURLToPath(new URL("./fixtures/fake-agy-acp.mjs", import.meta.url));

/** Writes an executable `agy` stand-in under `root` that runs
 *  fixtures/fake-agy-acp.mjs. `record` gets one JSON line of argv per call;
 *  `env` is set before the fake starts. */
export function writeFakeAgy(
  root: string,
  options: { name?: string; record?: string; env?: Record<string, string> } = {},
): string {
  const executable = join(root, options.name ?? "agy");
  const lines = [
    `#!${process.execPath}`,
    ...(options.record === undefined
      ? []
      : [`import { appendFileSync } from "node:fs";`, `appendFileSync(${JSON.stringify(options.record)}, JSON.stringify(process.argv.slice(2)) + "\\n");`]),
    ...Object.entries(options.env ?? {}).map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`),
    `await import(${JSON.stringify(fake)});`,
  ];
  writeFileSync(executable, `${lines.join("\n")}\n`);
  chmodSync(executable, 0o755);
  return executable;
}
