import { cgroupFixture } from "./codexCgroupFixture.js";
// Shared fixture for the Codex state lineage tests (issue 498). Not a test
// file itself. It drives the REAL deploy scripts and state helper against a
// synthetic installation: the service manager is a scripted systemctl whose
// only child processes are owned by the test, so it proves control flow and
// OS rename behaviour, not live systemd or Codex history.
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeReleaseTarball, revisionOf, runScript, writeReleaseTree, type RunResult } from "./releaseFixture.js";

// Test-only record shape; the helper owns the schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = Record<string, any>;

const FAULT_PRELOAD = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spec = JSON.parse(process.env.KAOIRO_TEST_FAULT || "null");
if (spec) {
  const real = fs.renameSync;
  let count = 0;
  fs.renameSync = (from, to) => {
    if (new RegExp(spec.match).test(String(to)) && ++count === spec.nth) {
      if (spec.when === "mutate") { fs.writeFileSync(spec.write.path, spec.write.content); return real(from, to); }
      if (spec.when === "after") { real(from, to); throw new Error("injected failure after rename"); }
      throw new Error("injected failure before rename");
    }
    return real(from, to);
  };
  syncBuiltinESMExports();
}
`;

export interface Fault {
  /** Regular expression matched against the rename destination. */
  match: string;
  nth: number;
  /** "mutate" rewrites `write.path` and then lets the rename proceed. */
  when: "before" | "after" | "mutate";
  write?: { path: string; content: string };
}

export interface Lineage {
  dir: string;
  root: string;
  home: string;
  conf: string;
  calls: string;
  ids: Record<"A" | "B" | "C", string>;
  update(to: "A" | "B" | "C", backup: string, extra?: string[]): RunResult;
  restore(backup: string, extra?: string[]): RunResult;
  state(...args: string[]): SpawnSyncReturns<string>;
  faultState(fault: Fault, ...args: string[]): SpawnSyncReturns<string>;
  accept(uuid: string, mutate?: (proof: Record<string, unknown>) => void, fault?: Fault): SpawnSyncReturns<string>;
  transactions(): Tx[];
  transaction(uuid: string): Tx;
  writeTransaction(tx: Tx): void;
  reference(uuid: string): Tx;
  writeReference(ref: Tx): void;
  backupPath(name: string): string;
  saveState(): void;
  restoreState(): void;
  current(): string;
  callLog(): string;
  teardown(): Promise<void>;
}

export interface LineageOptions {
  /** Makes release A's switch script fail before moving links when asked to
   *  activate B, which stages a never-started candidate (code recovery). */
  failSwitchToB?: boolean;
}

/** A, B and C ship different native bytes, so pin comparison is real. */
export async function createLineage(options: LineageOptions = {}): Promise<Lineage> {
  const dir = mkdtempSync(join(tmpdir(), "ao498-lineage-"));
  const { preload } = cgroupFixture(dir);
  const nodeOptions = (process.env.NODE_OPTIONS || "") + " --import=" + preload;
  const root = join(dir, "install"), home = join(dir, "codex"), ordinary = join(dir, "ordinary"), conf = join(dir, "config");
  for (const path of [root, home, ordinary, conf]) mkdirSync(path, { mode: 0o700 });
  mkdirSync(join(home, "sessions"));
  writeFileSync(join(home, "sessions/old.jsonl"), "HISTORY");
  writeFileSync(join(home, "auth.json"), "CURRENT_TOKEN");
  writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${home}'\n`, { mode: 0o600 });
  writeFileSync(join(dir, "unit"), "synthetic unit identity");
  const ids = { A: revisionOf("lineage-a"), B: revisionOf("lineage-b"), C: revisionOf("lineage-c") };
  const native = (id: string) => ({ "node_modules/@openai/codex/vendor/fixture/bin/codex": `#!/bin/sh\n# native ${id}\nexit 0\n` });
  const archives: Record<string, string> = {};
  const switchScript = readFileSync(fileURLToPath(new URL("../deploy/kaoiro-runner-switch.sh", import.meta.url)), "utf8");
  for (const key of ["A", "B", "C"] as const) {
    const id = ids[key];
    const extraFiles: Record<string, string> = native(id);
    if (options.failSwitchToB && key === "A") extraFiles["deploy/kaoiro-runner-switch.sh"] = switchScript.replace("set -eu\n", `set -eu\nif [ "$1" = "${ids.B}" ]; then exit 70; fi\n`);
    writeReleaseTree(join(root, "releases", id), id, { extraFiles });
    mkdirSync(join(dir, `tarball-${key}`));
    archives[key] = makeReleaseTarball(join(dir, `tarball-${key}`), id, { extraFiles });
  }
  symlinkSync(`releases/${ids.A}`, join(root, "current"));
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { env: { PATH: process.env.PATH!, HOME: ordinary, CODEX_HOME: home }, stdio: "ignore" });
  await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  writeFileSync(join(dir, "mainpid"), JSON.stringify({ pid: child.pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] }));
  writeFileSync(join(dir, "owned-pids"), "");
  writeFileSync(join(dir, "active"), "active");
  const calls = join(dir, "calls"), ctl = join(dir, "systemctl");
  writeFileSync(ctl, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), dir = ${JSON.stringify(dir)}, root = ${JSON.stringify(root)};
const prop = (args.find(a=>a.startsWith('--property=')) || '').slice(11);
const active = fs.readFileSync(dir+'/active','utf8') === 'active';
const owner = JSON.parse(fs.readFileSync(dir+'/mainpid','utf8'));
if (args.includes('stop')) {
 fs.appendFileSync(dir+'/calls','stop\\n');
 try { const st=fs.readFileSync('/proc/'+owner.pid+'/stat','utf8'); if(st.slice(st.lastIndexOf(')')+2).split(' ')[19]===owner.start) process.kill(owner.pid, 'SIGTERM'); } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code)) throw e; }
 fs.writeFileSync(dir+'/active','inactive');
}
else if (args.includes('start')) {
 fs.appendFileSync(dir+'/calls','start\\n');
 const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{PATH:process.env.PATH,HOME:${JSON.stringify(ordinary)},CODEX_HOME:${JSON.stringify(home)}},stdio:'ignore'});
 child.on('spawn',()=>{
  const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');
  const record={pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
  fs.writeFileSync(dir+'/mainpid',JSON.stringify(record));
  fs.appendFileSync(dir+'/owned-pids',JSON.stringify(record)+'\\n');
  fs.writeFileSync(dir+'/active','active'); child.unref();
 });
}
else if (args.includes('show-environment')) { console.log('HOME='+${JSON.stringify(ordinary)}+'\\nKAOIRO_RUNNER_DIR='+${JSON.stringify(conf)}); }
else if (args.includes('show')) {
 const shim=root+'/current/deploy/kaoiro-runner-launch.sh';
 const unit=fs.existsSync(dir+'/unit-id')?fs.readFileSync(dir+'/unit-id','utf8').trim():'ao498-test.service';
 const values={ Transient:'no', ExecStart:'{ path='+shim+' ; argv[]='+shim+' ; ignore_errors=no }', KillMode:'control-group', MainPID:active?String(owner.pid):'0', ActiveState:active?'active':'inactive', Id:unit, FragmentPath:dir+'/unit', ControlGroup:'/kaoiro-test' };
 console.log(values[prop || 'ExecStart'] || '');
}
`, { mode: 0o755 });
  writeFileSync(join(dir, "fault.mjs"), FAULT_PRELOAD);

  const current = () => readlinkSync(join(root, "current")).slice("releases/".length);
  const script = () => join(root, "releases", current(), "deploy/kaoiro-runner-update.sh");
  const helper = () => join(root, "releases", current(), "deploy/kaoiro-runner-codex-state.mjs");
  const spawnState = (env: Record<string, string>, pre: string[], args: string[]) =>
    spawnSync(process.execPath, ["--experimental-vm-modules", ...pre, helper(), ...args], { env: { ...process.env, KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions, ...env }, encoding: "utf8" });
  const txFile = (uuid: string) => join(root, "codex-state/transactions", `${uuid}.json`);
  const refFile = (uuid: string) => join(root, "codex-state/backups", `${uuid}.json`);
  const read = (path: string): Tx => JSON.parse(readFileSync(path, "utf8"));
  const write = (path: string, value: Tx) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

  const lineage: Lineage = {
    dir, root, home, conf, calls, ids,
    update: (to, backup, extra = []) => runScript(script(), ["--install-dir", root, "--service", "ao498-test", "--tarball", archives[to]!, "--codex-home", home, "--codex-backup-dir", join(dir, backup), ...extra], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions }),
    restore: (backup, extra = []) => runScript(script(), ["--install-dir", root, "--service", "ao498-test", "--restore-codex-backup", join(dir, backup), "--codex-home", home, ...extra], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions }),
    state: (...args) => spawnState({}, [], args),
    faultState: (fault, ...args) => spawnState({ KAOIRO_TEST_FAULT: JSON.stringify(fault) }, ["--import", `file://${join(dir, "fault.mjs")}`], args),
    accept: (uuid, mutate, fault) => {
      const tx = read(txFile(uuid));
      const proof: Record<string, unknown> = { schema: 1, uuid, nativeHash: tx.target.sha256, codexStart: true, history: true };
      mutate?.(proof);
      const file = join(dir, `acceptance-${uuid}.json`);
      writeFileSync(file, JSON.stringify(proof), { mode: 0o600 });
      return fault ? lineage.faultState(fault, "accept", root, uuid, file) : spawnState({}, [], ["accept", root, uuid, file]);
    },
    transactions: () => readdirSync(join(root, "codex-state/transactions")).filter((name) => name.endsWith(".json")).map((name) => read(join(root, "codex-state/transactions", name))).sort((a, b) => a.order - b.order),
    transaction: (uuid) => read(txFile(uuid)),
    writeTransaction: (tx) => write(txFile(tx.uuid), tx),
    reference: (uuid) => read(refFile(uuid)),
    writeReference: (ref) => write(refFile(ref.uuid), ref),
    backupPath: (name) => join(dir, name),
    saveState: () => { rmSync(join(dir, "state-copy"), { recursive: true, force: true }); execFileSync("cp", ["-a", join(root, "codex-state"), join(dir, "state-copy")]); },
    restoreState: () => {
      rmSync(join(root, "codex-state"), { recursive: true });
      execFileSync("cp", ["-a", join(dir, "state-copy"), join(root, "codex-state")]);
      rmSync(join(root, ".lock.update"), { recursive: true, force: true });
    },
    current,
    callLog: () => { try { return readFileSync(calls, "utf8"); } catch { return ""; } },
    teardown: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((ok) => child.once("exit", () => ok()));
      }
      for (const line of readFileSync(join(dir, "owned-pids"), "utf8").split("\n").filter(Boolean)) {
        const owned = JSON.parse(line) as { pid: number; start: string };
        try {
          const st = readFileSync(`/proc/${owned.pid}/stat`, "utf8");
          if (st.slice(st.lastIndexOf(")") + 2).split(" ")[19] === owned.start) process.kill(owned.pid, "SIGTERM");
        } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return lineage;
}

const succeed = (result: { status: number | null; stderr: string }, what: string) => {
  if (result.status !== 0) throw new Error(`${what} failed: ${result.stderr}`);
};

/** One accepted state-aware forward update; returns the accepted record. */
export function forwardAccepted(L: Lineage, to: "A" | "B" | "C", backup: string): Tx {
  succeed(L.update(to, backup), `forward to ${to}`);
  const tx = L.transactions().at(-1)!;
  succeed(L.accept(tx.uuid), `accept ${tx.uuid}`);
  return L.transaction(tx.uuid);
}

/** One accepted managed restore of the snapshot named `backup`. */
export function restoreAccepted(L: Lineage, backup: string): Tx {
  succeed(L.restore(backup), `restore ${backup}`);
  const tx = L.transactions().at(-1)!;
  succeed(L.accept(tx.uuid), `accept ${tx.uuid}`);
  return L.transaction(tx.uuid);
}
