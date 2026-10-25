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
type Recipe = {
  state: string;
  cmd?: string;
  setup?: (c: Run) => void;
  undo?: (c: Run) => void;
  line?: (c: Run) => string;
  activity?: [number, number | null];
  context?: string[];
  status?: number;
  shell?: boolean;
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
  "P-RES-ok": { state: "prepared" },
  "P-RES-copy": { state: "prepared", setup: c => copyFault(c.h) },
  "P-REC-ok": { state: "prepared" },
  "P-RST-own": { state: "prepared", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "P-PRN": { state: "prepared" },
  "PS.stopped": { state: "prepared", setup: c => c.h.trigger("late-populated") },
  "PS.snapshot-stopped": { state: "prepared", activity: window(6) },
  "PS.snapshot-binding": { state: "prepared", activity: window(7) },
  "PS.return-link": { state: "prepared", setup: c => c.h.trigger("late-link", c.h.B) },
  "PS.return-binding": { state: "prepared", setup: c => c.h.trigger("late-env", `CODEX_HOME='${c.h.ordinary}'\n`) },
  "PS.return-activity": { state: "prepared", activity: window(6) },
  "V-RES-ok": { state: "snapshot-verified" },
  "V-RES-stale": { state: "snapshot-verified", setup: c => writeFileSync(join(c.h.home, "sessions/old.jsonl"), "BOOT-WRITE") },
  "V-REC-ok": { state: "snapshot-verified" },
  "V-REC-missing": { state: "snapshot-verified", setup: c => rmSync(join(c.h.dir, "backup"), { recursive: true }) },
  "V-RST-own": { state: "snapshot-verified", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "V-PRN": { state: "snapshot-verified" },
  "PS.guard-nested": { state: "snapshot-verified", activity: window(7) },
  "S-RES-source": { state: "start-intent" },
  "S-RES-target": { state: "start-intent-target" },
  "S-RES-attest": { state: "start-intent", setup: c => {
    const cli = readFileSync(join(c.h.root, "releases", c.h.B, "dist/cli.js"), "utf8");
    c.h.replace(c.h.B, { "dist/cli.js": cli.replace("...{}", `...{revision:${JSON.stringify(c.h.A)}}`), "node_modules/@openai/codex/vendor/fixture/bin/codex": sameNative(c.h) });
  } },
  "S-RES-stale": { state: "start-intent", setup: c => writeFileSync(join(c.h.home, "sessions/old.jsonl"), "BOOT-WRITE") },
  "S-REC-ok": { state: "start-intent" },
  "S-REC-nosnap": { state: "start-intent", setup: c => rewrite(c, tx => { tx.snapshot.status = "planned"; delete tx.snapshot.manifestHash; }), undo: restoreRecord },
  "S-RST-own": { state: "start-intent", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "S-PRN": { state: "start-intent" },
  "PS.guard-nested-intent": { state: "start-intent", activity: window(5) },
  "PS.after-switch": { state: "start-intent", activity: window(7) },
  "PS.post-start-active": { state: "start-intent", setup: c => editControl(c.h, "fs.writeFileSync(dir+'/active','active'); child.unref();", "fs.writeFileSync(dir+'/active','inactive'); child.unref();") },
  "PS.post-start-binding": { state: "start-intent", setup: c => { mkdirSync(join(c.h.dir, "other-home"), { mode: 0o700 }); editControl(c.h, `CODEX_HOME:${JSON.stringify(c.h.home)}`, `CODEX_HOME:${JSON.stringify(join(c.h.dir, "other-home"))}`); } },
  "T-noop": { state: "completed", line: c => quoted(recovery.argv("RES", c.tx(), context(c.h))) },
  "T-RST-ok": { state: "completed" },
  "T-RST-retired": { state: "completed-retired", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "T-PRN": { state: "completed" },
  "T-UPD": { state: "completed", line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "T-RBK-ok": { state: "completed-same-native" },
  "T-RBK-native": { state: "completed" },
  "T-RBK-pre-n2": { state: "completed-pre-n2" },
  "F-RES": { state: "failed", line: c => quoted(recovery.argv("RES", c.tx(), context(c.h))) },
  "F-REC-ok": { state: "failed" },
  "F-REC-moved": { state: "failed", setup: c => move(c.h, c.h.B), undo: c => move(c.h, c.h.A) },
  "F-RST": { state: "failed" },
  "F-PRN": { state: "failed" },
  "F-PRN-cleanup": { state: "failed-cleanup" },
  "F-UPD": { state: "failed-copy", line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "R-RES-ok": { state: "restore-prepared" },
  "R-RES-fail": { state: "restore-prepared", setup: c => c.h.trigger("late-link", c.h.A) },
  "R-REC-cancel": { state: "restore-prepared" },
  "R-REC-moved": { state: "restore-prepared", setup: c => move(c.h, c.h.A), undo: c => move(c.h, c.h.B) },
  "R-RST": { state: "restore-prepared", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "R-PRN": { state: "restore-prepared" },
  "PS.stage": { state: "restore-prepared", activity: window(6) },
  "PS.replace-stopped": { state: "restore-prepared", activity: window(8) },
  "PS.replace-binding": { state: "restore-prepared", activity: window(9) },
  "PS.cancel-activity": { state: "restore-prepared", activity: window(4) },
  "PS.catch-restore": { state: "restore-prepared", setup: c => c.h.trigger("late-populated"), activity: window(7) },
  "Q-L1": { state: "replace-L1" },
  "Q-L2": { state: "replace-L2" },
  "Q-L3": { state: "replace-L3" },
  "Q-L4": { state: "replace-L4" },
  "Q-bad": { state: "replace-L3", setup: c => { const s = join(c.tx().replacement.staging, "sessions/old.jsonl"); c.saved.staging = readFileSync(s); writeFileSync(s, "CORRUPT-STAGING"); }, undo: c => writeFileSync(join(c.tx().replacement.staging, "sessions/old.jsonl"), c.saved.staging as Buffer) },
  "Q-cred": { state: "replace-L2", setup: c => writeFileSync(join(c.tx().replacement.staging, "auth.json"), "OTHER_TOKEN", { mode: 0o600 }), undo: c => rmSync(join(c.tx().replacement.staging, "auth.json")) },
  "Q-RST": { state: "replace-L3", line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "Q-PRN": { state: "replace-L3" },
  "G1.run": { state: "prepared", cmd: "RES", line: c => updater(c.h, ["--install-dir", c.h.root, "--resume-codex-transaction", c.uuid], c.h.B) },
  "G2.run": { state: "prepared", cmd: "RES", setup: clone, undo: unclone },
  "G2.guard": { state: "prepared", cmd: "RBK", setup: c => { clone(c); lock(c.h, ".lock.update"); }, undo: c => { unclone(c); unlock(c.h, ".lock.update"); }, line: c => switchLine(c.h, [c.h.B, "--install-dir", c.h.root, "--codex-transaction", c.uuid]) },
  "G2.prepare": { state: "prepared", cmd: "UPD", line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "G2.restore": { state: "completed", cmd: "RST", setup: clone, undo: unclone },
  "G2.prune": { state: "completed", cmd: "PRN", setup: clone, undo: unclone },
  "G3.run": { state: "prepared", cmd: "RES", setup: c => move(c.h, TOOL), undo: c => move(c.h, c.h.A) },
  "G3.guard": { state: "prepared", cmd: "RBK", setup: c => { lock(c.h, ".lock.update"); move(c.h, TOOL); }, undo: c => { unlock(c.h, ".lock.update"); move(c.h, c.h.A); }, line: c => switchLine(c.h, [c.h.B, "--install-dir", c.h.root, "--codex-transaction", c.uuid]) },
  "G4.run-pre": { state: "prepared", cmd: "RES", setup: c => env(c.h, c.h.ordinary), undo: c => env(c.h, c.h.home) },
  "G4.guard-entry": { state: "prepared", cmd: "RBK", setup: c => { lock(c.h, ".lock.update"); env(c.h, c.h.ordinary); }, undo: c => { unlock(c.h, ".lock.update"); env(c.h, c.h.home); }, line: c => switchLine(c.h, [c.h.B, "--install-dir", c.h.root, "--codex-transaction", c.uuid]) },
  "G4.restore": { state: "completed", cmd: "RST", line: c => quoted(recovery.argv("RST", { ...c.tx(), home: c.h.ordinary }, context(c.h))) },
  "G4.prepare": { state: "completed", cmd: "UPD", setup: c => env(c.h, c.h.ordinary), undo: c => env(c.h, c.h.home), line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "G5.began": { state: "prepared", cmd: "RES", activity: window(1, null), context: RA },
  "G5.binding-run": { state: "prepared", cmd: "RES", activity: window(2, null), context: [...RA, ...S13, ...RA] },
  "G5.pre-stop": { state: "prepared", cmd: "REC", activity: window(4, null), context: [...RA, ...S13, ...RA, ...CAPTURE, ...RA] },
  "G5.target-check": { state: "start-intent-target", cmd: "RES", activity: window(4, null), context: [...RA, ...S13, ...RA, ...CAPTURE, ...RA] },
  "G5.resume-stop": { state: "prepared", cmd: "RES", activity: window(4, null), context: [...RA, ...S13, ...RA, ...CAPTURE, ...RA] },
  "G6.helper": { state: "completed", cmd: "PRN", setup: c => lock(c.h, ".lock.update"), undo: c => unlock(c.h, ".lock.update") },
  "G6.updater": { state: "prepared", cmd: "RES", setup: c => lock(c.h, ".lock.update"), undo: c => unlock(c.h, ".lock.update"), status: 75, shell: true },
  "G6.switch-links": { state: "completed", cmd: "RBK", setup: c => lock(c.h, ".lock.links"), undo: c => unlock(c.h, ".lock.links"), status: 75, shell: true },
  "G6.install-links": { state: "fresh", cmd: "UPD", status: 75, shell: true,
    setup: c => { lock(c.h, ".lock.links"); const out = join(c.h.dir, "dirty-archive"); mkdirSync(out); c.saved.tarball = makeReleaseTarball(out, revisionOf("n3-install-tool"), { dirty: true }); },
    undo: c => { unlock(c.h, ".lock.links"); rmSync(join(c.h.dir, "dirty-archive"), { recursive: true }); },
    line: c => quoted([join(toolDeploy(c.h, revisionOf("n3-install-tool") + "-dirty"), "kaoiro-runner-install.sh"), c.saved.tarball as string, "--install-dir", c.h.root, "--allow-dirty"]) },
  "G7.guard": { state: "completed", cmd: "RBK", setup: oldRecord, undo: unold },
  "G7.prepare": { state: "completed", cmd: "UPD", setup: oldRecord, undo: unold, line: c => updater(c.h, forwardArgs(c.h, "upd")) },
  "G7.restore": { state: "completed", cmd: "RST", setup: oldRecord, undo: unold, line: c => quoted(recovery.argv("RST", c.tx(), context(c.h))) },
  "G7.run": { state: "completed", cmd: "REC", setup: oldRecord, undo: unold, line: c => quoted(recovery.argv("REC", c.tx(), context(c.h))) },
  "G7.prune": { state: "completed", cmd: "PRN", setup: oldRecord, undo: unold, line: c => quoted(recovery.argv("PRN", c.tx(), context(c.h))) },
  "G7.protected": { state: "completed", setup: oldRecord, undo: unold, line: c => quoted(["/bin/sh", "-c", 'deploy_dir=$1; shift; . "$deploy_dir/kaoiro-runner-common.sh"; kaoiro_codex_state "$@"', "protected", toolDeploy(c.h), "protected", c.h.root]) },
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

// Reaches nothing: runs one declared branch or guard on a reached state and
// checks its outcome, hint and side effects against the declaration.
export async function drive(id: string, c: Run) {
  const decl = declared(id), recipe = RECIPES[id]!, h = c.h;
  const cmd = recipe.cmd ?? decl.cmds?.[0];
  const before = c.uuid ? c.tx() : undefined, starts = h.callLog().split("start").length;
  const outcome = decl.outcome ?? "refuse", tree = digest(h.dir);
  const asides = (before?.asides ?? []).map((e: any) => e.aside).filter((p: string) => existsSync(p));
  // The line is rendered before the perturbation, as an operator reads it.
  const rendered = recipe.line ? undefined : lineFor(c, cmd);
  recipe.setup?.(c);
  if (recipe.activity) writeFileSync(join(h.dir, "activity-fault"), JSON.stringify({ from: recipe.activity[0], to: recipe.activity[1] }));
  let r!: ReturnType<typeof spawnSync>, after: any, out = id;
  // Undo runs even when an assertion fails, so one red case cannot leave
  // its perturbation on the state that the next refusal reuses.
  try {
    if (decl.pre) expect(PRECONDITIONS[decl.pre]!(c), `${id}: precondition ${decl.pre}`).toBe(true);
    const line = recipe.line?.(c) ?? rendered!;
    rmSync(join(h.dir, "queries"), { force: true }); rmSync(join(h.dir, "activity-count"), { force: true });
    const [file, ...args] = argvOf(line);
    r = spawnSync(file!, args, { env: h.env(), encoding: "utf8" });
    after = c.uuid ? c.tx() : undefined; out = `${id}\n${line}\n${r.stderr}`;
    rmSync(join(h.dir, "activity-fault"), { force: true });
    for (const name of ["late-populated", "late-env", "late-link"]) rmSync(join(h.dir, name), { force: true });
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
    const cls = decl.class;
    if (cls && !recipe.shell) {
      for (const advice of recovery.render(cls)) expect(r.stderr, out).toContain(`codex-state: ${advice}`);
      const record = messages[0]?.startsWith("Unresolved") ? h.records().find((x: any) => r.stderr.includes(`requires recovery: ${x.uuid}`)) : after;
      if (record && ["transaction", "transient"].includes(cls)) for (const l of recovery.rowLines(record, context(h))) expect(r.stderr, out).toContain(`codex-state: ${l}`);
    }
    if (cls === "lock" && recipe.shell) { expect(r.stderr, out).toContain(`see: ${recovery.ANCHORS.lock}`); if (before && !TERMINAL.includes(before.phase)) expect(r.stderr, out).toContain(`${c.uuid} ${before.phase}`); }
    if (recipe.context) {
      const queries = readFileSync(join(h.dir, "queries"), "utf8").trim().split("\n");
      expect(queries.slice(0, recipe.context.length), out).toEqual(recipe.context);
      expect(queries.filter(q => q === "ActiveState").length, out).toBeGreaterThanOrEqual(recipe.activity![0]);
    }
  } finally {
    recipe.undo?.(c);
    rmSync(join(h.dir, "activity-fault"), { force: true });
    for (const name of ["late-populated", "late-env", "late-link"]) rmSync(join(h.dir, name), { force: true });
  }
  if (outcome === "refuse") expect(digest(h.dir), out).toEqual(tree);
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
export function partition(id: string) {
  const decl = declared(id);
  if (decl.outcome === undefined || decl.outcome === "refuse") return 3;
  return ["prepared", "snapshot-verified", "start-intent"].includes(decl.phase) ? 1 : 2;
}
export const ids = (part: number) => [...recovery.branches().filter((x: any) => !x.guard).map((x: any) => x.id as string), ...recovery.GUARDS.map((g: any) => g.id as string)].filter(id => partition(id) === part);
export async function reach(state: string): Promise<Run> {
  const h = await fixture(state), uuid = await STATES[state]!(h);
  return { h, uuid, tx: () => h.records().find((x: any) => x.uuid === uuid), saved: {} };
}
