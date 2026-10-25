import "../../scripts/test/fixtures/test-isolation.mjs";
import { expect } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { cgroupFixture } from "./codexCgroupFixture.js";
import { makeReleaseTarball, revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";
import { publishPidMarker, signalPidIfStartMatches } from "./pid_marker.js";
const wrapperCorePidHelper = fileURLToPath(new URL("../../wrapper/core/dist/pid.js", import.meta.url));
export async function createStateFixture(options: { liveDefault?: boolean; liveHomeMissing?: boolean; liveDifferent?: boolean; toolId?: string } = {}) {
  let dir: string, root: string, home: string, ordinary: string, conf: string, calls: string, ctl: string, child: ChildProcess, archive: string, nodeOptions: string;
  const A = revisionOf("state-workflow-a"), B = revisionOf("state-workflow-b");
  const tool = options.toolId || B;

    dir = mkdtempSync(join(tmpdir(), "fuji709-state-"));
    const { preload } = cgroupFixture(dir);
    nodeOptions = (process.env.NODE_OPTIONS || "") + " --import=" + preload;
    root = join(dir, "install"); ordinary = join(dir, "ordinary"); home = options.liveDefault ? join(ordinary, ".codex") : join(dir, "codex"); conf = join(dir, "config");
    for (const path of [root, ordinary, home, conf]) mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(home, "sessions")); writeFileSync(join(home, "sessions/old.jsonl"), "HISTORY");
    writeFileSync(join(home, "auth.json"), "CURRENT_TOKEN");
    writeFileSync(join(home,".credentials.json"),"CURRENT_MCP");
    for (const name of ["secrets","mcp-oauth-locks"]) { mkdirSync(join(home,name));writeFileSync(join(home,name,"token"),"CURRENT_DIRECTORY_SECRET"); }
    writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${home}'\n`, { mode: 0o600 });
    writeFileSync(join(dir, "unit"), "synthetic unit identity");
    writeFileSync(join(conf,"runner.config.json"),JSON.stringify({server_url:"ws://127.0.0.1:1/runner"}),{mode:0o600});
    const nativePath = "node_modules/@openai/codex/vendor/fixture/bin/codex";
    const bootNative = (id: string) => `#!/bin/sh
if [ "$1" = "--n2-fixture-boot" ]; then
  [ -d "$CODEX_HOME" ] || exit 78
  printf '%s' 'BOOT:${id}' > "$CODEX_HOME/sessions/old.jsonl"
  printf '%s' 'BOOT-CREDENTIAL:${id}' > "$CODEX_HOME/auth.json"
fi
`;
    writeReleaseTree(join(root, "releases", A), A, { extraFiles: { [nativePath]: bootNative(A) } });
    const nativeTarget = { [nativePath]: bootNative(B) };
    writeReleaseTree(join(root, "releases", B), B, { extraFiles: nativeTarget });
    if (![A,B].includes(tool)) writeReleaseTree(join(root,"releases",tool),tool.replace(/-dirty$/,""),{dirty:tool.endsWith("-dirty")});
    symlinkSync(`releases/${A}`, join(root, "current"));
    mkdirSync(join(dir, "tarball")); archive = makeReleaseTarball(join(dir, "tarball"), B, { extraFiles: nativeTarget });
    child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { env: { PATH: process.env.PATH!, ...(options.liveHomeMissing ? {} : {HOME: ordinary}), ...(options.liveDefault || options.liveHomeMissing ? {} : {CODEX_HOME: options.liveDifferent ? ordinary : home}) }, stdio: "ignore" });
    await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
    const childPid = requirePositiveSafePid(child.pid);
    const procStat = readFileSync(`/proc/${childPid}/stat`, "utf8");
    const sourceStart = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19];
    publishPidMarker(join(dir, "mainpid"), childPid, { writeFileSync, renameSync }, JSON.stringify({ pid: childPid, start: sourceStart }));
    mkdirSync(join(dir, "owned-pids"));
    writeFileSync(join(dir, "active"), "active"); calls = join(dir, "calls");
    ctl = join(dir, "systemctl.mjs");
    writeFileSync(ctl, `#!${process.execPath}
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { requirePositiveSafePid } from ${JSON.stringify(wrapperCorePidHelper)};
const args = process.argv.slice(2), dir = ${JSON.stringify(dir)}, root = ${JSON.stringify(root)};
const prop = (args.find(a=>a.startsWith('--property=')) || '').slice(11);
const active = fs.readFileSync(dir+'/active','utf8') === 'active';
const signalPidIfStartMatches = ${signalPidIfStartMatches.toString()};
const publishPidMarker = ${publishPidMarker.toString()};
const owner = JSON.parse(fs.readFileSync(dir+'/mainpid','utf8'));
const ownerPid = requirePositiveSafePid(owner.pid);
if (args.includes('stop')) { fs.appendFileSync(dir+'/calls','stop\\n'); if(fs.existsSync(dir+'/reject-stop')) process.exit(77); if(!fs.existsSync(dir+'/remain-active')) { try { signalPidIfStartMatches(ownerPid, owner.start, requirePositiveSafePid, pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8'), (pid, value)=>process.kill(pid, value)); } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code)) throw e; } } fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive'); fs.writeFileSync(dir+'/fake-cgroup/kaoiro-test/cgroup.procs',''); fs.writeFileSync(dir+'/fake-cgroup/kaoiro-test/cgroup.events','populated 0\\n'); if(fs.existsSync(dir+'/late-unknown')) fs.writeFileSync(${JSON.stringify(home)}+'/unknown-token','secret'); if(fs.existsSync(dir+'/late-config')) fs.appendFileSync(${JSON.stringify(conf)}+'/runner.env','TOKEN=changed\\n'); if(fs.existsSync(dir+'/late-populated')) { fs.writeFileSync(dir+'/fake-cgroup/kaoiro-test/cgroup.procs','900002\\n'); fs.writeFileSync(dir+'/fake-cgroup/kaoiro-test/cgroup.events','populated 1\\n'); } }
else if (args.includes('start')) {
 fs.appendFileSync(dir+'/calls','start\\n');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{PATH:process.env.PATH,HOME:${JSON.stringify(ordinary)},CODEX_HOME:${JSON.stringify(home)}},stdio:'ignore'});
 child.on('spawn',()=>{
  const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');
  const record={pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
  publishPidMarker(dir+'/mainpid',record.pid,fs,JSON.stringify(record));
  publishPidMarker(dir+'/owned-pids/'+record.pid+'.json',record.pid,fs,JSON.stringify(record));
  fs.writeFileSync(dir+'/active','active'); child.unref();
 });
}
else if (args.includes('show-environment')) { console.log('HOME='+${JSON.stringify(ordinary)}+'\\nKAOIRO_RUNNER_DIR='+${JSON.stringify(conf)}); if(fs.existsSync(dir+'/manager-extra')) console.log(fs.readFileSync(dir+'/manager-extra','utf8')); }
else if (args.includes('show')) {
 const shim=root+'/current/deploy/kaoiro-runner-launch.sh';
 const values={ Transient:'no', ExecStart:'{ path='+shim+' ; argv[]='+shim+' ; ignore_errors=no }', KillMode:'control-group', MainPID:active?String(ownerPid):'0', ActiveState:active?'active':'inactive', Id:'kogane468-test.service', FragmentPath:dir+'/unit', ControlGroup:'/kaoiro-test' };
 console.log(values[prop || 'ExecStart'] || '');
}
`, { mode: 0o755 });
  const faultPreload = join(dir, "fault-preload.mjs");
  writeFileSync(faultPreload, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const dir=${JSON.stringify(dir)}, root=${JSON.stringify(root)}, home=${JSON.stringify(home)};
const rename=fs.renameSync, read=fs.readFileSync, remove=fs.rmSync;
fs.rmSync=(path,...args)=>{
 if(String(path).includes('/.staging.codex-') || String(path)===dir+'/backup') {
  const names=fs.existsSync(root+'/codex-state/v2/records')?fs.readdirSync(root+'/codex-state/v2/records').filter(n=>n.endsWith('.json')):[];
  const tx=names.length?JSON.parse(read(root+'/codex-state/v2/records/'+names[0],'utf8')):null;
  fs.appendFileSync(dir+'/removal-observations',JSON.stringify({stage:String(path).includes('/.staging.codex-'),cleanupPending:tx?.cleanup?.pending===true,pruneIntent:tx?.snapshot?.status==='prune-intent'})+'\\n');
 }
 return remove(path,...args);
};
if(process.argv[2]==='run') fs.writeFileSync(dir+'/running-helper',JSON.stringify({pid:process.pid,start:read('/proc/'+process.pid+'/stat','utf8').split(') ')[1].split(' ')[19]}));
fs.readFileSync=(path,...args)=>{
 const value=read(path,...args), faultPath=dir+'/fault.json';
 if(process.argv[2]==='promote' && String(path).startsWith(root+'/codex-state/v2/records/') && fs.existsSync(faultPath) && JSON.parse(read(faultPath,'utf8')).promote) {
  fs.writeFileSync(dir+'/cut-ready',JSON.stringify({pid:process.pid,start:read('/proc/'+process.pid+'/stat','utf8').split(') ')[1].split(' ')[19]}));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
 }
 return value;
};
fs.renameSync=(from,to)=>{
 const faultPath=dir+'/fault.json';
 let fault;
 if(fs.existsSync(faultPath)) fault=JSON.parse(fs.readFileSync(faultPath,'utf8'));
 let matches=false;
 if(fault?.phase && String(to).startsWith(root+'/codex-state/v2/records/')) { const tx=JSON.parse(fs.readFileSync(from,'utf8'));matches=tx.phase===fault.phase && (fault.startRequested===undefined || tx.replacement?.startRequested===fault.startRequested); }
 if(fault && Object.hasOwn(fault,'from')) matches=String(from)===home+fault.from;
 if(fault?.to) matches=String(to)===dir+fault.to;
 if(fault?.credential) matches=String(from).includes('/.failed.codex-') && String(from).endsWith('/'+fault.credential);
 const fire=()=>{
  if(fault.once) fs.unlinkSync(faultPath);
  fs.writeFileSync(dir+'/cut-ready',JSON.stringify({pid:process.pid,start:fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ')[1].split(' ')[19],from,to}));
  if(fault.error) throw new Error('injected checkpoint failure');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
 };
 if(matches && fault.when==='before') fire();
 const result=rename(from,to);
 if(matches && fault.when==='after') fire();
 return result;
};
syncBuiltinESMExports();
`);
  nodeOptions += " --import=" + faultPreload;
  const workers: ChildProcess[] = [], workerCloses: Promise<void>[] = [];
  let workerOutput = "", workerStdout = "", closed = false;
  const env = () => ({ ...process.env, HOME: ordinary, CODEX_HOME: home, KAOIRO_NODE: process.execPath, KAOIRO_RUNNER_DIR: conf, KAOIRO_RUNNER_ENV: join(conf,"runner.env"), KAOIRO_RUNNER_CONFIG: join(conf,"runner.config.json"), KAOIRO_RUNNER_SERVER_URL: "", KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
  const helper = join(root, "releases", tool, "deploy/kaoiro-runner-codex-state.mjs");
  const updater = join(root, "releases", tool, "deploy/kaoiro-runner-update.sh");
  // Strict artifact derivation needs the flags supplied by the shipped launcher.
  const state = (...args: string[]) => spawnSync("/bin/sh", ["-c", 'deploy_dir=$1; shift; . "$deploy_dir/kaoiro-runner-common.sh"; kaoiro_codex_state "$@"', "fixture-state", join(root,"releases",tool,"deploy"), ...args], { env: env(), encoding: "utf8" });
  const recordFiles = () => readdirSync(join(root, "codex-state/v2/records")).filter(n => n.endsWith(".json"));
  const records = () => recordFiles().map(f => JSON.parse(readFileSync(join(root, "codex-state/v2/records", f), "utf8")));
  return { dir, root, home, ordinary, conf, calls, ctl, A, B, helper, updater, env,
    state, records, tarball: () => archive, workerOutput: () => workerOutput, workerStdout: () => workerStdout,
    spawnHelper: (args: string[]) => { const worker=spawn(process.execPath,["--experimental-vm-modules","--disable-warning=ExperimentalWarning",helper,...args],{env:env(),stdio:"ignore"});workers.push(worker);workerCloses.push(new Promise<void>(resolve=>worker.once("close",()=>resolve())));return worker; },
    spawnWorker: (args: string[]) => { const worker=spawn(updater,args,{env:env(),stdio:["ignore","pipe","pipe"]});worker.stdout?.on("data",data=>{workerStdout+=String(data);});worker.stderr?.on("data",data=>{workerOutput+=String(data);});workers.push(worker);workerCloses.push(new Promise<void>(resolve=>worker.once("close",()=>resolve())));return worker; },
    callLog: () => existsSync(calls) ? readFileSync(calls, "utf8") : "",
    current: () => readlinkSync(join(root, "current")).slice(9),
    boot: () => {
      const selected=readlinkSync(join(root,"current"));
      const started=spawnSync(ctl,["--user","start","kogane468-test"],{env:env(),encoding:"utf8"});
      expect(started.status,started.stderr).toBe(0);
      const native=spawnSync(join(root,selected,nativePath),["--n2-fixture-boot"],{env:env(),encoding:"utf8"});
      expect(native.status,native.stderr).toBe(0);
      return selected.slice(9);
    },
    recordPath: (uuid: string) => join(root, "codex-state/v2/records", uuid + ".json"),
    forward: (name = "backup", extra: string[] = []) => runScript(updater, ["--install-dir", root, "--service", "kogane468-test", "--tarball", archive, "--codex-home", home, "--codex-backup-dir", join(dir, name), ...extra], env()),
    restore: (name = "backup") => runScript(updater, ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, name), "--codex-home", home], env()),
    resume: (uuid: string, mode = "resume", extra: string[] = []) => runScript(updater, ["--install-dir", root, `--${mode}-codex-transaction`, uuid, ...extra], env()),
    fault: (value: Record<string, unknown>) => writeFileSync(join(dir, "fault.json"), JSON.stringify(value)),
    trigger: (name: string, value = "1") => writeFileSync(join(dir, name), value),
    replace: (id: string, extraFiles: Record<string, string>) => {
      rmSync(join(root, "releases", id), { recursive: true });
      writeReleaseTree(join(root, "releases", id), id, { extraFiles });
      if (id === B) { const out = join(dir, "archive-" + Math.random()); mkdirSync(out); archive = makeReleaseTarball(out, id, { extraFiles }); }
    },
    close: async () => {
      if (closed) return; closed = true;
      for (const worker of workers) if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      for (const marker of ["cut-ready", "running-helper"]) if (existsSync(join(dir,marker))) {
        const owned=JSON.parse(readFileSync(join(dir,marker),"utf8"));
        signalPidIfStartMatches(owned.pid,owned.start,requirePositiveSafePid,pid=>readFileSync(`/proc/${pid}/stat`,"utf8"),(pid,signal)=>process.kill(pid,signal));
      }

    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((ok) => child.once("exit", () => ok()));
    }
    const ownedPidDirectory = join(dir, "owned-pids");
    const markers = readdirSync(ownedPidDirectory).filter((entry) =>
      entry.endsWith(".json"),
    );
    for (const name of markers) {
      const owned = JSON.parse(readFileSync(join(ownedPidDirectory, name), "utf8")) as {
        pid: number;
        start: string;
      };
      signalPidIfStartMatches(owned.pid, owned.start, requirePositiveSafePid,
        (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
        (pid, signal) => process.kill(pid, signal));
    }
    await Promise.all(workerCloses);
    rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type StateFixture = Awaited<ReturnType<typeof createStateFixture>>;

export async function interruptStateWorker(h: StateFixture, args: string[], fault: Record<string, unknown>, boot?: () => void, whilePaused?: () => void) {
  h.fault(fault);
  const worker = h.spawnWorker(args);
  const closed = new Promise<void>(resolve => worker.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (existsSync(join(h.dir, "cut-ready"))) { clearInterval(timer); resolve(); }
      else if (Date.now() > deadline || worker.exitCode !== null) { clearInterval(timer); reject(new Error("Worker did not reach checkpoint: "+h.workerOutput())); }
    }, 10);
  });
  whilePaused?.();
  const owned = JSON.parse(readFileSync(join(h.dir, "cut-ready"), "utf8"));
  requirePositiveSafePid(owned.pid);
  const start = readFileSync(`/proc/${owned.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19];
  expect(start).toBe(owned.start);
  worker.kill("SIGKILL");
  expect(readFileSync(`/proc/${owned.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]).toBe(start);
  process.kill(owned.pid, "SIGKILL");
  if (existsSync(join(h.dir,"running-helper"))) {
    const running=JSON.parse(readFileSync(join(h.dir,"running-helper"),"utf8"));
    requirePositiveSafePid(running.pid);
    if(running.pid!==owned.pid && existsSync(`/proc/${running.pid}/stat`)) {
      expect(readFileSync(`/proc/${running.pid}/stat`,"utf8").split(") ")[1]!.split(" ")[19]).toBe(running.start);
      process.kill(running.pid,"SIGKILL");
    }
  }
  await closed;
  rmSync(join(h.dir, "fault.json"), { force: true });
  rmSync(join(h.dir, "cut-ready"));
  for (const lock of [".lock.update", ".lock.links"]) rmSync(join(h.root, lock), { recursive: true, force: true });
  boot?.();
}
