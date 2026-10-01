import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the CODEX_HOME preflight in every package test configuration", () => {
  const root = new URL("../../", import.meta.url);
  for (const folder of [
    "runner", "wrapper/core", "wrapper/agent-common", "wrapper/codex",
    "wrapper/claude-code", "wrapper/antigravity", "dashboard",
  ]) {
    const path = fileURLToPath(new URL(`${folder}/vitest.config.ts`, root));
    const source = readFileSync(path, "utf8");
    expect(source, path).toMatch(/import ["'](?:\.\.\/)+(?:scripts\/)?vitest-codex-home-guard\.mjs["'];/);
  }
});
