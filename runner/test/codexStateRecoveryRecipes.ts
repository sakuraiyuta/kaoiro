import "../../scripts/test/fixtures/test-isolation.mjs";
import { expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStateFixture, interruptStateWorker, type StateFixture } from "./codexStateFixture.js";
import { makeReleaseTarball, revisionOf } from "./releaseFixture.js";

export const recovery: any = await import(pathToFileURL(join(import.meta.dirname, "../deploy/codex-state-recovery.mjs")).href);
const TOOL = revisionOf("n3-recovery-tool");
const TERMINAL = ["completed", "failed", "restored"];
const CREDENTIALS = ["auth.json", ".credentials.json", "secrets", "mcp-oauth-locks"];

// Observation outputs of the fixture and of these tests; everything else in
// the fixture directory, including the fake service state and its call log,
// is part of the zero-mutation digest.
export const EXCLUDED = ["queries", "activity-count", "cut-ready", "running-helper", "removal-observations", "child-env.jsonl", "start-record-phases", "start-phases"];
// Every digested root that EXCLUDED must not reach (fixture-relative).
export const PROTECTED = ["install", "install/releases", "install/codex-state", "install/.lock.update", "install/.lock.links", "codex", "backup", "upd", ".staging.codex-", ".failed.codex-", ".restore.codex-", "config", "ordinary", "active", "mainpid", "owned-pids", "fake-cgroup", "calls"];

export function digest(dir: string) {
  const entries: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (EXCLUDED.includes(path)) continue;
      const st = lstatSync(join(dir, path)), mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) entries.push(`${path} l ${mode} ${readlinkSync(join(dir, path))}`);
      else if (st.isDirectory()) { entries.push(`${path} d ${mode}`); walk(path); }
      else entries.push(`${path} f ${mode} ${st.size} ${createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")}`);
    }
  };
  walk("");
  return entries;
}

export type Run = { h: StateFixture; uuid: string; tx: () => any; saved: Record<string, unknown> };
type Activity = "active" | "inactive";
// The same branch or guard reached with the service in the other state. `prepare`
// runs before the baseline digest and outside the measured command; `mutating`
// variants change the fake service files themselves, so they run on a fresh
// fixture and their zero-mutation digest leaves out exactly SERVICE_PATHS.
type Variant = { prepare: (c: Run) => void; after: Activity; fresh?: boolean; mutating?: boolean };
type Recipe = {
  state: string;
  // The fake service's activity after the command, expected on its own and
  // never inferred from the calls it made.
  after: Activity;
  variants?: Record<string, Variant>;
  // Text of a fault the test injects; asserted instead of a table message.
  injected?: string;
  cmd?: string;
  setup?: (c: Run) => void;
  undo?: (c: Run) => void;
  line?: (c: Run) => string;
  activity?: [number, number | null];
  context?: string[];
  status?: number;
  shell?: boolean;
  // Raised by the guard inside the run's switch child: that child prints the
  // message only, and the run renders the hint for the state it leaves.
  nested?: boolean;
};

const ok = (r: { status: number | null; stderr: string }) => expect(r.status, r.stderr).toBe(0);
const forwardArgs = (h: StateFixture, name = "backup") => ["--install-dir", h.root, "--service", "kogane468-test", "--tarball", h.tarball(), "--codex-home", h.home, "--codex-backup-dir", join(h.dir, name)];
const restoreArgs = (h: StateFixture) => ["--install-dir", h.root, "--service", "kogane468-test", "--restore-codex-backup", join(h.dir, "backup"), "--codex-home", h.home];
const first = (h: StateFixture) => h.records().find(r => r.snapshot.path === join(h.dir, "backup"))!.uuid as string;
const cut = (args: (h: StateFixture) => string[], fault: Record<string, unknown>, before?: (h: StateFixture) => void) => async (h: StateFixture) => {
  before?.(h); await interruptStateWorker(h, args(h), fault); return first(h);
};
const done = (h: StateFixture) => { ok(h.forward()); return first(h); };
const startService = (h: StateFixture) => ok(spawnSync(h.ctl, ["--user", "start", "kogane468-test"], { env: h.env(), encoding: "utf8" }));
const stopService = (h: StateFixture) => ok(spawnSync(h.ctl, ["--user", "stop", "kogane468-test"], { env: h.env(), encoding: "utf8" }));
export const activate = (c: Run) => startService(c.h);
export const deactivate = (c: Run) => stopService(c.h);
// Fails the copy of any file into a restore staging directory, once triggered.
const restoreCopyFault = (h: StateFixture) => {
  const preload = join(h.dir, "fault-preload.mjs");
  writeFileSync(preload, readFileSync(preload, "utf8") + "\nconst restoreCopy=fs.copyFileSync;fs.copyFileSync=(from,to,...args)=>{if(String(to).includes('/.restore.codex-')&&fs.existsSync(dir+'/restore-copy-fault'))throw new Error('restore stage copy fault');return restoreCopy(from,to,...args)};syncBuiltinESMExports();\n");
  h.trigger("restore-copy-fault");
};
const copyFault = (h: StateFixture) => {
  const preload = join(h.dir, "fault-preload.mjs");
  writeFileSync(preload, readFileSync(preload, "utf8") + "\nconst copy=fs.copyFileSync;fs.copyFileSync=(from,to,...args)=>{if(String(to).includes('/.staging.codex-')&&fs.existsSync(dir+'/copy-fault'))throw new Error('copy fault');return copy(from,to,...args)};syncBuiltinESMExports();\n");
  h.trigger("copy-fault");
};
const cleanupFault = (h: StateFixture) => {
  const preload = join(h.dir, "fault-preload.mjs");
  writeFileSync(preload, readFileSync(preload, "utf8") + "\nconst savedRemove=fs.rmSync;fs.rmSync=(path,...args)=>{if(String(path).includes('/.staging.codex-')&&!fs.existsSync(dir+'/cleanup-failed')){fs.writeFileSync(dir+'/cleanup-failed','once');throw Error('cleanup interrupted')}return savedRemove(path,...args)};const savedCopy=fs.copyFileSync;fs.copyFileSync=(...args)=>{if(!fs.existsSync(dir+'/cleanup-failed'))throw Error('copy interrupted');return savedCopy(...args)};syncBuiltinESMExports();\n");
};
const sameNative = (h: StateFixture) => {
  const native = "node_modules/@openai/codex/vendor/fixture/bin/codex";
  return readFileSync(join(h.root, "releases", h.B, native), "utf8");
};

export const STATES: Record<string, (h: StateFixture) => Promise<string>> = {
  "fresh": async () => "",
  "prepared": cut(forwardArgs, { phase: "prepared", when: "after" }),
  "snapshot-verified": cut(forwardArgs, { phase: "snapshot-verified", when: "after" }),
  "start-intent": cut(forwardArgs, { phase: "start-intent", when: "after" }),
  "start-intent-target": async h => { await interruptStateWorker(h, forwardArgs(h), { promote: true }); startService(h); return first(h); },
  "completed": async h => done(h),
  "completed-retired": async h => { const uuid = done(h); ok(h.state("prune", h.root, uuid)); return uuid; },
  "completed-same-native": async h => { const uuid = done(h); h.replace(h.A, { "node_modules/@openai/codex/vendor/fixture/bin/codex": sameNative(h) }); return uuid; },
  "completed-pre-n2": async h => {
    const uuid = done(h), helper = readFileSync(join(h.root, "releases", h.A, "deploy/kaoiro-runner-codex-state.mjs"), "utf8");
    h.replace(h.A, { "node_modules/@openai/codex/vendor/fixture/bin/codex": sameNative(h), "deploy/kaoiro-runner-codex-state.mjs": helper.replace("export const CODEX_STATE_SCHEMA = 2;", "export const CODEX_STATE_SCHEMA = 1;") });
    return uuid;
  },
  "failed": async h => { const uuid = await cut(forwardArgs, { phase: "snapshot-verified", when: "after" })(h); ok(h.resume(uuid, "recover")); return uuid; },
  "failed-copy": async h => { copyFault(h); expect(h.forward().status).not.toBe(0); rmSync(join(h.dir, "copy-fault")); return first(h); },
  "failed-cleanup": async h => { cleanupFault(h); expect(h.forward().status).not.toBe(0); return first(h); },
  "restore-prepared": async h => { done(h); await interruptStateWorker(h, restoreArgs(h), { phase: "restore-prepared", when: "after" }); return first(h); },
  "replace-L1": async h => { done(h); await interruptStateWorker(h, restoreArgs(h), { from: "", when: "before" }); return first(h); },
  "replace-L2": async h => { done(h); await interruptStateWorker(h, restoreArgs(h), { from: "", when: "after" }); return first(h); },
  "replace-L3": async h => { done(h); await interruptStateWorker(h, restoreArgs(h), { phase: "replace-intent", startRequested: true, when: "after" }); return first(h); },
  "replace-L4": async h => { done(h); await interruptStateWorker(h, restoreArgs(h), { to: "/codex", when: "after" }); return first(h); },
};

// The fixture tool for every state is a distinct physical release, so the
// rendered `releases/<tool>/deploy` path differs from `current/deploy`.
export const fixture = (state: string) => createStateFixture({ toolId: state === "fresh" ? revisionOf("n3-install-tool") + "-dirty" : TOOL });

const toolDeploy = (h: StateFixture, tool = TOOL) => join(h.root, "releases", tool, "deploy");
const context = (h: StateFixture, tool = TOOL) => ({ root: h.root, deploy: toolDeploy(h, tool), interpreter: process.execPath });
const quoted = (argv: string[]) => argv.map(recovery.quote).join(" ");
const updater = (h: StateFixture, args: string[], tool = TOOL) => quoted([join(toolDeploy(h, tool), "kaoiro-runner-update.sh"), ...args]);
const switchLine = (h: StateFixture, args: string[]) => quoted([join(toolDeploy(h), "kaoiro-runner-switch.sh"), ...args]);
const move = (h: StateFixture, id: string) => { unlinkSync(join(h.root, "current")); symlinkSync(`releases/${id}`, join(h.root, "current")); };
const lock = (h: StateFixture, name: string) => mkdirSync(join(h.root, name), { mode: 0o700 });
const unlock = (h: StateFixture, name: string) => rmdirSync(join(h.root, name));
const env = (h: StateFixture, home: string) => writeFileSync(join(h.conf, "runner.env"), `CODEX_HOME='${home}'\n`, { mode: 0o600 });
const recordBytes = (c: Run) => { c.saved.record = readFileSync(c.h.recordPath(c.uuid)); };
const restoreRecord = (c: Run) => writeFileSync(c.h.recordPath(c.uuid), c.saved.record as Buffer, { mode: 0o600 });
const rewrite = (c: Run, change: (tx: any) => void) => { recordBytes(c); const tx = c.tx(); change(tx); writeFileSync(c.h.recordPath(c.uuid), JSON.stringify(tx), { mode: 0o600 }); };
// A second unfinished operation: a copy of the selected record, planned only.
const clone = (c: Run) => {
  const tx = c.tx(), uuid = randomUUID(), path = join(c.h.dir, "other-backup");
  const copy = { ...tx, uuid, phase: "prepared", snapshot: { path, staging: join(c.h.dir, `.staging.codex-${uuid}`), status: "planned" }, asides: [] };
  delete copy.cleanup; delete copy.replacement; delete copy.prune;
  writeFileSync(c.h.recordPath(uuid), JSON.stringify(copy), { mode: 0o600 }); c.saved.clone = uuid;
};
const unclone = (c: Run) => rmSync(c.h.recordPath(c.saved.clone as string));
const oldRecord = (c: Run) => {
  const dir = join(c.h.root, "codex-state/transactions");
  c.saved.oldDir = !existsSync(dir); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "old.json"), JSON.stringify({ phase: "prepared" }), { mode: 0o600 });
};
const unold = (c: Run) => { const dir = join(c.h.root, "codex-state/transactions"); rmSync(join(dir, "old.json")); if (c.saved.oldDir) rmdirSync(dir); };
const S13 = ["Transient", "ExecStart", "ExecStartPre", "ExecStartPost", "EnvironmentFiles", "PassEnvironment", "RootDirectory", "RootImage", "KillMode", "show-environment", "Environment", "UnsetEnvironment", "Id"];
const RA = ["ActiveState", "MainPID"], CAPTURE = [...S13, "MainPID", "ActiveState", "MainPID"];
const window = (from: number, to: number | null = from): [number, number | null] => [from, to];
const editControl = (h: StateFixture, from: string, to: string) => { const s = readFileSync(h.ctl, "utf8"); expect(s.includes(from)).toBe(true); writeFileSync(h.ctl, s.replace(from, to)); };

export const RECIPES: Record<string, Recipe> = {
  "P-RES-ok": { state: "prepared", after: "active" },
  "P-RES-copy": { state: "prepared", after: "active", setup: c => copyFault(c.h), variants: { inactive: { prepare: deactivate, after: "active" } } },
  "P-REC-ok": { state: "prepared", after: "active" },
  "P-RST-own": { state: "prepared", after: "active", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "P-PRN": { state: "prepared", after: "active" },
  "PS.stopped": { state: "prepared", after: "active", setup: c => c.h.trigger("late-populated") },
  "PS.snapshot-stopped": { state: "prepared", after: "active", activity: window(6) },
  "PS.snapshot-binding": { state: "prepared", after: "active", activity: window(7) },
  "PS.return-link": { state: "prepared", after: "inactive", setup: c => c.h.trigger("late-link", c.h.B) },
  "PS.return-binding": { state: "prepared", after: "inactive", setup: c => c.h.trigger("late-env", `CODEX_HOME='${c.h.ordinary}'\n`) },
  "PS.return-activity": { state: "prepared", after: "inactive", activity: window(6) },
  "V-RES-ok": { state: "snapshot-verified", after: "active" },
  "V-RES-stale": { state: "snapshot-verified", after: "active", setup: c => writeFileSync(join(c.h.home, "sessions/old.jsonl"), "BOOT-WRITE"), variants: { active: { prepare: activate, after: "active" } } },
  "V-REC-ok": { state: "snapshot-verified", after: "active" },
  "V-REC-missing": { state: "snapshot-verified", after: "active", setup: c => rmSync(join(c.h.dir, "backup"), { recursive: true }) },
  "V-RST-own": { state: "snapshot-verified", after: "inactive", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "V-PRN": { state: "snapshot-verified", after: "inactive" },
  "PS.guard-nested": { state: "snapshot-verified", after: "active", activity: window(7), nested: true },
  "S-RES-source": { state: "start-intent", after: "active" },
  "S-RES-target": { state: "start-intent-target", after: "active" },
  "S-RES-attest": { state: "start-intent", after: "active", setup: c => {
    const cli = readFileSync(join(c.h.root, "releases", c.h.B, "dist/cli.js"), "utf8");
    c.h.replace(c.h.B, { "dist/cli.js": cli.replace("...{}", `...{revision:${JSON.stringify(c.h.A)}}`), "node_modules/@openai/codex/vendor/fixture/bin/codex": sameNative(c.h) });
  } },
  "S-RES-stale": { state: "start-intent", after: "inactive", setup: c => writeFileSync(join(c.h.home, "sessions/old.jsonl"), "BOOT-WRITE"), nested: true },
  "S-REC-ok": { state: "start-intent", after: "active" },
  "S-REC-nosnap": { state: "start-intent", after: "inactive", setup: c => rewrite(c, tx => { tx.snapshot.status = "planned"; delete tx.snapshot.manifestHash; }), undo: restoreRecord },
  "S-RST-own": { state: "start-intent", after: "active", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "S-PRN": { state: "start-intent", after: "inactive" },
  "PS.guard-nested-intent": { state: "start-intent", after: "inactive", activity: window(5), nested: true },
  "PS.after-switch": { state: "start-intent", after: "inactive", activity: window(7) },
  "PS.post-start-active": { state: "start-intent", after: "inactive", setup: c => editControl(c.h, "fs.writeFileSync(dir+'/active','active'); child.unref();", "fs.writeFileSync(dir+'/active','inactive'); child.unref();") },
  "PS.post-start-binding": { state: "start-intent", after: "active", setup: c => { mkdirSync(join(c.h.dir, "other-home"), { mode: 0o700 }); editControl(c.h, `CODEX_HOME:${JSON.stringify(c.h.home)}`, `CODEX_HOME:${JSON.stringify(join(c.h.dir, "other-home"))}`); } },
  "T-noop": { state: "completed", after: "active", line: c => quoted(recovery.argv("RES", c.tx(), context(c.h))) },
  "T-RST-ok": { state: "completed", after: "active" },
  "T-RST-retired": { state: "completed-retired", after: "active", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "T-PRN": { state: "completed", after: "active" },
  "T-UPD": { state: "completed", after: "active", line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "T-RBK-ok": { state: "completed-same-native", after: "active" },
  "T-RBK-native": { state: "completed", after: "active" },
  "T-RBK-pre-n2": { state: "completed-pre-n2", after: "active" },
  "F-RES": { state: "failed", after: "active", line: c => quoted(recovery.argv("RES", c.tx(), context(c.h))) },
  "F-REC-ok": { state: "failed", after: "active" },
  "F-REC-moved": { state: "failed", after: "active", setup: c => move(c.h, c.h.B), undo: c => move(c.h, c.h.A) },
  "F-RST": { state: "failed", after: "active" },
  "F-PRN": { state: "failed", after: "active" },
  "F-PRN-cleanup": { state: "failed-cleanup", after: "active" },
  "F-UPD": { state: "failed-copy", after: "active", line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "R-RES-ok": { state: "restore-prepared", after: "active" },
  "R-RES-fail": { state: "restore-prepared", after: "inactive", setup: c => c.h.trigger("late-link", c.h.A) },
  "R-RES-stage-copy": { state: "restore-prepared", after: "active", setup: c => restoreCopyFault(c.h), injected: "restore stage copy fault", variants: { inactive: { prepare: deactivate, after: "inactive" } } },
  "R-REC-cancel": { state: "restore-prepared", after: "active" },
  "R-REC-moved": { state: "restore-prepared", after: "active", setup: c => move(c.h, c.h.A), undo: c => move(c.h, c.h.B) },
  "R-RST": { state: "restore-prepared", after: "active", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "R-PRN": { state: "restore-prepared", after: "active" },
  "PS.stage": { state: "restore-prepared", after: "active", activity: window(6) },
  "PS.replace-stopped": { state: "restore-prepared", after: "inactive", activity: window(8) },
  "PS.replace-binding": { state: "restore-prepared", after: "inactive", activity: window(9) },
  "PS.cancel-activity": { state: "restore-prepared", after: "active", activity: window(4) },
  "PS.catch-restore": { state: "restore-prepared", after: "inactive", setup: c => c.h.trigger("late-populated"), activity: window(7) },
  "Q-L1": { state: "replace-L1", after: "active" },
  "Q-L2": { state: "replace-L2", after: "active" },
  "Q-L3": { state: "replace-L3", after: "active" },
  "Q-L4": { state: "replace-L4", after: "active" },
  "Q-bad": { state: "replace-L3", after: "inactive", variants: { active: { prepare: activate, after: "inactive", fresh: true, mutating: true } }, setup: c => { const s = join(c.tx().replacement.staging, "sessions/old.jsonl"); c.saved.staging = readFileSync(s); writeFileSync(s, "CORRUPT-STAGING"); }, undo: c => writeFileSync(join(c.tx().replacement.staging, "sessions/old.jsonl"), c.saved.staging as Buffer) },
  "Q-cred": { state: "replace-L2", after: "inactive", variants: { active: { prepare: activate, after: "inactive", fresh: true, mutating: true } }, setup: c => writeFileSync(join(c.tx().replacement.staging, "auth.json"), "OTHER_TOKEN", { mode: 0o600 }), undo: c => rmSync(join(c.tx().replacement.staging, "auth.json")) },
  "Q-RST": { state: "replace-L3", after: "inactive", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "Q-PRN": { state: "replace-L3", after: "inactive" },
  "G1.run": { state: "prepared", after: "active", cmd: "RES", line: c => updater(c.h, ["--install-dir", c.h.root, "--resume-codex-transaction", c.uuid], c.h.B) },
  "G2.run": { state: "prepared", after: "active", cmd: "RES", setup: clone, undo: unclone },
  "G2.guard": { state: "prepared", after: "active", cmd: "RBK", setup: c => { clone(c); lock(c.h, ".lock.update"); }, undo: c => { unclone(c); unlock(c.h, ".lock.update"); }, line: c => switchLine(c.h, [c.h.B, "--install-dir", c.h.root, "--codex-transaction", c.uuid]) },
  "G2.prepare": { state: "prepared", after: "active", cmd: "UPD", line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "G2.restore": { state: "completed", after: "active", cmd: "RST", setup: clone, undo: unclone },
  "G2.prune": { state: "completed", after: "active", cmd: "PRN", setup: clone, undo: unclone },
  "G3.run": { state: "prepared", after: "active", cmd: "RES", setup: c => move(c.h, TOOL), undo: c => move(c.h, c.h.A) },
  "G3.guard": { state: "prepared", after: "active", cmd: "RBK", setup: c => { lock(c.h, ".lock.update"); move(c.h, TOOL); }, undo: c => { unlock(c.h, ".lock.update"); move(c.h, c.h.A); }, line: c => switchLine(c.h, [c.h.B, "--install-dir", c.h.root, "--codex-transaction", c.uuid]) },
  "G4.run-pre": { state: "prepared", after: "active", cmd: "RES", setup: c => env(c.h, c.h.ordinary), undo: c => env(c.h, c.h.home) },
  "G4.guard-entry": { state: "prepared", after: "active", cmd: "RBK", setup: c => { lock(c.h, ".lock.update"); env(c.h, c.h.ordinary); }, undo: c => { unlock(c.h, ".lock.update"); env(c.h, c.h.home); }, line: c => switchLine(c.h, [c.h.B, "--install-dir", c.h.root, "--codex-transaction", c.uuid]) },
  "G4.restore": { state: "completed", after: "active", cmd: "RST", line: c => quoted(recovery.argv("RST", { ...c.tx(), home: c.h.ordinary }, context(c.h))) },
  "G4.prepare": { state: "completed", after: "active", cmd: "UPD", setup: c => env(c.h, c.h.ordinary), undo: c => env(c.h, c.h.home), line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "G5.began": { state: "prepared", after: "active", cmd: "RES", activity: window(1), context: RA },
  "G5.binding-run": { state: "prepared", after: "active", cmd: "RES", activity: window(2), context: [...RA, ...S13, ...RA] },
  "G5.pre-stop": { state: "prepared", after: "active", cmd: "REC", activity: window(4), context: [...RA, ...S13, ...RA, ...CAPTURE, ...RA] },
  "G5.target-check": { state: "start-intent-target", after: "active", cmd: "RES", activity: window(4), context: [...RA, ...S13, ...RA, ...CAPTURE, ...RA] },
  "G5.resume-stop": { state: "prepared", after: "active", cmd: "RES", activity: window(4), context: [...RA, ...S13, ...RA, ...CAPTURE, ...RA] },
  "G6.helper": { state: "completed", after: "active", cmd: "PRN", setup: c => lock(c.h, ".lock.update"), undo: c => unlock(c.h, ".lock.update") },
  "G6.updater": { state: "prepared", after: "active", cmd: "RES", setup: c => lock(c.h, ".lock.update"), undo: c => unlock(c.h, ".lock.update"), status: 75, shell: true },
  "G6.switch-links": { state: "completed", after: "active", cmd: "RBK", setup: c => lock(c.h, ".lock.links"), undo: c => unlock(c.h, ".lock.links"), status: 75, shell: true },
  "G6.install-links": { state: "fresh", after: "active", cmd: "UPD", status: 75, shell: true,
    setup: c => { lock(c.h, ".lock.links"); const out = join(c.h.dir, "dirty-archive"); mkdirSync(out); c.saved.tarball = makeReleaseTarball(out, revisionOf("n3-install-tool"), { dirty: true }); },
    undo: c => { unlock(c.h, ".lock.links"); rmSync(join(c.h.dir, "dirty-archive"), { recursive: true }); },
    line: c => quoted([join(toolDeploy(c.h, revisionOf("n3-install-tool") + "-dirty"), "kaoiro-runner-install.sh"), c.saved.tarball as string, "--install-dir", c.h.root, "--allow-dirty"]) },
  "G7.guard": { state: "completed", after: "active", cmd: "RBK", setup: oldRecord, undo: unold },
  "G7.prepare": { state: "completed", after: "active", cmd: "UPD", setup: oldRecord, undo: unold, line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "G7.restore": { state: "completed", after: "active", cmd: "RST", setup: oldRecord, undo: unold, line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "G7.run": { state: "completed", after: "active", cmd: "REC", setup: oldRecord, undo: unold, line: c => quoted(recovery.argv("REC", c.tx(), context(c.h))) },
  "G7.prune": { state: "completed", after: "active", cmd: "PRN", setup: oldRecord, undo: unold, line: c => quoted(recovery.argv("PRN", c.tx(), context(c.h))) },
  "G7.protected": { state: "completed", after: "active", setup: oldRecord, undo: unold, line: c => quoted(["/bin/sh", "-c", 'deploy_dir=$1; shift; . "$deploy_dir/kaoiro-runner-common.sh"; kaoiro_codex_state "$@"', "protected", toolDeploy(c.h), "protected", c.h.root]) },
};

const layout = (c: Run, home: boolean, staging: boolean, aside: boolean) => {
  const r = c.tx().replacement;
  return existsSync(c.h.home) === home && existsSync(r.staging) === staging && existsSync(r.aside) === aside;
};
const nativeOf = (c: Run, id: string) => readFileSync(join(c.h.root, "releases", id, "node_modules/@openai/codex/vendor/fixture/bin/codex"), "utf8");
export const PRECONDITIONS: Record<string, (c: Run) => boolean> = {
  "current-source": c => c.h.current() === c.tx().source.id,
  "current-target": c => c.h.current() === c.tx().target.id && readFileSync(join(c.h.dir, "active"), "utf8") === "active",
  "current-from": c => c.h.current() === c.tx().replacement.from.id,
  "current-moved": c => c.h.current() !== c.tx().source.id,
  "state-equal": c => readFileSync(join(c.h.home, "sessions/old.jsonl"), "utf8") === "HISTORY",
  "state-differs": c => readFileSync(join(c.h.home, "sessions/old.jsonl"), "utf8") !== "HISTORY",
  "snapshot-missing": c => !existsSync(c.tx().snapshot.path),
  "snapshot-retained": c => c.tx().snapshot.status === "retained" && existsSync(c.tx().snapshot.path),
  "snapshot-unretained": c => c.tx().snapshot.status !== "retained",
  "snapshot-retired": c => c.tx().snapshot.status === "retired",
  "copy-fault": c => existsSync(join(c.h.dir, "copy-fault")) || (c.tx().phase === "failed" && c.tx().snapshot.status === "retired"),
  "cleanup-pending": c => c.tx().cleanup?.pending === true && existsSync(c.tx().cleanup.path),
  "late-populated": c => existsSync(join(c.h.dir, "late-populated")),
  "late-home": c => existsSync(join(c.h.dir, "late-env")),
  "late-link": c => existsSync(join(c.h.dir, "late-link")),
  // The fake service runs as its owned child: the controller's start recorded
  // the main pid and its owned-pid marker, not just the `active` file.
  "owned-service": c => readFileSync(join(c.h.dir, "active"), "utf8") === "active" && existsSync(join(c.h.dir, "mainpid")) && readdirSync(join(c.h.dir, "owned-pids")).length > 0,
  "stage-copy-fault": c => existsSync(join(c.h.dir, "restore-copy-fault")) && c.h.current() === c.tx().replacement.from.id,
  "activity-window": c => existsSync(join(c.h.dir, "activity-fault")),
  "attest-fault": c => !readFileSync(join(c.h.root, "releases", c.h.B, "dist/cli.js"), "utf8").includes("...{}"),
  "no-start": c => readFileSync(c.h.ctl, "utf8").includes("fs.writeFileSync(dir+'/active','inactive'); child.unref();"),
  "bad-live": c => readFileSync(c.h.ctl, "utf8").includes(join(c.h.dir, "other-home")),
  "layout-L1": c => layout(c, true, true, false) && !c.tx().replacement.startRequested,
  "layout-L2": c => layout(c, false, true, true) && !c.tx().replacement.startRequested,
  "layout-L3": c => layout(c, false, true, true) && c.tx().replacement.startRequested,
  "layout-L4": c => layout(c, true, false, true) && c.tx().replacement.startRequested,
  "staging-corrupt": c => readFileSync(join(c.tx().replacement.staging, "sessions/old.jsonl"), "utf8") === "CORRUPT-STAGING",
  "credential-both": c => existsSync(join(c.tx().replacement.staging, "auth.json")) && existsSync(join(c.tx().replacement.aside, "auth.json")),
  "same-native": c => nativeOf(c, c.h.A) === nativeOf(c, c.h.B),
  "differing-native": c => nativeOf(c, c.h.A) !== nativeOf(c, c.h.B),
  "pre-n2-target": c => !/^export const CODEX_STATE_SCHEMA = 2;$/m.test(readFileSync(join(c.h.root, "releases", c.h.A, "deploy/kaoiro-runner-codex-state.mjs"), "utf8")),
};

// The rendered line is split into argv by a real shell, then run directly so
// that the test-isolation boundary sees which program it starts.
export function argvOf(line: string) {
  const r = spawnSync("/bin/sh", ["-c", 'eval "set -- $1"; printf "%s\\0" "$@"', "parse", line], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\0").slice(0, -1);
}
const declared = (id: string) => recovery.branches().find((x: any) => x.id === id) ?? recovery.GUARDS.find((g: any) => g.id === id);
const lineFor = (c: Run, key: string) => {
  const tx = c.tx(), r = c.h.state("next", c.h.root, ...(TERMINAL.includes(tx.phase) ? [tx.uuid] : []));
  expect(r.status, r.stderr).toBe(0);
  const lines = r.stdout.split("\n").map(l => l.trim()), at = lines.indexOf(`${tx.uuid} ${tx.phase}`), label = `next (${recovery.LABELS[key]}): `;
  expect(at, r.stdout).toBeGreaterThanOrEqual(0);
  const rendered = lines.slice(at + 1).find(l => l.startsWith(label) || /^[0-9a-f-]{36} /.test(l));
  return rendered?.startsWith(label) ? rendered.slice(label.length) : quoted(recovery.argv(key, tx, context(c.h)));
};

// A case is a branch or guard id, or `id:variant` for the same site reached
// with the service in another state.
export const split = (label: string): [string, string] => { const i = label.indexOf(":"); return i < 0 ? [label, "default"] : [label.slice(0, i), label.slice(i + 1)]; };

// The two fake service files that an observed `stop` rewrites; a mutating
// variant's digest leaves exactly these out and nothing else.
export const SERVICE_PATHS = ["active", "calls"];
export class DigestMismatch extends Error { constructor(readonly paths: string[], message: string) { super(message); } }
// Paths whose digest entries differ once `ignore` is left out of both lists.
export function digestChanges(before: string[], after: string[], ignore: string[] = []) {
  const keyed = (entries: string[]) => new Map(entries.map(e => [e.slice(0, e.indexOf(" ")), e] as const).filter(([path]) => !ignore.includes(path)));
  const [x, y] = [keyed(before), keyed(after)];
  return [...new Set([...x.keys(), ...y.keys()])].filter(path => x.get(path) !== y.get(path)).sort();
}

// Compares one run with its declared service cell. The log after the run must
// extend the log before it, and the whole new suffix must be the declared
// operation, so an unknown, extra or incomplete line is a mismatch.
export function serviceProblems(service: { before: string; op: string }, seen: { callsBefore: string; callsAfter: string; activeBefore: string; activeAfter: string }, expectedAfter: string) {
  const problems: string[] = [];
  if (!Object.hasOwn(recovery.SERVICE_OPS, service.op)) return [`unknown operation ${service.op}`];
  if (seen.activeBefore !== service.before) problems.push(`initial activity ${seen.activeBefore}, declared ${service.before}`);
  if (!seen.callsAfter.startsWith(seen.callsBefore)) problems.push("the call log after the run does not extend the log before it");
  else {
    const suffix = seen.callsAfter.slice(seen.callsBefore.length), declared = (recovery.SERVICE_OPS[service.op] as string[]).map(call => `${call}\n`).join("");
    if (suffix !== declared) problems.push(`calls ${JSON.stringify(suffix)}, declared ${service.op} ${JSON.stringify(declared)}`);
  }
  if (seen.activeAfter !== expectedAfter) problems.push(`final activity ${seen.activeAfter}, expected ${expectedAfter}`);
  return problems;
}

// Reaches nothing: runs one declared branch or guard on a reached state and
// checks its outcome, hint, service calls and side effects against the declaration.
export async function drive(label: string, c: Run, extra: { prepare?: (c: Run) => void } = {}) {
  const [id, variant] = split(label), decl = declared(id), recipe = RECIPES[id]!, h = c.h;
  const v = variant === "default" ? undefined : recipe.variants![variant]!, service = decl.service[variant], expectedAfter = v?.after ?? recipe.after;
  const cmd = recipe.cmd ?? decl.cmds?.[0];
  // Preparation is outside the baseline digest and the measured command.
  v?.prepare(c); extra.prepare?.(c);
  const before = c.uuid ? c.tx() : undefined, starts = h.callLog().split("start").length;
  const outcome = decl.outcome ?? "refuse", tree = digest(h.dir);
  const asides = (before?.asides ?? []).map((e: any) => e.aside).filter((p: string) => existsSync(p));
  // The line is rendered before the perturbation, as an operator reads it.
  const rendered = recipe.line ? undefined : lineFor(c, cmd);
  recipe.setup?.(c);
  if (recipe.activity) writeFileSync(join(h.dir, "activity-fault"), JSON.stringify({ from: recipe.activity[0], to: recipe.activity[1] }));
  let r!: ReturnType<typeof spawnSync>, after: any, out = label;
  // Undo runs even when an assertion fails, so one red case cannot leave
  // its perturbation on the state that the next refusal reuses.
  try {
    if (decl.pre) expect(PRECONDITIONS[decl.pre]!(c), `${label}: precondition ${decl.pre}`).toBe(true);
    if (service.pre) expect(PRECONDITIONS[service.pre]!(c), `${label}: service precondition ${service.pre}`).toBe(true);
    const line = recipe.line?.(c) ?? rendered!;
    rmSync(join(h.dir, "queries"), { force: true }); rmSync(join(h.dir, "activity-count"), { force: true });
    const [file, ...args] = argvOf(line);
    // Read the fixture's files directly: the observation makes no service query.
    const seen = { callsBefore: h.callLog(), activeBefore: readFileSync(join(h.dir, "active"), "utf8"), callsAfter: "", activeAfter: "" };
    r = spawnSync(file!, args, { env: h.env(), encoding: "utf8" });
    seen.callsAfter = h.callLog(); seen.activeAfter = readFileSync(join(h.dir, "active"), "utf8");
    after = c.uuid ? c.tx() : undefined; out = `${label}\n${line}\n${r.stderr}`;
    rmSync(join(h.dir, "activity-fault"), { force: true });
    for (const name of ["late-populated", "late-env", "late-link"]) rmSync(join(h.dir, name), { force: true });
    expect(serviceProblems(service, seen, expectedAfter), out).toEqual([]);
    if (recipe.status !== undefined) expect(r.status, out).toBe(recipe.status);
    else if (["refuse", "held", "settle"].includes(outcome)) expect(r.status, out).not.toBe(0);
    else expect(r.status, out).toBe(0);
    if (after) {
      if (outcome === "settle") { expect(after.phase, out).toBe("failed"); expect(h.callLog().split("start").length, out).toBe(starts + 1); expect(readFileSync(join(h.dir, "start-record-phases"), "utf8").trim().split("\n").at(-1)!.split(","), out).toContain("failed"); }
      else if (outcome === "held") expect(after.phase, out).toBe(decl.final ?? before.phase);
      else if (["refuse", "noop"].includes(outcome)) expect(after.phase, out).toBe(before.phase);
      else expect(after.phase, out).toBe(outcome);
    }
    const messages: string[] = decl.messages ?? (decl.message ? [decl.message] : []);
    if (messages.length) expect(messages.some(m => recovery.keyPattern("${}" + m + "${}").test(r.stderr)), out).toBe(true);
    if (recipe.injected) expect(r.stderr, out).toContain(recipe.injected);
    const cls = decl.class;
    if (cls && !recipe.shell) {
      const record = messages[0]?.startsWith("Unresolved") ? h.records().find((x: any) => r.stderr.includes(`requires recovery: ${x.uuid}`)) : after;
      for (const l of recovery.render(recipe.nested ? "unclassified" : cls, { tx: record, ...context(h) })) expect(r.stderr, out).toContain(`codex-state: ${l}`);
    }
    // A settled record is not resumed by rerunning the same command.
    if (after && TERMINAL.includes(after.phase)) expect(r.stderr, out).not.toContain(recovery.render("transient")[0]);
    if (cls === "lock" && recipe.shell) { expect(r.stderr, out).toContain(`see: ${recovery.ANCHORS.lock}`); if (before && !TERMINAL.includes(before.phase)) expect(r.stderr, out).toContain(`${c.uuid} ${before.phase}`); }
    if (recipe.context) {
      const queries = readFileSync(join(h.dir, "queries"), "utf8").trim().split("\n");
      expect(queries.slice(0, recipe.context.length), `${out}\nsite context`).toEqual(recipe.context);
      expect(queries.filter(q => q === "ActiveState").length, out).toBeGreaterThanOrEqual(recipe.activity![0]);
    }
  } finally {
    recipe.undo?.(c);
    rmSync(join(h.dir, "activity-fault"), { force: true });
    for (const name of ["late-populated", "late-env", "late-link"]) rmSync(join(h.dir, name), { force: true });
  }
  if (outcome === "refuse") {
    if (v?.mutating) {
      const changed = digestChanges(tree, digest(h.dir), SERVICE_PATHS);
      if (changed.length) throw new DigestMismatch(changed, `${out}\nzero-mutation digest differs outside the service files: ${changed.join(", ")}`);
    } else expect(digest(h.dir), out).toEqual(tree);
  }
  if (after) invariants(c, after, asides, out);
  return r;
}

// Asides are never removed, each credential has one location, and no
// unrecorded staging remains.
function invariants(c: Run, tx: any, asides: string[], out: string) {
  const h = c.h;
  for (const aside of asides) expect(existsSync(aside), `${out}
aside removed: ${aside}`).toBe(true);
  for (const name of CREDENTIALS) {
    const places = [h.home, tx.replacement?.staging, tx.replacement?.aside].filter(Boolean).filter(p => existsSync(join(p, name)));
    if (existsSync(h.home) || tx.replacement) expect(places.length, `${out}\n${name}: ${places}`).toBe(1);
  }
  const named = new Set(h.records().flatMap((x: any) => [x.snapshot.staging, x.cleanup?.pending ? x.cleanup.path : undefined, x.replacement?.staging].filter(Boolean)));
  for (const name of readdirSync(h.dir)) if (/^\.(staging|restore)\.codex-/.test(name)) expect(named.has(join(h.dir, name)), `${out}\nunrecorded ${name}`).toBe(true);
  if (tx.phase === "restored" && tx.replacement) expect(tx.replacement.startRequested, out).toBe(true);
}

// Layer 2 runs in three files: forward progress, restore and terminal
// progress, and every refusal (branches and guard sites) on shared states.
export function partition(label: string) {
  const decl = declared(split(label)[0]);
  if (decl.outcome === undefined || decl.outcome === "refuse") return 3;
  return ["prepared", "snapshot-verified", "start-intent"].includes(decl.phase) ? 1 : 2;
}
export const labels = () => [...recovery.branches().filter((x: any) => !x.guard).map((x: any) => x.id as string), ...recovery.GUARDS.map((g: any) => g.id as string)]
  .flatMap(id => [id, ...Object.keys(RECIPES[id]?.variants ?? {}).map(v => `${id}:${v}`)]);
export const ids = (part: number) => labels().filter(label => partition(label) === part);
export const stateOf = (label: string) => RECIPES[split(label)[0]]!.state;
export const isFresh = (label: string) => split(label)[1] !== "default" && RECIPES[split(label)[0]]!.variants![split(label)[1]]!.fresh === true;
export async function reach(state: string): Promise<Run> {
  const h = await fixture(state), uuid = await STATES[state]!(h);
  return { h, uuid, tx: () => h.records().find((x: any) => x.uuid === uuid), saved: {} };
}
