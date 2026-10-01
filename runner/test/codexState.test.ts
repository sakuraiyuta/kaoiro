import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";
const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const snapshotModule = join(deploy, "codex-snapshot.mjs");
const serviceModule = join(deploy, "codex-service.mjs");
const snap = await import(snapshotModule);
const service = await import(serviceModule);

describe("Codex state snapshots", () => {
  let dir: string, home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kogane468-state-"));
    home = join(dir, "home"); mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "sessions", "old.jsonl"), "OLD_HISTORY\n");
    writeFileSync(join(home, "auth.json"), "CURRENT_AUTH_SECRET");
    writeFileSync(join(home, ".credentials.json"), "MCP_SECRET");
    mkdirSync(join(home, "secrets")); writeFileSync(join(home, "secrets", "local.age"), "KEY_SECRET");
    mkdirSync(join(home, "mcp-oauth-locks")); writeFileSync(join(home, "mcp-oauth-locks", "lock"), "LOCK_SECRET");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const take = async (home: string, dir: string) => snap.snapshot(home, join(dir, "backup"), { uuid: "test", staging: join(dir, ".staging.codex-test") });
  it("excludes all current credentials, verifies state, and preserves refreshed credentials on restore", async () => {
    const result = await take(home, dir);
    const backup = join(dir, "backup");
    for (const name of snap.CREDENTIALS) expect(existsSync(join(backup, "state", name))).toBe(false);
    expect(readFileSync(join(backup, "manifest.json"), "utf8")).not.toMatch(/CURRENT_AUTH_SECRET|MCP_SECRET|KEY_SECRET|LOCK_SECRET/);
    writeFileSync(join(home, "auth.json"), "REFRESHED_AUTH");
    writeFileSync(join(home, "sessions", "old.jsonl"), "NEW_HISTORY\n");
    const stage = join(dir, "restore"), quarantine = join(dir, "quarantine");
    snap.prepareRestore(backup, result.sha256, home, stage);
    const phases: string[] = [];
    snap.promoteRestore(home, stage, quarantine, (phase: string) => phases.push(phase));
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("REFRESHED_AUTH");
    expect(existsSync(join(quarantine, "auth.json"))).toBe(false);
    expect(readFileSync(join(home, "sessions", "old.jsonl"), "utf8")).toBe("OLD_HISTORY\n");
    expect(readFileSync(join(quarantine, "sessions", "old.jsonl"), "utf8")).toBe("NEW_HISTORY\n");
    expect(phases.at(-1)).toBe("state-restored");
  });
  it("preserves native policy migration state and excludes stopped runtime locks", async () => {
    writeFileSync(join(home, ".sandbox_migration"), "v1\n");
    for (const name of [".tmp", "thread-writer-locks"]) {
      mkdirSync(join(home, name)); writeFileSync(join(home, name, "lock"), "temporary");
    }
    const result = await take(home, dir);
    expect(readFileSync(join(dir, "backup/state/.sandbox_migration"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "backup/state/.tmp"))).toBe(false);
    expect(existsSync(join(dir, "backup/state/thread-writer-locks"))).toBe(false);
    expect(() => snap.verifySnapshot(join(dir, "backup"), result.sha256)).not.toThrow();
  });
  it.each(["auth.json.tmp", "unclassified", "plugins"])("rejects unclassified entry %s before copying", async (name) => {
    writeFileSync(join(home, name), "secret");
    await expect(take(home, dir)).rejects.toThrow(/Unclassified/);
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });
  it("rejects credential symlinks without opening their targets", async () => {
    rmSync(join(home, "auth.json")); symlinkSync("/nonexistent", join(home, "auth.json"));
    await expect(take(home, dir)).rejects.toThrow(/Credential symlink/);
  });
  it("rejects external session storage", async () => {
    symlinkSync(dir, join(home, "sessions", "external"));
    await expect(take(home, dir)).rejects.toThrow(/External database/);
  });
  it("rejects payload corruption and does not replace live state", async () => {
    const result = await take(home, dir);
    writeFileSync(join(dir, "backup/state/sessions/old.jsonl"), "CORRUPTION");
    expect(() => snap.prepareRestore(join(dir, "backup"), result.sha256, home, join(dir, "restore"))).toThrow(/payload mismatch/);
    expect(readFileSync(join(home, "sessions/old.jsonl"), "utf8")).toBe("OLD_HISTORY\n");
    expect(existsSync(join(dir, "restore"))).toBe(false);
  });
  it("rejects manifest corruption", async () => {
    const result = await take(home, dir);
    const manifest = JSON.parse(readFileSync(join(dir, "backup/manifest.json"), "utf8"));
    manifest.uuid = "different-valid-metadata";
    writeFileSync(join(dir, "backup/manifest.json"), JSON.stringify(manifest));
    expect(() => snap.verifySnapshot(join(dir, "backup"), result.sha256)).toThrow(/digest mismatch/);
  });
  it("does not delete current credentials after a failed credential move", async () => {
    const result = await take(home, dir);
    snap.prepareRestore(join(dir, "backup"), result.sha256, home, join(dir, "restore"));
    expect(() => snap.promoteRestore(home, join(dir, "restore"), join(dir, "quarantine"), (phase: string) => { if (phase === "credential-moved:auth.json") throw new Error("interrupted"); })).toThrow("interrupted");
    expect(readFileSync(join(dir, "restore/auth.json"), "utf8")).toBe("CURRENT_AUTH_SECRET");
    expect(readFileSync(join(dir, "quarantine/.credentials.json"), "utf8")).toBe("MCP_SECRET");
  });
  it("requires logical space plus reserve without performing a copy", () => {
    const fs = statfsSync(dir);
    expect(() => snap.capacity(dir, [{ path: "history.jsonl", category: "state", type: "file", size: fs.bavail * fs.bsize + 1 }])).toThrow(/Insufficient/);
  });
  it("rejects shell execution and resolves only supported path expansions", () => {
    expect(service.parseRunnerEnvironment('CODEX_HOME="$HOME/state"\nTOKEN=literal', { HOME: "/operator" })).toEqual({ HOME: "/operator", CODEX_HOME: "/operator/state" });
    for (const text of ['CODEX_HOME=$(touch /tmp/unwanted)', 'source /tmp/unwanted', 'TOKEN=foo;true', 'CODEX_HOME="$OTHER/path"']) {
      expect(() => service.parseRunnerEnvironment(text, { HOME: "/operator" })).toThrow();
    }
  });
});

describe("Codex pin activation guard through installed symlinks", () => {
  let root: string;
  const A = revisionOf("codex-state-a"), B = revisionOf("codex-state-b");
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kogane468-release-"));
    writeReleaseTree(join(root, "releases", A), A);
    writeReleaseTree(join(root, "releases", B), B);
    symlinkSync(`releases/${A}`, join(root, "current"));
    symlinkSync(`releases/${B}`, join(root, "previous"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const binary = (id: string) => join(root, "releases", id, "node_modules/@openai/codex/vendor/fixture/bin/codex");
  const rollback = () => runScript(join(root, "current/deploy/kaoiro-runner-switch.sh"), ["--rollback", "--install-dir", root]);
  it("permits unchanged native code", () => {
    expect(rollback().status).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });
  it.each(["barrier", "codex-state"])("refuses differing native rollback after deleting %s with zero link mutations", (removed) => {
    mkdirSync(join(root, "codex-state/barriers"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "codex-state/barriers/marker.json"), "{}");
    rmSync(join(root, removed === "barrier" ? "codex-state/barriers/marker.json" : "codex-state"), { recursive: true });
    writeFileSync(binary(B), "#!/bin/sh\nexit 1\n"); chmodSync(binary(B), 0o755);
    const result = rollback();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("native pin differs");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${B}`);
  });
  it("rejects a dangling state-record directory instead of treating it as absent", () => {
    symlinkSync(join(root, "missing-state"), join(root, "codex-state"));
    const result = rollback();
    expect(result.status).not.toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("refuses backend resolver disagreement", () => {
    const rpc = join(root, "releases", B, "node_modules/@kaoiro/codex/dist/app_server_rpc.js");
    writeFileSync(rpc, 'export function resolveAppServerBinary() { return import.meta.filename; }');
    const generator = fileURLToPath(new URL("../../scripts/build-release-manifest.mjs", import.meta.url));
    expect(spawnSync(process.execPath, [generator, join(root, "releases", B)]).status).toBe(0);
    const result = rollback();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("backend native paths disagree");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("refuses missing native payload", () => {
    rmSync(binary(B));
    expect(rollback().status).not.toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it.each(["kaoiro-runner-launch.sh", "kaoiro-runner-codex-state.mjs"])("strict deploy coverage detects %s removed with its manifest entry", (name) => {
    const release = join(root, "releases", B);
    const manifest = JSON.parse(readFileSync(join(release, "MANIFEST.json"), "utf8"));
    delete manifest.files[`deploy/${name}`];
    writeFileSync(join(release, "MANIFEST.json"), JSON.stringify(manifest)); rmSync(join(release, "deploy", name));
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", join(deploy, "verify-release.mjs"), release, "--require-deploy-manifest", "--hash"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
  it("prose-only changes do not invalidate runtime coverage", () => {
    writeFileSync(join(root, "releases", B, "README.md"), "Documentation only");
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", join(deploy, "verify-release.mjs"), join(root, "releases", B), "--require-deploy-manifest", "--hash"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
