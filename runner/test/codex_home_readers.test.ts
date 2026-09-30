import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Every reader of the Codex state directory goes through codexHome(), so the
// runner and the wrappers agree on where it is. A quoted ".codex" path segment
// anywhere else is a second, env-blind copy of that answer.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const roots = ["runner/src", "wrapper/codex/src"];
const allowed = new Set(["wrapper/codex/src/codex_home.ts"]);
const QUOTED_CODEX_DIR = /["'`]\.codex["'`]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

it("keeps the literal \".codex\" out of every source file except codex_home.ts", () => {
  const files = roots.flatMap((root) => sourceFiles(join(repo, root)));
  expect(files.length, "premise: the scan sees the source trees").toBeGreaterThan(20);
  const offenders = files
    .map((file) => relative(repo, file))
    .filter((file) => !allowed.has(file))
    .filter((file) => QUOTED_CODEX_DIR.test(readFileSync(join(repo, file), "utf8")));
  expect(offenders).toEqual([]);
  const home = readFileSync(join(repo, "wrapper/codex/src/codex_home.ts"), "utf8");
  expect(QUOTED_CODEX_DIR.test(home), "premise: the allowed file is where the literal lives").toBe(true);
});
