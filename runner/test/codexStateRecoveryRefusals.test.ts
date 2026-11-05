import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { interruptStateWorker } from "./codexStateFixture.js";
import { digest, drive, EXCLUDED, PROTECTED, ids, isFresh, reach, recovery, stateOf, type Run } from "./codexStateRecoveryRecipes.js";

const executed: string[] = [];
const groups = new Map<string, string[]>();
for (const id of ids(3).filter(label => !isFresh(label))) groups.set(stateOf(id), [...(groups.get(stateOf(id)) ?? []), id]);

describe.skipIf(process.platform !== "linux")("N3 recovery property: refusals and guard sites", { timeout: 90_000 }, () => {
  for (const [state, list] of groups) describe(state, () => {
    let c: Run;
    beforeAll(async () => { c = await reach(state); }, 90_000);
    afterAll(async () => { await c?.h.close(); });
    it.each(list)("refuses %s with zero mutation and its rendered hint", async id => { await drive(id, c); executed.push(id); });
  });
  // A variant that changes the service files runs alone, on its own fixture.
  it.each(ids(3).filter(isFresh))("refuses %s with zero mutation outside the service files and its rendered hint", async id => {
    const c = await reach(stateOf(id));
    try { await drive(id, c); executed.push(id); } finally { await c.h.close(); }
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
      expect(r.stderr).not.toContain("stop external same-home writers");
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

describe("Codex recovery table: rendering", () => {
  const { PHASES, LABELS } = recovery;
  const expected: Record<string, string[]> = { prepared: ["RES", "REC"], "snapshot-verified": ["RES", "REC"], "start-intent": ["RES", "REC"], completed: ["RST", "PRN", "RBK"], failed: ["REC", "RST", "PRN", "RBK"], "restore-prepared": ["RES", "REC"], "replace-intent": ["RES", "REC"], restored: ["RST", "PRN", "RBK"] };
  const options: Record<string, string> = { RES: "--resume-codex-transaction", REC: "--recover-codex-transaction", RST: "--restore-codex-backup", PRN: "prune", RBK: "--rollback" };
  const root = "/srv/it's a root", self = join(root, "releases/b".repeat(1), "deploy");
  it("retains the known phases", () => { expect(PHASES).toEqual(Object.keys(expected)); });
  const record = (phase: string) => ({ uuid: "0f8b2a4c-1d2e-4f3a-8b9c-0123456789ab", phase, tool: "t".repeat(40), service: "kaoiro-runner.service", home: "/h/o'me", snapshot: { path: "/b/snap", status: "retained" }, cleanup: { pending: true } });
  it.each(PHASES as string[])("renders each %s entry with its own option, tool and record", (phase: string) => {
    const tx = record(phase), context = { root, deploy: self, interpreter: "/usr/bin/node" };
    const keys = recovery.entries(tx);
    expect(keys).toEqual(expected[phase]);
    for (const key of keys) {
      const argv = recovery.argv(key, tx, context), line = recovery.rowLines(tx, context, [key])[0]!;
      expect(line.startsWith(`next (${LABELS[key]}): `)).toBe(true);
      expect(argv).toContain(options[key]);
      if (["RES", "REC"].includes(key)) expect(argv[0]).toBe(join(root, "releases", tx.tool, "deploy/kaoiro-runner-update.sh"));
      else if (key === "PRN") expect(argv.slice(0, 2)).toEqual(["/usr/bin/node", join(self, "kaoiro-runner-codex-state.mjs")]);
      else expect(argv[0]!.startsWith(self + "/")).toBe(true);
      if (["RES", "REC", "PRN"].includes(key)) expect(argv.at(-1)).toBe(tx.uuid);
      const shell = spawnSync("/bin/sh", ["-c", 'eval "set -- $1"; printf "%s\\n" "$@"', "parse", line.slice(line.indexOf(": ") + 2)], { encoding: "utf8" });
      expect(shell.stdout).toBe(argv.map((a: string) => a + "\n").join(""));
    }
  });
  it("offers restore and prune only for a retained snapshot or pending cleanup", () => {
    const tx = { ...record("completed"), snapshot: { path: "/b/snap", status: "retired" }, cleanup: undefined };
    expect(recovery.entries(tx)).toEqual(["RBK"]);
    expect(recovery.entries({ ...tx, cleanup: { pending: true } })).toEqual(["PRN", "RBK"]);
  });
});


describe("Codex recovery guidance", () => {
  it("names only anchors that exist", () => {
    const repo = join(import.meta.dirname, "../..");
    const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
    for (const anchor of Object.values(recovery.ANCHORS) as string[]) {
      const [file, id] = anchor.split("#") as [string, string];
      const headings = readFileSync(join(repo, file), "utf8").split("\n").filter(l => /^#+ /.test(l)).map(l => slug(l.replace(/^#+ /, "")));
      expect(headings, anchor).toContain(id);
    }
  });
  it("never excludes protected state from the zero-mutation digest", () => {
    for (const path of EXCLUDED) for (const root of PROTECTED) expect(path === root || path.startsWith(root.endsWith("-") ? root : root + "/"), `${path} under ${root}`).toBe(false);
  });
  it("prints the record commands on a restore configuration refusal", async () => {
    const c = await reach("completed");
    try {
      const r = await drive("G4.restore", c);
      for (const label of ["restore", "prune", "rollback"]) expect(r.stderr).toContain(`next (${label}):`);
    } finally { await c.h.close(); }
  });
  it("prints the safety line once after an inner refusal settles", async () => {
    const c = await reach("snapshot-verified");
    try {
      const r = await drive("PS.guard-nested", c);
      expect(String(r.stderr).match(/Preserve named home, snapshot, staging and aside objects/g)).toHaveLength(1);
    } finally { await c.h.close(); }
  });
});
