import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { interruptStateWorker } from "./codexStateFixture.js";
import { RECIPES, digest, drive, ids, reach, recovery, type Run } from "./codexStateRecoveryRecipes.js";

const executed: string[] = [];
const groups = new Map<string, string[]>();
for (const id of ids(3)) groups.set(RECIPES[id]!.state, [...(groups.get(RECIPES[id]!.state) ?? []), id]);

describe.skipIf(process.platform !== "linux")("N3 recovery property: refusals and guard sites", { timeout: 90_000 }, () => {
  for (const [state, list] of groups) describe(state, () => {
    let c: Run;
    beforeAll(async () => { c = await reach(state); }, 90_000);
    afterAll(async () => { await c?.h.close(); });
    it.each(list)("refuses %s with zero mutation and its rendered hint", async id => { await drive(id, c); executed.push(id); });
  });
  it("executed exactly the declared refusals and guard sites", () => {
    expect([...executed].sort()).toEqual(ids(3).sort());
  });
  it("renders an unclassified read failure with the record's lines and the table anchor", async () => {
    const c = await reach("prepared");
    try {
      const preload = join(c.h.dir, "fault-preload.mjs");
      writeFileSync(preload, readFileSync(preload, "utf8") + "\nconst lst=fs.lstatSync;fs.lstatSync=(p,...a)=>{if(String(p).includes('/v2/records/')&&fs.existsSync(dir+'/eio-once')){fs.unlinkSync(dir+'/eio-once');const e=new Error('EIO: i/o error, lstat');e.code='EIO';throw e;}return lst(p,...a)};syncBuiltinESMExports();\n");
      const tree = digest(c.h.dir);
      c.h.trigger("eio-once");
      const r = c.h.resume(c.uuid);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("codex-state: EIO: i/o error, lstat");
      expect(r.stderr).toContain(`codex-state: see: ${recovery.ANCHORS.table}`);
      const context = { root: c.h.root, deploy: join(c.h.root, "releases", c.tx().tool, "deploy"), interpreter: process.execPath };
      for (const line of recovery.rowLines(c.tx(), context)) expect(r.stderr).toContain(`codex-state: ${line}`);
      expect(digest(c.h.dir)).toEqual(tree);
    } finally { await c.h.close(); }
  });
  it("lists a record while its worker is paused at a record checkpoint", async () => {
    const c = await reach("fresh");
    try {
      let listed = "";
      const args = ["--install-dir", c.h.root, "--service", "kogane468-test", "--tarball", c.h.tarball(), "--codex-home", c.h.home, "--codex-backup-dir", join(c.h.dir, "backup")];
      await interruptStateWorker(c.h, args, { phase: "snapshot-verified", when: "after" }, undefined, () => {
        const r = c.h.state("next", c.h.root); expect(r.status, r.stderr).toBe(0); listed = r.stdout;
      });
      const uuid = c.h.records()[0]!.uuid;
      expect(listed).toContain(`${uuid} snapshot-verified`);
      expect(listed).toContain(`lock present: ${join(c.h.root, ".lock.update")}`);
      expect(listed.trim().split("\n").at(-1)).toBe(`see: ${recovery.ANCHORS.lock}`);
    } finally { await c.h.close(); }
  });
});
