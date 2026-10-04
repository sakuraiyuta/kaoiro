import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

// The SDK stream patch (pnpm-workspace.yaml `patchedDependencies`) matters
// only where readline splits on U+2028 / U+2029: Node 24 does, Node 22.23.3
// does not, so the real-stream test in host.test.ts passes unpatched on the
// Node 22 CI. Read the SDK this package actually resolves instead, the way
// runner/deploy/codex-native.mjs locates it.
it("resolves the patched @openai/codex-sdk stream reader", () => {
  const fromPackage = createRequire(new URL("../package.json", import.meta.url));
  const manifest = (fromPackage.resolve.paths("@openai/codex-sdk") ?? [])
    .map(dir => join(dir, "@openai/codex-sdk/package.json"))
    .find(path => existsSync(path));
  expect(manifest).toBeDefined();
  const entry = (JSON.parse(readFileSync(manifest!, "utf8")) as { exports?: { ".": { import?: string } } }).exports?.["."]?.import;
  expect(entry).toMatch(/^\.\//);
  const source = readFileSync(join(dirname(manifest!), entry!), "utf8");
  expect(source).not.toContain("readline.createInterface");
  expect(source).toContain('pending.indexOf("\\n")');
});
