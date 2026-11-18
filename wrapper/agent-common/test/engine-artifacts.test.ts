import "../../../scripts/test/fixtures/test-isolation.mjs";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_ARTIFACTS } from "../src/engine-artifacts.js";

describe("engine artifact table", () => {
  it("matches artifact metadata and aliases in the lockfile", () => {
    const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const packages = lock.split("\npackages:\n")[1]!.split("\nsnapshots:\n")[0]!;
    const snapshots = lock.split("\nsnapshots:\n")[1]!;
    const rows = packages.split(/\n  (?=')/).flatMap((block) => {
      const key = block.match(/^'([^']+)':/)?.[1];
      if (!key) return [];
      const claude = key.match(/^(@anthropic-ai\/claude-agent-sdk-(?:linux|darwin|win32)-[^@]+)@(.+)$/);
      const codex = key.match(/^@openai\/codex@(.+)-(?:linux|darwin|win32)-(?:x64|arm64)$/);
      if (!claude && !codex) return [];
      const alias = snapshots.split("\n").find(line => line.endsWith(`: '${key}'`));
      const name = claude?.[1] ?? alias?.trim().match(/^'([^']+)':/)?.[1];
      expect(name).toBeDefined();
      return [{
        name,
        version: claude?.[2] ?? codex?.[1],
        integrity: block.match(/integrity: ([^}]+)}/)?.[1],
        os: block.match(/\n    os: \[([^\]]+)\]/)?.[1],
        cpu: block.match(/\n    cpu: \[([^\]]+)\]/)?.[1],
      }];
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(ENGINE_ARTIFACTS).toEqual(rows);
  });
});

it("rejects incomplete lockfile entries and missing aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-engine-artifacts-"));
  const packageDir = join(root, "wrapper", "agent-common");
  mkdirSync(join(packageDir, "scripts"), { recursive: true });
  mkdirSync(join(packageDir, "src"));
  copyFileSync(new URL("../scripts/generate-engine-artifacts.mjs", import.meta.url),
    join(packageDir, "scripts", "generate-engine-artifacts.mjs"));
  const original = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
  const generator = join(packageDir, "scripts", "generate-engine-artifacts.mjs");
  const changes = [
    original.replace(/(  '@anthropic-ai\/claude-agent-sdk-darwin-arm64@[^']+':\n    resolution: \{)integrity:/, "$1missing:"),
    original.replace(/^      '@openai\/codex-darwin-arm64': .*\n/m, ""),
    original.replaceAll("@anthropic-ai/claude-agent-sdk-", "@other/claude-")
      .replaceAll("@openai/codex", "@other/codex"),
  ];
  try {
    for (const [index, changed] of changes.entries()) {
      expect(changed).not.toBe(original);
      writeFileSync(join(root, "pnpm-lock.yaml"), changed);
      const result = spawnSync(process.execPath, [generator], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      if (index === 1) expect(result.stderr).toContain("Missing alias for");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
