import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexHome, codexHomeProblem } from "../src/codex_home.js";
import { codexRolloutsRoot, verifyRolloutCorruption } from "../src/rollout.js";

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kaoiro-codex-home-test-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codexHome", () => {
  it("falls back to ~/.codex when CODEX_HOME is unset or empty", () => {
    expect(codexHome({})).toBe(join(homedir(), ".codex"));
    // The Codex CLI treats an empty CODEX_HOME as unset (measured on 0.156.1).
    expect(codexHome({ CODEX_HOME: "" })).toBe(join(homedir(), ".codex"));
  });

  it("returns CODEX_HOME when it is set", () => {
    expect(codexHome({ CODEX_HOME: "/data/codex-home" })).toBe("/data/codex-home");
  });
});

describe("codexHomeProblem", () => {
  it("is silent when CODEX_HOME is unset, empty, or an existing absolute directory", () => {
    expect(codexHomeProblem({})).toBeNull();
    expect(codexHomeProblem({ CODEX_HOME: "" })).toBeNull();
    expect(codexHomeProblem({ CODEX_HOME: tempDir() })).toBeNull();
  });

  it("names the reason for a relative, missing or non-directory path", () => {
    const dir = tempDir();
    const file = join(dir, "file");
    writeFileSync(file, "x");
    expect(codexHomeProblem({ CODEX_HOME: "rel-home" })).toBe("CODEX_HOME=rel-home is not an absolute path");
    expect(codexHomeProblem({ CODEX_HOME: join(dir, "missing") })).toBe(`CODEX_HOME=${join(dir, "missing")} does not exist`);
    expect(codexHomeProblem({ CODEX_HOME: file })).toBe(`CODEX_HOME=${file} is not a directory`);
  });
});

describe("rollout readers follow CODEX_HOME", () => {
  it("roots the sessions directory at CODEX_HOME", () => {
    const home = tempDir();
    vi.stubEnv("CODEX_HOME", home);
    expect(codexRolloutsRoot()).toBe(join(home, "sessions"));
    vi.stubEnv("CODEX_HOME", undefined);
    expect(codexRolloutsRoot()).toBe(join(homedir(), ".codex", "sessions"));
  });

  // No injected root: the default composition production uses.
  it("finds a rollout under CODEX_HOME by default and not without it", () => {
    const home = tempDir();
    const id = "0195aaaa-0000-7000-8000-000000000454";
    const day = join(home, "sessions", "2026", "09", "30");
    mkdirSync(day, { recursive: true });
    const corrupt = Buffer.concat([
      Buffer.from(`${JSON.stringify({ type: "turn_context", payload: {} })}\n`, "utf8"),
      Buffer.from('{"type":"event_msg","payload":{"message":"', "utf8"),
      Buffer.from([0xe3, 0x81]),
    ]);
    writeFileSync(join(day, `rollout-2026-09-30T00-00-00-${id}.jsonl`), corrupt);

    vi.stubEnv("CODEX_HOME", home);
    expect(verifyRolloutCorruption(id)).toBe("corrupted");
    vi.stubEnv("CODEX_HOME", undefined);
    expect(verifyRolloutCorruption(id)).toBe("unknown");
  });
});
