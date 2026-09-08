import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runnerRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(runnerRoot, "dist", "cli.js");

interface CliPath {
  name: string;
  path: string;
}

function run(entry: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("runner CLI built entry point", () => {
  let root: string;
  let entries: CliPath[];

  beforeAll(() => {
    execFileSync("pnpm", ["build"], { cwd: runnerRoot, stdio: "pipe" });
    root = mkdtempSync(join(tmpdir(), "kaoiro-runner-cli-entry-"));
    const parentLink = join(root, "runner-parent-link");
    const entryLink = join(root, "runner-entry-link.js");
    symlinkSync(runnerRoot, parentLink, "dir");
    symlinkSync(cli, entryLink, "file");
    entries = [
      { name: "direct", path: cli },
      { name: "parent-directory symlink", path: join(parentLink, "dist", "cli.js") },
      { name: "entry-file symlink", path: entryLink },
    ];
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("prints the same version through direct and symlinked built entries", () => {
    const outputs = entries.map(({ name, path }) => ({
      name,
      result: run(path, ["--version"], root),
    }));
    for (const { name, result } of outputs) {
      expect(result.error, name).toBeUndefined();
      expect(result.status, name).toBe(0);
      expect(result.stdout, name).toMatch(/^kaoiro .+ runner v.+ \/ .+\n$/);
    }
    expect(outputs.map(({ result }) => result.stdout)).toEqual([
      outputs[0]!.result.stdout,
      outputs[0]!.result.stdout,
      outputs[0]!.result.stdout,
    ]);
  });

  it("fails loudly for a missing config through every built entry", () => {
    const missingConfig = join(root, "missing-runner.config.json");
    for (const { name, path } of entries) {
      const result = run(path, [missingConfig], root);
      expect(result.error, name).toBeUndefined();
      expect(result.status, name).not.toBe(0);
      expect(result.stdout, name).toBe("");
      expect(result.stderr, name).not.toBe("");
    }
  });
});
