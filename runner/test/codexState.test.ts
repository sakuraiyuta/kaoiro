import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  it.each(["closed", "uncheckpointed"])("snapshots a real %s WAL database without changing source bytes", async (state) => {
    const path = join(home, "state_5.sqlite");
    const fixture = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER); INSERT INTO _sqlx_migrations VALUES(58,1);");
      if (process.argv[2] === 'closed') db.close();
      else process.kill(process.pid, 'SIGKILL');
    `, path, state], { encoding: "utf8" });
    expect(state === "closed" ? fixture.status : fixture.signal, fixture.stderr).toBe(state === "closed" ? 0 : "SIGKILL");
    expect(existsSync(`${path}-wal`)).toBe(state === "uncheckpointed");
    const before = snap.inventory(home, true);
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const snap = await import(process.argv[1]);
      console.log(JSON.stringify(await snap.snapshot(process.argv[2], process.argv[3], {
        uuid: 'test', staging: process.argv[4]
      })));
    `, snapshotModule, home, join(dir, "backup"), join(dir, ".staging.codex-test")], { encoding: "utf8" });
    expect.soft(probe.status, probe.stderr).toBe(0);
    expect(snap.inventory(home, true)).toEqual(before);
    const result = JSON.parse(probe.stdout);
    expect(result.manifest.migrationLevels["state_5.sqlite"]).toEqual([{ version: 58, success: 1 }]);
    expect(snap.verifySnapshot(join(dir, "backup"), result.sha256).entries).toEqual(snap.stateEntries(before));
  });
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
  it.each(["auth.json.tmp", "unclassified", "unclassified-extension"])("rejects unclassified entry %s before copying", async (name) => {
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
  it("counts top-level diagnostic DB and sidecar copies without charging restore", () => {
    const entries = [
      { path: "state_5.sqlite", category: "state", type: "file", size: 4096 },
      { path: "state_5.sqlite-wal", category: "state", type: "file", size: 8192 },
      { path: "state_5.sqlite-shm", category: "state", type: "file", size: 32768 },
      { path: "state_5.sqlite-journal", category: "state", type: "file", size: 512 },
      { path: "sessions/nested.sqlite", category: "state", type: "file", size: 2048 },
      { path: "auth.json", category: "credential", type: "file", size: 65536 },
    ];
    expect(snap.capacity(dir, entries, true)).toMatchObject({ logicalBytes: 47616, migrationCopyBytes: 45568, migrationCopyInodes: 6 });
    expect(snap.capacity(dir, entries)).toMatchObject({ logicalBytes: 47616, migrationCopyBytes: 0, migrationCopyInodes: 0 });
  });
  it.each(["bytes", "inodes"])("rechecks diagnostic %s capacity before creating snapshot staging", (limit) => {
    writeFileSync(join(home, "state_5.sqlite"), "capacity fixture; never opened as SQLite");
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const snap = await import(process.argv[1]);
      const entries = snap.inventory(process.argv[2]);
      const bytes = snap.stateEntries(entries).reduce((n,e)=>n+(e.type==='file'?e.size:0),0);
      const dbBytes = entries.find(e=>e.path==='state_5.sqlite').size;
      const reserve = Math.max(Math.ceil(bytes*0.2),1024**3);
      const original = fs.statfsSync;
      fs.statfsSync = (path) => ({...original(path), ...(process.argv[5]==='bytes'
        ? {bsize:1,bavail:bytes+reserve+Math.floor(dbBytes/2)}
        : {ffree:entries.length+10})});
      syncBuiltinESMExports();
      await snap.snapshot(process.argv[2],process.argv[3],{uuid:'test',staging:process.argv[4]});
    `, snapshotModule, home, join(dir, "backup"), join(dir, ".staging.codex-test"), limit], { encoding: "utf8" });
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain(limit === "bytes" ? "Insufficient snapshot/restore disk capacity" : "Insufficient snapshot/restore inodes");
    expect(existsSync(join(dir, ".staging.codex-test"))).toBe(false);
    expect(existsSync(join(dir, "backup"))).toBe(false);
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
  const stale = (home = "/home/operator/.codex") => JSON.stringify({ schema: 1, binding: { home: { path: home, dev: 1, ino: 2, mode: 0o700 }, unit: "x.service", config: "/c", sourceHash: "0".repeat(64), configIdentity: { dev: 1, ino: 3 }, manager: {}, effective: {}, unitSources: [], execStart: "x", live: { pid: 1, start: "1" } }, native: { id: revisionOf("codex-state-a"), path: "p", sha256: "e".repeat(64) }, uuid: "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12), acceptance: { evidenceHash: "0".repeat(64), accepted: "2026-01-01T00:00:00.000Z" } });
  const forwardSwitch = () => runScript(join(root, "current/deploy/kaoiro-runner-switch.sh"), [B, "--install-dir", root]);
  it.each([["absent barrier directory"], ["absent registry"]].flatMap(([state]) => [[state, "rollback"], [state, "forward switch"]] as const))("refuses a differing native pin through current with %s on %s and zero link mutations", (state, path) => {
    if (state === "absent barrier directory") mkdirSync(join(root, "codex-state/transactions"), { recursive: true, mode: 0o700 });
    writeFileSync(binary(B), "#!/bin/sh\nexit 1\n"); chmodSync(binary(B), 0o755);
    if (path === "forward switch") rmSync(join(root, "previous"));
    const result = path === "rollback" ? rollback() : forwardSwitch();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("native pin differs");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    if (path === "rollback") expect(readlinkSync(join(root, "previous"))).toBe(`releases/${B}`);
    else expect(existsSync(join(root, "previous"))).toBe(false);
  });
  it("ignores a well-formed stale barrier whose hashes differ from the installation", () => {
    mkdirSync(join(root, "codex-state/barriers"), { recursive: true, mode: 0o700 });
    const file = join(root, "codex-state/barriers", `${createHash("sha256").update("/home/operator/.codex").digest("hex")}.json`);
    writeFileSync(file, stale(), { mode: 0o600 });
    const before = lstatSync(file);
    const result = rollback();
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(readFileSync(file, "utf8")).toBe(stale());
    expect(lstatSync(file).ino).toBe(before.ino);
  });
  it("still refuses a differing native pin when a stale barrier names the candidate's hash", () => {
    mkdirSync(join(root, "codex-state/barriers"), { recursive: true, mode: 0o700 });
    writeFileSync(binary(B), "#!/bin/sh\nexit 1\n"); chmodSync(binary(B), 0o755);
    writeFileSync(join(root, "codex-state/barriers/stale.json"), stale(), { mode: 0o600 });
    const result = rollback();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("native pin differs");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("rejects a dangling state-record directory instead of treating it as absent", () => {
    symlinkSync(join(root, "missing-state"), join(root, "codex-state"));
    const result = rollback();
    expect(result.status).not.toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("refuses dangling current instead of treating it as a fresh installation", () => {
    rmSync(join(root, "releases", A), { recursive: true });
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-switch.sh"), [B, "--install-dir", root]);
    expect(result.status).not.toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${B}`);
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
  it("refuses multiple native candidates even when both backends select the same file", () => {
    const alternate = join(root, "releases", B, "node_modules/@openai/codex/vendor/fixture/codex");
    mkdirSync(alternate); writeFileSync(join(alternate, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(alternate, "codex"), 0o755);
    const result = rollback();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Ambiguous Codex native candidates");
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

describe("removed barrier repair action", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ao498-repair-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [join(deploy, "kaoiro-runner-codex-state.mjs"), "repair-barrier", root, "00000000-0000-0000-0000-000000000000"], { encoding: "utf8" });
  it("is an unknown action", () => {
    const result = run();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("codex-state: Unknown Codex state action");
    expect(existsSync(join(root, "codex-state"))).toBe(false);
  });
  it.each([".lock.update", ".lock.links"])("fails as an unknown action, not on a lock, while %s is held", (held) => {
    const other = held === ".lock.update" ? ".lock.links" : ".lock.update";
    mkdirSync(join(root, held));
    writeFileSync(join(root, held, "sentinel"), "owner");
    const result = run();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("codex-state: Unknown Codex state action");
    expect(result.stderr).not.toContain("EEXIST");
    expect(readFileSync(join(root, held, "sentinel"), "utf8")).toBe("owner");
    expect(existsSync(join(root, other))).toBe(false);
    expect(existsSync(join(root, "codex-state"))).toBe(false);
  });
});
