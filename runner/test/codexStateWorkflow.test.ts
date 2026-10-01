import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { makeReleaseTarball, revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";

describe.skipIf(process.platform !== "linux")("state-aware updater control flow", () => {
  let dir: string, root: string, home: string, ordinary: string, conf: string, calls: string, ctl: string, child: ChildProcess, archive: string;
  const A = revisionOf("state-workflow-a"), B = revisionOf("state-workflow-b");
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kogane468-workflow-"));
    root = join(dir, "install"); home = join(dir, "codex"); ordinary = join(dir, "ordinary"); conf = join(dir, "config");
    for (const path of [root, home, ordinary, conf]) mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(home, "sessions")); writeFileSync(join(home, "sessions/old.jsonl"), "HISTORY");
    writeFileSync(join(home, "auth.json"), "CURRENT_TOKEN");
    writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${home}'\n`, { mode: 0o600 });
    writeFileSync(join(dir, "unit"), "synthetic unit identity");
    writeReleaseTree(join(root, "releases", A), A);
    writeReleaseTree(join(root, "releases", B), B);
    symlinkSync(`releases/${A}`, join(root, "current"));
    mkdirSync(join(dir, "tarball")); archive = makeReleaseTarball(join(dir, "tarball"), B);
    child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { env: { PATH: process.env.PATH!, HOME: ordinary, CODEX_HOME: home }, stdio: "ignore" });
    await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
    const procStat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const sourceStart = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19];
    writeFileSync(join(dir, "mainpid"), JSON.stringify({ pid: child.pid, start: sourceStart }));
    writeFileSync(join(dir, "owned-pids"), "");
    writeFileSync(join(dir, "active"), "active"); calls = join(dir, "calls");
    ctl = join(dir, "systemctl");
    writeFileSync(ctl, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), dir = ${JSON.stringify(dir)}, root = ${JSON.stringify(root)};
const prop = (args.find(a=>a.startsWith('--property=')) || '').slice(11);
const active = fs.readFileSync(dir+'/active','utf8') === 'active';
const owner = JSON.parse(fs.readFileSync(dir+'/mainpid','utf8'));
if (args.includes('stop')) { fs.appendFileSync(dir+'/calls','stop\\n'); try { const st=fs.readFileSync('/proc/'+owner.pid+'/stat','utf8'); if(st.slice(st.lastIndexOf(')')+2).split(' ')[19]===owner.start) process.kill(owner.pid, 'SIGTERM'); } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code)) throw e; } fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive'); if(fs.existsSync(dir+'/late-unknown')) fs.writeFileSync(${JSON.stringify(home)}+'/unknown-token','secret'); if(fs.existsSync(dir+'/late-config')) fs.appendFileSync(${JSON.stringify(conf)}+'/runner.env','TOKEN=changed\\n'); }
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
else if (args.includes('show-environment')) { console.log('HOME='+${JSON.stringify(ordinary)}+'\\nKAOIRO_RUNNER_DIR='+${JSON.stringify(conf)}); if(fs.existsSync(dir+'/manager-extra')) console.log(fs.readFileSync(dir+'/manager-extra','utf8')); }
else if (args.includes('show')) {
 const shim=root+'/current/deploy/kaoiro-runner-launch.sh';
 const values={ Transient:'no', ExecStart:'{ path='+shim+' ; argv[]='+shim+' ; ignore_errors=no }', KillMode:'control-group', MainPID:active?String(owner.pid):'0', ActiveState:active?'active':'inactive', Id:'kogane468-test.service', FragmentPath:dir+'/unit' };
 console.log(values[prop || 'ExecStart'] || '');
}
`, { mode: 0o755 });
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
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
  });
  const update = (extra: string[] = []) => runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--tarball", archive, "--codex-home", home, "--codex-backup-dir", join(dir, "backup"), ...extra], { KAOIRO_SYSTEMCTL: ctl });
  it("runs the shipped helper between stop and switch/start", () => {
    const result = update();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("stop\nstart\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(readFileSync(join(dir, "backup/state/sessions/old.jsonl"), "utf8")).toBe("HISTORY");
    expect(existsSync(join(dir, "backup/state/auth.json"))).toBe(false);
    expect(result.stderr).toContain("awaiting actual Codex start/history acceptance");
  });
  it("keeps stop failure in the same control flow as switch/start", () => {
    writeFileSync(join(dir, "late-unknown"), "trigger");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("stop\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });
  it("restores verified old state while retaining the current token", () => {
    const forward = update();
    expect(forward.status, forward.stderr).toBe(0);
    writeFileSync(join(dir, "active"), "inactive");
    writeFileSync(join(home, "sessions/old.jsonl"), "NEW_HISTORY");
    writeFileSync(join(home, "auth.json"), "REFRESHED_TOKEN");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl });
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(readFileSync(join(home, "sessions/old.jsonl"), "utf8")).toBe("HISTORY");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("REFRESHED_TOKEN");
    expect(readFileSync(calls, "utf8")).toBe("stop\nstart\nstop\nstart\n");
  });
  const stateAction = (...args: string[]) => spawnSync(process.execPath, ["--experimental-vm-modules", join(root, "releases", B, "deploy/kaoiro-runner-codex-state.mjs"), ...args], { env: { ...process.env, KAOIRO_SYSTEMCTL: ctl }, encoding: "utf8" });
  const forwardTransaction = () => {
    const file = readdirSync(join(root, "codex-state/transactions"))[0]!;
    return JSON.parse(readFileSync(join(root, "codex-state/transactions", file), "utf8"));
  };
  const acceptance = (tx: { uuid: string; target: { sha256: string } }) => {
    const file = join(dir, "acceptance.json");
    writeFileSync(file, JSON.stringify({ schema: 1, uuid: tx.uuid, nativeHash: tx.target.sha256, codexStart: true, history: true }), { mode: 0o600 });
    return file;
  };
  it("publishes the first barrier only after explicit actual-start/history acceptance", () => {
    const forward = update(); expect(forward.status, forward.stderr).toBe(0);
    expect(readdirSync(join(root, "codex-state/barriers"))).toEqual([]);
    const tx = forwardTransaction();
    const result = stateAction("accept", root, tx.uuid, acceptance(tx));
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, "codex-state/barriers"))).toHaveLength(1);
    expect(forwardTransaction().phase).toBe("completed");
  });
  it("refuses acceptance without history evidence", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction(), file = acceptance(tx);
    const proof = JSON.parse(readFileSync(file, "utf8")); proof.history = false;
    writeFileSync(file, JSON.stringify(proof));
    const result = stateAction("accept", root, tx.uuid, file);
    expect(result.status).not.toBe(0);
    expect(readdirSync(join(root, "codex-state/barriers"))).toEqual([]);
    expect(forwardTransaction().phase).toBe("awaiting-acceptance");
  });
  it("repairs a damaged barrier only from the matching accepted transaction", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
    const file = readdirSync(join(root, "codex-state/barriers"))[0]!;
    writeFileSync(join(root, "codex-state/barriers", file), "corrupt");
    const result = stateAction("repair-barrier", root, tx.uuid);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, "codex-state/barriers")).some((name) => name.includes("damaged"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "codex-state/barriers", file), "utf8")).native.sha256).toBe(tx.target.sha256);
  });
  it("retires an accepted snapshot with explicit abandonment and keeps its barrier", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
    const proof = join(dir, "retire.json");
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid: tx.uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    const result = stateAction("retire", root, tx.uuid, proof);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dir, "backup"))).toBe(false);
    expect(readdirSync(join(root, "codex-state/barriers"))).toHaveLength(1);
    expect(forwardTransaction().phase).toBe("retired");
  });
  it("refuses restoring an older retained reference before stopping", () => {
    expect(update().status).toBe(0);
    const first = forwardTransaction();
    expect(stateAction("accept", root, first.uuid, acceptance(first)).status).toBe(0);
    const secondUpdate = update(["--codex-backup-dir", join(dir, "backup-two")]);
    expect(secondUpdate.status, secondUpdate.stderr).toBe(0);
    const second = readdirSync(join(root, "codex-state/transactions")).map((file) => JSON.parse(readFileSync(join(root, "codex-state/transactions", file), "utf8"))).find((tx) => tx.uuid !== first.uuid)!;
    expect(stateAction("accept", root, second.uuid, acceptance(second)).status).toBe(0);
    const before = readFileSync(calls, "utf8");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Non-latest restore refused");
    expect(readFileSync(calls, "utf8")).toBe(before);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });
  it("refuses a corrupt backup before stop or state replacement", () => {
    expect(update().status).toBe(0);
    const before = readFileSync(calls, "utf8");
    writeFileSync(join(dir, "backup/state/sessions/old.jsonl"), "CORRUPTION");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl });
    expect(result.status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).toBe(before);
    expect(readFileSync(join(home, "sessions/old.jsonl"), "utf8")).toBe("HISTORY");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });
  it("rejects a self-consistent snapshot with crossed release metadata before stop", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    const path = join(dir, "backup/manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.sourceRelease.id = B;
    writeFileSync(path, JSON.stringify(manifest));
    const refPath = join(root, "codex-state/backups", `${tx.uuid}.json`);
    const ref = JSON.parse(readFileSync(refPath, "utf8"));
    ref.manifestHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(refPath, JSON.stringify(ref));
    const before = readFileSync(calls, "utf8");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release/home binding differs");
    expect(readFileSync(calls, "utf8")).toBe(before);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });
  it("refuses malformed retention metadata instead of releasing protected code", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    const refPath = join(root, "codex-state/backups", `${tx.uuid}.json`);
    const ref = JSON.parse(readFileSync(refPath, "utf8"));
    ref.retired = "yes";
    writeFileSync(refPath, JSON.stringify(ref));
    const result = stateAction("protected", root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Malformed backup retention state");
  });
  it("rejects an otherwise valid wrong home before stop", () => {
    const wrong = join(dir, "wrong"); mkdirSync(wrong, { mode: 0o700 });
    const result = update(["--codex-home", wrong]);
    expect(result.status).not.toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("rejects a next-launch home mismatch even when the live home agrees", () => {
    const wrong = join(dir, "wrong"); mkdirSync(wrong, { mode: 0o700 });
    writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${wrong}'\n`, { mode: 0o600 });
    const result = update();
    expect(result.status).not.toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("rejects a live home mismatch despite agreement with next launch", () => {
    const wrong = join(dir, "wrong"); mkdirSync(wrong, { mode: 0o700 });
    writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${wrong}'\n`, { mode: 0o600 });
    const result = update(["--codex-home", wrong]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Running CODEX_HOME differs");
    expect(existsSync(calls)).toBe(false);
  });
  it("includes manager-selected runner.env in the next-launch binding", () => {
    const wrong = join(dir, "wrong"); mkdirSync(wrong, { mode: 0o700 });
    const alternate = join(conf, "alternate.env");
    writeFileSync(alternate, `CODEX_HOME='${wrong}'\n`, { mode: 0o600 });
    writeFileSync(join(dir, "manager-extra"), `KAOIRO_RUNNER_ENV=${alternate}`);
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Next launch CODEX_HOME differs");
    expect(existsSync(calls)).toBe(false);
  });
  it("rejects runner.env changes after stopping even if the home stays the same", () => {
    writeFileSync(join(dir, "late-config"), "trigger");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("configuration changed after binding");
    expect(readFileSync(calls, "utf8")).toBe("stop\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
  it("continues with an explicit warning while an external process holds state", () => {
    const fd = openSync(join(home, "sessions/old.jsonl"), "r");
    try {
      const result = update();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr.match(/external Codex-home writers are not inspected/g)).toHaveLength(1);
      expect(readFileSync(calls, "utf8")).toBe("stop\nstart\n");
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    } finally { closeSync(fd); }
  });
  it("refuses a service still active after stop with no switch or start", () => {
    writeFileSync(join(dir, "remain-active"), "trigger");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Runner is not fully stopped");
    expect(readFileSync(calls, "utf8")).toBe("stop\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });
  it.each(["before-move", "after-move", "recovery-failure"])("handles switch failure %s without starting the candidate", (mode) => {
    const original = readFileSync(join(root, "releases", B, "deploy/kaoiro-runner-switch.sh"), "utf8");
    const failBefore = `if [ "$1" = "${B}" ]; then exit 70; fi\n`;
    const changed = mode === "before-move" ? original.replace("set -eu\n", "set -eu\n" + failBefore)
      : mode === "after-move" ? original + `\nif [ "$id" = "${B}" ]; then exit 70; fi\n`
      : original.replace("set -eu\n", "set -eu\nexit 70\n");
    const extraFiles = { "deploy/kaoiro-runner-switch.sh": changed };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "failure-tarball"));
    archive = makeReleaseTarball(join(dir, "failure-tarball"), B, { extraFiles });
    const result = update();
    expect(result.status, result.stderr).not.toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(readFileSync(join(home, "sessions/old.jsonl"), "utf8")).toBe("HISTORY");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("CURRENT_TOKEN");
    expect(readFileSync(calls, "utf8"), result.stderr).toBe(mode === "recovery-failure" ? "stop\n" : "stop\nstart\n");
    expect(result.stderr).toContain(mode === "recovery-failure" ? "operator fresh setup" : "recorded source was restored and restarted");
  });
  it("charges sparse files by logical size and rejects insufficient capacity before stop", () => {
    const fs = statfsSync(dir);
    const fd = openSync(join(home, "history.jsonl"), "w");
    try { ftruncateSync(fd, fs.bavail * fs.bsize + 1024 ** 3); } finally { closeSync(fd); }
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Insufficient snapshot/restore disk capacity");
    expect(existsSync(calls)).toBe(false);
  });
  it("rejects unclassified files before stopping the source", () => {
    writeFileSync(join(home, "unknown-token"), "secret");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(existsSync(calls)).toBe(false);
  });
  it("refuses an already stopped forward source", () => {
    writeFileSync(join(dir, "active"), "inactive");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(existsSync(calls)).toBe(false);
  });
});
