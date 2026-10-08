import { cgroupFixture } from "./codexCgroupFixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { makeReleaseTarball, revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";

describe.skipIf(process.platform !== "linux")("state-aware updater control flow", () => {
  let dir: string, root: string, home: string, ordinary: string, conf: string, calls: string, ctl: string, child: ChildProcess, archive: string, nodeOptions: string;
  const A = revisionOf("state-workflow-a"), B = revisionOf("state-workflow-b");
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kogane468-workflow-"));
    const { preload } = cgroupFixture(dir);
    nodeOptions = (process.env.NODE_OPTIONS || "") + " --import=" + preload;
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
if (args.includes('stop')) { fs.appendFileSync(dir+'/calls','stop\\n'); if(fs.existsSync(dir+'/reject-stop')) process.exit(77); if(!fs.existsSync(dir+'/remain-active')) { try { const st=fs.readFileSync('/proc/'+owner.pid+'/stat','utf8'); if(st.slice(st.lastIndexOf(')')+2).split(' ')[19]===owner.start) process.kill(owner.pid, 'SIGTERM'); } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code)) throw e; } } fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive'); if(fs.existsSync(dir+'/late-unknown')) fs.writeFileSync(${JSON.stringify(home)}+'/unknown-token','secret'); if(fs.existsSync(dir+'/late-config')) fs.appendFileSync(${JSON.stringify(conf)}+'/runner.env','TOKEN=changed\\n'); }
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
 const values={ Transient:'no', ExecStart:'{ path='+shim+' ; argv[]='+shim+' ; ignore_errors=no }', KillMode:'control-group', MainPID:active?String(owner.pid):'0', ActiveState:active?'active':'inactive', Id:'kogane468-test.service', FragmentPath:dir+'/unit', ControlGroup:'/kaoiro-test' };
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
  const update = (extra: string[] = []) => runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--tarball", archive, "--codex-home", home, "--codex-backup-dir", join(dir, "backup"), ...extra], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
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
    const original = readFileSync(join(root, "releases", B, "deploy/kaoiro-runner-switch.sh"), "utf8");
    const marker = join(dir, "switch-invocations");
    const extraFiles = { "deploy/kaoiro-runner-switch.sh": original.replace("set -eu\n", `set -eu\nprintf 'switch\\n' >> '${marker}'\n`) };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "snapshot-failure-tarball"));
    archive = makeReleaseTarball(join(dir, "snapshot-failure-tarball"), B, { extraFiles });
    writeFileSync(join(dir, "late-unknown"), "trigger");
    const result = update();
    expect(result.status).not.toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("stop\nstart\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
    expect(result.stderr).toContain("Codex state preparation failed");
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).not.toContain('"sourceHash"');
    expect(result.stderr).not.toContain(join(conf, "runner.env"));
    expect(result.stderr).toContain('"phase":"stopped"');
  });
  it("restores verified old state while retaining the current token", () => {
    const forward = update();
    expect(forward.status, forward.stderr).toBe(0);
    writeFileSync(join(dir, "active"), "inactive");
    writeFileSync(join(home, "sessions/old.jsonl"), "NEW_HISTORY");
    writeFileSync(join(home, "auth.json"), "REFRESHED_TOKEN");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(readFileSync(join(home, "sessions/old.jsonl"), "utf8")).toBe("HISTORY");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("REFRESHED_TOKEN");
    expect(readFileSync(calls, "utf8")).toBe("stop\nstart\nstop\nstart\n");
  });
  const stateAction = (...args: string[]) => spawnSync(process.execPath, ["--experimental-vm-modules", join(root, "releases", B, "deploy/kaoiro-runner-codex-state.mjs"), ...args], { env: { ...process.env, KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions }, encoding: "utf8" });
  const forwardTransaction = () => {
    const file = readdirSync(join(root, "codex-state/transactions"))[0]!;
    return JSON.parse(readFileSync(join(root, "codex-state/transactions", file), "utf8"));
  };
  const acceptance = (tx: { uuid: string; target: { sha256: string } }) => {
    const file = join(dir, "acceptance.json");
    writeFileSync(file, JSON.stringify({ schema: 1, uuid: tx.uuid, nativeHash: tx.target.sha256, codexStart: true, history: true }), { mode: 0o600 });
    return file;
  };
  it("publishes the accepted binding receipt only after explicit actual-start/history acceptance", () => {
    const forward = update(); expect(forward.status, forward.stderr).toBe(0);
    const tx = forwardTransaction();
    expect(tx).toMatchObject({ bindingReceiptVersion: 1, phase: "awaiting-acceptance" });
    expect(tx).not.toHaveProperty("acceptance");
    expect(tx).not.toHaveProperty("sequence");
    const evidence = acceptance(tx);
    const result = stateAction("accept", root, tx.uuid, evidence);
    expect(result.status, result.stderr).toBe(0);
    const accepted = forwardTransaction();
    expect(accepted).toMatchObject({ phase: "completed", sequence: 1 });
    expect(accepted.acceptance).toEqual({ version: 1, evidenceHash: createHash("sha256").update(readFileSync(evidence)).digest("hex"), accepted: expect.any(String), binding: expect.any(Object) });
    const { live, ...pre } = tx.binding;
    expect(live).toEqual(expect.objectContaining({ pid: expect.any(Number) }));
    expect(accepted.acceptance.binding).toEqual(pre);
    expect(accepted.binding).toEqual(tx.binding);
    expect(existsSync(join(root, "codex-state/barriers"))).toBe(false);
  });
  it("refuses acceptance without history evidence", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction(), file = acceptance(tx);
    const proof = JSON.parse(readFileSync(file, "utf8")); proof.history = false;
    writeFileSync(file, JSON.stringify(proof));
    const result = stateAction("accept", root, tx.uuid, file);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, "codex-state/barriers"))).toBe(false);
    const after = forwardTransaction();
    expect(after.phase).toBe("awaiting-acceptance");
    expect(after).not.toHaveProperty("acceptance");
    expect(after).not.toHaveProperty("sequence");
  });
  it.each(["history", "new-session"])("retires an accepted snapshot with %s evidence and keeps its receipt", (basis) => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    const acceptanceFile = acceptance(tx);
    if (basis === "new-session") {
      const value = JSON.parse(readFileSync(acceptanceFile, "utf8"));
      value.history = false; value.explicitNewSession = true;
      writeFileSync(acceptanceFile, JSON.stringify(value));
    }
    expect(stateAction("accept", root, tx.uuid, acceptanceFile).status).toBe(0);
    const receipt = forwardTransaction().acceptance;
    const proof = join(dir, "retire.json");
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid: tx.uuid, gate6: true, productionCodexStart: true, productionHistory: basis === "history", explicitNewSession: basis === "new-session", abandonRollback: true }), { mode: 0o600 });
    const result = stateAction("retire", root, tx.uuid, proof);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("barriersRetained");
    expect(existsSync(join(dir, "backup"))).toBe(false);
    expect(existsSync(join(root, "codex-state/barriers"))).toBe(false);
    expect(forwardTransaction()).toMatchObject({ phase: "retired", sequence: 1, acceptance: receipt });
  });
  it("refuses retirement without either history or explicit new-session evidence", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
    const file = join(dir, "retire-missing.json");
    writeFileSync(file, JSON.stringify({ schema: 1, uuid: tx.uuid, gate6: true, productionCodexStart: true, productionHistory: false, explicitNewSession: false, abandonRollback: true }), { mode: 0o600 });
    expect(stateAction("retire", root, tx.uuid, file).status).not.toBe(0);
    expect(existsSync(join(dir, "backup"))).toBe(true);
    expect(forwardTransaction().phase).toBe("completed");
  });
  it("refuses retirement when the current release no longer verifies", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
    writeFileSync(join(root, "releases", B, "dist/stub_dep.js"), "tampered");
    const proof = join(dir, "retire.json");
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid: tx.uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    const result = stateAction("retire", root, tx.uuid, proof);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(dir, "backup"))).toBe(true);
    expect(forwardTransaction().phase).toBe("completed");
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
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Non-latest restore refused");
    expect(readFileSync(calls, "utf8")).toBe(before);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });
  it("refuses a corrupt backup before stop or state replacement", () => {
    expect(update().status).toBe(0);
    const before = readFileSync(calls, "utf8");
    writeFileSync(join(dir, "backup/state/sessions/old.jsonl"), "CORRUPTION");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
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
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--restore-codex-backup", join(dir, "backup"), "--codex-home", home], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
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
  it.each(["before-move", "after-move", "start-attempted", "recovery-failure"])("handles switch failure %s without starting the candidate", (mode) => {
    const original = readFileSync(join(root, "releases", B, "deploy/kaoiro-runner-switch.sh"), "utf8");
    const failBefore = `if [ "$1" = "${B}" ]; then exit 70; fi\n`;
    const changed = mode === "before-move" ? original.replace("set -eu\n", "set -eu\n" + failBefore)
      : mode === "start-attempted" ? original + `\nif [ "$id" = "${B}" ]; then\n"${process.execPath}" -e 'const fs=require("node:fs");const p="${root}/codex-state/transactions/";const f=p+fs.readdirSync(p)[0];const t=JSON.parse(fs.readFileSync(f));t.phase="start-attempted";fs.writeFileSync(f,JSON.stringify(t));'\nexit 70\nfi\n`
      : mode === "after-move" ? original + `\nif [ "$id" = "${B}" ]; then exit 70; fi\n`
      : original.replace("set -eu\n", "set -eu\nexit 70\n");
    const extraFiles = { "deploy/kaoiro-runner-switch.sh": changed, "node_modules/@openai/codex/vendor/fixture/bin/codex": "#!/bin/sh\n# different candidate native\nexit 0\n" };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "failure-tarball"));
    archive = makeReleaseTarball(join(dir, "failure-tarball"), B, { extraFiles });
    const inode = statSync(home).ino, credentialInode = statSync(join(home, "auth.json")).ino;
    const result = update();
    expect(result.status, result.stderr).not.toBe(0);
    const quarantines = readdirSync(dir).filter((name) => name.startsWith(".failed.codex-"));
    expect(quarantines).toHaveLength(mode === "start-attempted" ? 1 : 0);
    if (mode === "start-attempted") expect(statSync(home).ino).not.toBe(inode);
    else expect(statSync(home).ino).toBe(inode);
    expect(statSync(join(home, "auth.json")).ino).toBe(credentialInode);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(readFileSync(join(home, "sessions/old.jsonl"), "utf8")).toBe("HISTORY");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("CURRENT_TOKEN");
    expect(readFileSync(calls, "utf8"), result.stderr).toBe(mode === "recovery-failure" ? "stop\n" : "stop\nstart\n");
    expect(result.stderr).toContain(mode === "recovery-failure" ? "operator fresh setup" : "recorded source was restored and restarted");
  });
  it("refuses a host without unified cgroup v2 before snapshot or switch", () => {
    const original = readFileSync(join(root, "releases", B, "deploy/codex-service.mjs"), "utf8");
    const extraFiles = { "deploy/codex-service.mjs": original.replace('"/sys/fs/cgroup/cgroup.controllers"', JSON.stringify(join(dir, "missing-controllers"))) };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "cgroup-tarball"));
    archive = makeReleaseTarball(join(dir, "cgroup-tarball"), B, { extraFiles });
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires unified cgroup v2");
    expect(existsSync(calls)).toBe(false);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
  });
  it.each(["before-switch", "before-start"])("refuses code-only recovery if its original startup proof changes %s", (boundary) => {
    const original = readFileSync(join(root, "releases", B, "deploy/kaoiro-runner-switch.sh"), "utf8");
    const corruptProof = `if [ "$1" = "${A}" ]; then\n"${process.execPath}" -e 'const fs=require("node:fs");const p="${root}/codex-state/transactions/";for(const f of fs.readdirSync(p)){const t=JSON.parse(fs.readFileSync(p+f));if(t.mode==="forward"){t.phase="start-attempted";fs.writeFileSync(p+f,JSON.stringify(t));}}'\nfi\n`;
    const changed = (boundary === "before-switch" ? original.replace("set -eu\n", "set -eu\n" + corruptProof) : original + "\n" + corruptProof.replace('"$1"', '"$id"')) + `\nif [ "$id" = "${B}" ]; then exit 70; fi\n`;
    const extraFiles = { "deploy/kaoiro-runner-switch.sh": changed };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "proof-tarball"));
    archive = makeReleaseTarball(join(dir, "proof-tarball"), B, { extraFiles });
    const inode = statSync(home).ino;
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot prove candidate never started");
    expect(readFileSync(calls, "utf8")).toBe("stop\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${boundary === "before-switch" ? B : A}`);
    expect(statSync(home).ino).toBe(inode);
    expect(readdirSync(dir).filter((name) => name.startsWith(".failed.codex-"))).toEqual([]);
  });
  it("refuses code-only recovery redirected away from the original source", () => {
    const original = readFileSync(join(root, "releases", B, "deploy/kaoiro-runner-switch.sh"), "utf8");
    const redirect = `if [ "$1" = "${A}" ]; then\n"${process.execPath}" -e 'const fs=require("node:fs");const p="${root}/codex-state/transactions/";const all=fs.readdirSync(p).map(f=>[f,JSON.parse(fs.readFileSync(p+f))]);const old=all.find(x=>x[1].mode==="forward")[1];for(const [f,t] of all){if(t.mode==="code-recovery"){t.target=old.target;fs.writeFileSync(p+f,JSON.stringify(t));}}'\nshift\nset -- "${B}" "$@"\nfi\n`;
    const changed = original.replace("set -eu\n", "set -eu\n" + redirect) + `\nif [ "$id" = "${B}" ]; then exit 70; fi\n`;
    const extraFiles = { "deploy/kaoiro-runner-switch.sh": changed };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "redirect-tarball"));
    archive = makeReleaseTarball(join(dir, "redirect-tarball"), B, { extraFiles });
    const result = update();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Code recovery must return to original source");
    expect(readFileSync(calls, "utf8")).toBe("stop\n");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });
  it("budgets the migration DB copy before stopping the runner", () => {
    const fs = statfsSync(dir), available = fs.bavail * fs.bsize;
    const bytes = Math.floor(available * 0.6);
    const reserve = Math.max(Math.ceil(bytes * 0.2), 1024 ** 3);
    expect(bytes).toBeGreaterThan(reserve);
    expect(bytes + reserve).toBeLessThan(available);
    expect(bytes * 2 + reserve).toBeGreaterThan(available);
    const fd = openSync(join(home, "state_5.sqlite"), "w");
    try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
    // The negative control must not hash/copy a filesystem-sized sparse DB.
    writeFileSync(join(dir, "reject-stop"), "stop invocation fails immediately");
    const result = update();
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("Insufficient snapshot/restore disk capacity");
    expect(existsSync(calls)).toBe(false);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(dir, "backup"))).toBe(false);
    expect(existsSync(join(root, "codex-state"))).toBe(false);
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
  it("refuses a differing-native update without a state backup before stopping", () => {
    const extraFiles = { "node_modules/@openai/codex/vendor/fixture/bin/codex": "#!/bin/sh\n# different candidate native\nexit 0\n" };
    rmSync(join(root, "releases", B), { recursive: true });
    writeReleaseTree(join(root, "releases", B), B, { extraFiles });
    mkdirSync(join(dir, "pin-tarball"));
    archive = makeReleaseTarball(join(dir, "pin-tarball"), B, { extraFiles });
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--tarball", archive], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Codex pin transition requires an explicit state backup");
    expect(existsSync(calls)).toBe(false);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(root, "codex-state"))).toBe(false);
  });
  it("keeps a retained reference on the state-aware path for same-native code-only switching", () => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
    const links = { current: readlinkSync(join(root, "current")), previous: readlinkSync(join(root, "previous")) };
    const result = runScript(join(root, "current/deploy/kaoiro-runner-switch.sh"), ["--rollback", "--install-dir", root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Retained Codex state requires a state-aware update/restore");
    expect({ current: readlinkSync(join(root, "current")), previous: readlinkSync(join(root, "previous")) }).toEqual(links);
  });
  it.each(["a token edit", "a changed CODEX_HOME"])("lets %s through the code-only update path once nothing is retained", (edit) => {
    expect(update().status).toBe(0);
    const tx = forwardTransaction();
    expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
    const proof = join(dir, "retire.json");
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid: tx.uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    expect(stateAction("retire", root, tx.uuid, proof).status).toBe(0);
    if (edit === "a token edit") writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${home}'\nTOKEN=changed\n`, { mode: 0o600 });
    else { const other = join(dir, "other-home"); mkdirSync(other, { mode: 0o700 }); writeFileSync(join(conf, "runner.env"), `CODEX_HOME='${other}'\n`, { mode: 0o600 }); }
    const C = revisionOf("state-workflow-c");
    mkdirSync(join(dir, "code-only-tarball"));
    const codeOnly = makeReleaseTarball(join(dir, "code-only-tarball"), C);
    const before = readFileSync(calls, "utf8");
    const result = runScript(join(root, "releases", B, "deploy/kaoiro-runner-update.sh"), ["--install-dir", root, "--service", "kogane468-test", "--tarball", codeOnly], { KAOIRO_SYSTEMCTL: ctl, NODE_OPTIONS: nodeOptions });
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${C}`);
    expect(readFileSync(calls, "utf8")).toBe(`${before}stop\nstart\n`);
  });

  describe("abandon", () => {
    const txPath = (uuid: string) => join(root, "codex-state/transactions", `${uuid}.json`);
    const readTx = (uuid: string) => JSON.parse(readFileSync(txPath(uuid), "utf8"));
    const rewrite = (uuid: string, edit: (tx: Record<string, unknown>) => void) => {
      const tx = readTx(uuid); edit(tx); writeFileSync(txPath(uuid), JSON.stringify(tx));
    };
    // The operator restarts the runner on the current release after an abort.
    const restart = () => {
      if (readFileSync(join(dir, "active"), "utf8") !== "active") expect(spawnSync(ctl, ["--user", "start", "kogane468-test"]).status).toBe(0);
      return JSON.parse(readFileSync(join(dir, "mainpid"), "utf8")) as { pid: number; start: string };
    };
    // Real aborts: remain-active fails the snapshot's stop check with the
    // transaction still prepared; late-unknown fails its inventory after
    // `stopped` is saved and before the staging directory exists.
    const strand = (trigger: "remain-active" | "late-unknown") => {
      writeFileSync(join(dir, trigger), "trigger");
      const result = update();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Codex state preparation failed");
      rmSync(join(dir, trigger));
      return forwardTransaction();
    };
    const retried = (uuid: string) => {
      const retry = update();
      expect(retry.status, retry.stderr).toBe(0);
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
      const others = readdirSync(join(root, "codex-state/transactions")).map((f) => f.slice(0, -5)).filter((id) => id !== uuid);
      expect(others.map((id) => readTx(id))).toEqual([expect.objectContaining({ mode: "forward", order: 2, phase: "awaiting-acceptance" })]);
    };

    it("abandons a forward stranded at prepared, after which the update retries", () => {
      const tx = strand("remain-active");
      expect(tx).toMatchObject({ mode: "forward", phase: "prepared" });
      restart();
      const stops = readFileSync(calls, "utf8");
      const blocked = update();
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("Recover or accept the previous Codex state transaction first");
      expect(readFileSync(calls, "utf8")).toBe(stops);
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ abandoned: tx.uuid, phase: "prepared" });
      const abandoned = readTx(tx.uuid);
      expect(abandoned).toEqual({ ...tx, phase: "retired", abandonment: { version: 1, abandoned: expect.any(String), phase: "prepared", ownerStatus: expect.stringMatching(/^(absent|pid-reused)$/) } });
      expect(existsSync(join(root, ".lock.update"))).toBe(false);
      expect(existsSync(join(root, ".lock.links"))).toBe(false);
      retried(tx.uuid);
      expect(readTx(tx.uuid)).toEqual(abandoned);
    });

    it("abandons a forward stranded at stopped before its snapshot wrote anything", () => {
      const tx = strand("late-unknown");
      expect(tx).toMatchObject({ mode: "forward", phase: "stopped" });
      expect(existsSync(tx.snapshot)).toBe(false);
      expect(existsSync(tx.staging)).toBe(false);
      rmSync(join(home, "unknown-token"));
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status, result.stderr).toBe(0);
      expect(readTx(tx.uuid)).toMatchObject({ phase: "retired", abandonment: { phase: "stopped" } });
      restart();
      retried(tx.uuid);
    });

    it("treats an owner PID reused by another process as gone", () => {
      const tx = strand("remain-active");
      const live = restart();
      rewrite(tx.uuid, (t) => { t.owner = { pid: live.pid, start: `${live.start}0` }; });
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status, result.stderr).toBe(0);
      expect(readTx(tx.uuid).abandonment).toMatchObject({ ownerStatus: "pid-reused" });
    });

    it("treats an owner PID with no /proc entry as absent", () => {
      const tx = strand("remain-active");
      const pidMax = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8"));
      rewrite(tx.uuid, (t) => { t.owner = { pid: pidMax + 1, start: "1" }; });
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status, result.stderr).toBe(0);
      expect(readTx(tx.uuid).abandonment).toMatchObject({ ownerStatus: "absent" });
    });

    type Refusal = [string, (tx: { uuid: string; snapshot: string; staging: string }) => void, string];
    const notForward = "Only a forward that stopped before its snapshot can be abandoned";
    const refusals: Refusal[] = [
      ["a live owner", (tx) => { const live = restart(); rewrite(tx.uuid, (t) => { t.owner = live; }); }, "State transaction owner is still running"],
      ["a malformed owner", (tx) => rewrite(tx.uuid, (t) => { t.owner = { pid: "1188303" }; }), "Malformed state transaction owner"],
      ...["snapshot-verified", "switch-authorized", "start-attempted", "awaiting-acceptance", "restored", "retired"].map((phase): Refusal =>
        [`phase ${phase}`, (tx) => rewrite(tx.uuid, (t) => { t.phase = phase; }), notForward]),
      ...["restore", "code-recovery"].map((mode): Refusal =>
        [`mode ${mode}`, (tx) => rewrite(tx.uuid, (t) => { t.mode = mode; t.backupUUID = "00000000-0000-4000-8000-000000000000"; }), notForward]),
      ["a staging path that is not its own", (tx) => rewrite(tx.uuid, (t) => { t.staging = join(dir, "elsewhere"); }), "Transaction staging path is not its own"],
      ["an existing snapshot directory", (tx) => mkdirSync(tx.snapshot), "Snapshot or staging exists"],
      ["a dangling symlink at the snapshot path", (tx) => symlinkSync(join(dir, "nowhere"), tx.snapshot), "Snapshot or staging exists"],
      ["an existing staging directory", (tx) => mkdirSync(tx.staging), "Snapshot or staging exists"],
      ["an existing backup reference", (tx) => writeFileSync(join(root, "codex-state/backups", `${tx.uuid}.json`), "{}", { mode: 0o600 }), "Snapshot or staging exists"],
      ["a legacy record", (tx) => rewrite(tx.uuid, (t) => { delete t.bindingReceiptVersion; }), "Legacy Codex transaction requires operator recovery or retirement"],
    ];
    it.each(refusals)("refuses %s and leaves the record unchanged", (_name, setup, message) => {
      const tx = strand("remain-active");
      setup(tx);
      const before = readFileSync(txPath(tx.uuid));
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status).toBe(78);
      expect(result.stderr).toContain(message);
      expect(readFileSync(txPath(tx.uuid))).toEqual(before);
    });

    // A lock someone else holds stays; a lock this run took is released.
    it.each([".lock.update", ".lock.links"])("refuses while %s is already held", (held) => {
      const tx = strand("remain-active");
      mkdirSync(join(root, held), { mode: 0o700 });
      const before = readFileSync(txPath(tx.uuid));
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status).toBe(78);
      expect(result.stderr).toContain("EEXIST");
      expect(readFileSync(txPath(tx.uuid))).toEqual(before);
      for (const lock of [".lock.update", ".lock.links"]) expect(existsSync(join(root, lock))).toBe(lock === held);
    });

    it("refuses an accepted forward", () => {
      expect(update().status).toBe(0);
      const tx = forwardTransaction();
      expect(stateAction("accept", root, tx.uuid, acceptance(tx)).status).toBe(0);
      const before = readFileSync(txPath(tx.uuid));
      const result = stateAction("abandon", root, tx.uuid);
      expect(result.status).toBe(78);
      expect(result.stderr).toContain(notForward);
      expect(readFileSync(txPath(tx.uuid))).toEqual(before);
    });
  });
});
