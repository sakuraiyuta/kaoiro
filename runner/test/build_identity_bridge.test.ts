import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isValidBuildVersion, isValidBuildBranch } from "../src/build_identity_domain.js";
import { loadBuildInfo } from "../src/build_info.js";
import { parseRunnerArgs } from "../src/args.js";

const fixture = JSON.parse(readFileSync(new URL("../../scripts/fixtures/build-identity-domain.json", import.meta.url), "utf8"));
const revision = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function load(fields: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "fuji571-reader-")); dirs.push(dir);
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ revision, dirty: false, built_at: "unknown", version: "2026.10.09.1", channel: "dev", branch: "develop", ...fields }));
  return loadBuildInfo(dir);
}
describe("landing identity compatibility bridge", () => {
  it.each((fixture.valid_versions as unknown[]))("accepts version %s", (v) => expect(isValidBuildVersion(v)).toBe(true));
  it.each((fixture.invalid_versions as unknown[]))("rejects version %s", (v) => expect(isValidBuildVersion(v)).toBe(false));
  it.each((fixture.valid_branches as unknown[]))("accepts branch %s", (v) => expect(isValidBuildBranch(v)).toBe(true));
  it.each((fixture.invalid_branches as unknown[]))("rejects branch %s", (v) => expect(isValidBuildBranch(v)).toBe(false));
  it("preserves a complete landing identity", () => expect(load({})).toMatchObject({ revision, branch: "develop", version: "2026.10.09.1" }));
  it.each([{ branch: undefined }, { branch: "bad branch" }, { dirty: true }, { revision: "unknown" }, { version: "2026.02.30.1" }])("degrades malformed landing fields %j", (v) => expect(load(v).revision).toBe("unknown"));
  it("keeps legacy branch omission compatible", () => expect(load({ version: "2026.9.0", branch: undefined }).revision).toBe(revision));
  it("parses machine version without a config", () => expect(parseRunnerArgs(["--version", "--json"])).toEqual({ configPath: "runner.config.json", version: true, json: true }));
});
