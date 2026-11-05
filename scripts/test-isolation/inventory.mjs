import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeSources, CANARIES, HELPERS } from "./selection.mjs";

const suppliedRoot = process.argv[2];
if (!suppliedRoot) throw new Error("usage: node scripts/test-isolation/inventory.mjs ROOT");
const root = resolve(suppliedRoot);
const ts = createRequire(join(root, "runner/package.json"))("typescript");
const checker = await import(pathToFileURL(join(root, "scripts/test-isolation/check.mjs")));
const { rows, problems } = analyzeSources(root, ts);

const inventory = {
  typescript: ts.version,
  raw: rows.filter(row => row.imports.length > 0).length,
  problems,
  rows: rows.filter(row => row.imports.length > 0).map(row => ({
    path: row.path,
    imports: row.imports,
    exception: HELPERS.includes(row.path) ? "helper" : CANARIES.includes(row.path) ? "setup-canary" : null,
    firstImport: checker.firstImport(row.text) ?? null,
  })),
};
process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
if (problems.length > 0) process.exitCode = 1;
