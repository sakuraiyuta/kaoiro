import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexHomeFixture, HOME_ROOT_NAMES, protectInstructionTargets } from "./codexHomeFixture.js";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const snapshotModule = join(deploy, "codex-snapshot.mjs");
const stateCLI = join(deploy, "kaoiro-runner-codex-state.mjs");

describe("production-shaped Codex home classification", () => {
  let dir: string, fixture: ReturnType<typeof createCodexHomeFixture>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kogane468-classify-"));
    fixture = createCodexHomeFixture(dir);
    expect(readdirSync(fixture.home).sort()).toEqual([...HOME_ROOT_NAMES].sort());
    expect(HOME_ROOT_NAMES).toHaveLength(33);
  });
  afterEach(() => {
    if (fixture) protectInstructionTargets(fixture.links, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });

  it("classifies the exact 33-name home through the actual CLI without following instruction links", () => {
    protectInstructionTargets(fixture.links, 0);
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status, result.stderr).toBe(0);
    const entries = JSON.parse(result.stdout);
    const roots = entries.filter((e: { path: string }) => !e.path.includes("/"));
    expect(roots.map((e: { path: string }) => e.path).sort()).toEqual([...HOME_ROOT_NAMES].sort());
    for (const [name, target] of Object.entries(fixture.links)) {
      expect(entries).toContainEqual(expect.objectContaining({ path: name, category: "state", type: "symlink", target }));
      expect(entries.some((e: { path: string }) => e.path.startsWith(`${name}/`))).toBe(false);
      expect(lstatSync(target).mode & 0o777).toBe(0);
    }
    expect(entries).toContainEqual(expect.objectContaining({ path: "plugins", category: "state" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "plugins/.remote-plugin-install-staging/partial/bundle.json", category: "state" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: `${fixture.plugin}/.codex-plugin/plugin.json`, category: "state" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "cache", category: "disposable" }));
    expect(entries).toContainEqual(expect.objectContaining({ path: "auth.json", category: "credential" }));
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });

  it("restores instruction symlinks and plugin state but omits root cache and keeps current credentials", () => {
    const before = Object.fromEntries(readdirSync(fixture.home).filter((name) => name.includes(".sqlite")).map((name) => [name, createHash("sha256").update(readFileSync(join(fixture.home, name))).digest("hex")]));
    protectInstructionTargets(fixture.links, 0);
    const result = run(["--input-type=module", "-e", `
      import * as fs from 'node:fs';
      import { join } from 'node:path';
      const snap=await import(process.argv[1]);
      const home=process.argv[2],dir=process.argv[3];
      const before=snap.inventory(home,true);
      const result=await snap.snapshot(home,join(dir,'backup'),{uuid:'fixture',staging:join(dir,'.staging.codex-fixture')});
      const after=snap.inventory(home,true);
      fs.writeFileSync(join(home,'auth.json'),'REFRESHED_AUTH');
      fs.writeFileSync(join(home,'sessions/old.jsonl'),'AFTER_SNAPSHOT');
      for(const name of ['AGENTS.md','agents','hooks','model-profiles']) {
        fs.unlinkSync(join(home,name)); fs.symlinkSync('/unavailable/new-target',join(home,name));
      }
      snap.prepareRestore(join(dir,'backup'),result.sha256,home,join(dir,'restore'));
      snap.promoteRestore(home,join(dir,'restore'),join(dir,'quarantine'),()=>{});
      console.log(JSON.stringify({before,after,manifest:result.manifest}));
    `, snapshotModule, fixture.home, dir]);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.after).toEqual(output.before);
    expect(Object.keys(output.manifest.migrationLevels)).toHaveLength(6);
    for (const rows of Object.values(output.manifest.migrationLevels)) expect(rows).toEqual([{ version: 1, success: 1 }]);
    for (const [name, hash] of Object.entries(before)) {
      expect(createHash("sha256").update(readFileSync(join(fixture.home, name))).digest("hex")).toBe(hash);
    }
    for (const [name, target] of Object.entries(fixture.links)) {
      for (const base of [fixture.home, join(dir, "backup/state")]) {
        expect(lstatSync(join(base, name)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(base, name))).toBe(target);
      }
      expect(lstatSync(target).mode & 0o777).toBe(0);
    }
    expect(readFileSync(join(fixture.home, `${fixture.plugin}/skills/sample/SKILL.md`), "utf8")).toBe("INSTALLED_PLUGIN_SKILL\n");
    expect(readFileSync(join(fixture.home, "plugins/data/sample-openai-curated-remote/local.json"), "utf8")).toBe('{"keep":"local-data"}');
    expect(readFileSync(join(fixture.home, "plugins/.remote-plugin-install-staging/partial/bundle.json"), "utf8")).toBe('{"keep":"staging"}');
    expect(existsSync(join(fixture.home, "cache"))).toBe(false);
    expect(existsSync(join(dir, "backup/state/cache"))).toBe(false);
    expect(existsSync(join(dir, "backup/state/auth.json"))).toBe(false);
    expect(readFileSync(join(fixture.home, "auth.json"), "utf8")).toBe("REFRESHED_AUTH");
    expect(readFileSync(join(fixture.home, "sessions/old.jsonl"), "utf8")).toBe("OLD_HISTORY\n");
    expect(readFileSync(join(dir, "backup/manifest.json"), "utf8")).not.toContain("EXTERNAL_NOT_SNAPSHOTTED");
    protectInstructionTargets(fixture.links, 0o700);
    expect(readFileSync(fixture.links["AGENTS.md"]!, "utf8")).toBe("EXTERNAL_INSTRUCTIONS");
    for (const name of ["agents", "hooks", "model-profiles"]) expect(readFileSync(join(fixture.links[name]!, "private.txt"), "utf8")).toBe("EXTERNAL_NOT_SNAPSHOTTED");
  });

  it.each(["unclassified", "plugins-extra", "auth.json.tmp"])("refuses unknown root %s before creating snapshot staging", (name) => {
    writeFileSync(join(fixture.home, name), "DO_NOT_COPY");
    const result = run([stateCLI, "classify", fixture.home]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(`Unclassified Codex home entry: ${name}`);
    const snapshot = run(["--input-type=module", "-e", `
      const snap=await import(process.argv[1]);
      await snap.snapshot(process.argv[2],process.argv[3],{uuid:'fixture',staging:process.argv[4]});
    `, snapshotModule, fixture.home, join(dir, "backup"), join(dir, ".staging.codex-fixture")]);
    expect(snapshot.status).not.toBe(0);
    expect(snapshot.stderr).toContain(`Unclassified Codex home entry: ${name}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
    expect(existsSync(join(dir, ".staging.codex-fixture"))).toBe(false);
  });
});
