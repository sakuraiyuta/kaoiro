import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { absentHomeBoot } from "./codexBootFixture.js";
import { createStateFixture, interruptStateWorker, type StateFixture } from "./codexStateFixture.js";
import { makeReleaseTarball, revisionOf, runScript } from "./releaseFixture.js";

let h: StateFixture;
beforeEach(async () => { h = await createStateFixture(); });
afterEach(async () => { await h?.close(); });
const ok = (r: { status: number | null; stderr: string }) => expect(r.status, r.stderr).toBe(0);
const tx = () => h.records()[0]!;
const rewrite = (record: any) => writeFileSync(h.recordPath(record.uuid), JSON.stringify(record), { mode: 0o600 });
const codeOnly = (id: string) => runScript(join(h.root, "releases", h.B, "deploy/kaoiro-runner-switch.sh"), [id, "--install-dir", h.root], h.env());
const history = () => readFileSync(join(h.home, "sessions/old.jsonl"), "utf8");
const restoreCommand = () => ["--install-dir", h.root, "--service", "kogane468-test", "--restore-codex-backup", join(h.dir, "backup"), "--codex-home", h.home];

const interrupted = (args: string[], fault: Record<string, unknown>, boot?: () => void, whilePaused?: () => void) => interruptStateWorker(h,args,fault,boot,whilePaused);
const forwardArgs = () => ["--install-dir", h.root, "--service", "kogane468-test", "--tarball", h.tarball(), "--codex-home", h.home, "--codex-backup-dir", join(h.dir, "backup")];

describe.skipIf(process.platform !== "linux")("forward", { timeout: 30_000 }, () => {
  it("runs the shipped helper between stop and switch/start and completes without acceptance", () => {
    ok(h.forward());
    expect(h.callLog()).toBe("stop\nstart\n"); expect(h.current()).toBe(h.B);
    expect(tx()).toMatchObject({ schema: 2, phase: "completed", snapshot: { status: "retained" } });
    expect(tx()).not.toHaveProperty("acceptance"); expect(tx()).not.toHaveProperty("owner");
    expect(existsSync(join(h.dir, "backup/state/auth.json"))).toBe(false);
    expect(readFileSync(join(h.dir, "backup/state/sessions/old.jsonl"), "utf8")).toBe("HISTORY");
  });
  it("uses the physical updater after symlink entry and keeps the cooperative-writer warning", () => {
    const entry = join(h.root, "current/deploy/kaoiro-runner-update.sh");
    const r = runScript(entry, forwardArgs(), h.env()); ok(r);
    expect(r.stderr.match(/external Codex-home writers/g)).toHaveLength(1);expect(tx().tool).toBe(h.A);
  });
  it.each(["active", "next-path", "service"])("refuses unsafe post-start %s even when version succeeds", (fault) => {
    const ctl = readFileSync(h.ctl, "utf8");
    const changed = fault === "active" ? ctl.replace("fs.writeFileSync(dir+'/active','active'); child.unref();", "fs.writeFileSync(dir+'/active','inactive'); child.unref();")
      : fault === "next-path" ? ctl.replace("fs.appendFileSync(dir+'/calls','start\\n');", "fs.appendFileSync(dir+'/calls','start\\n');fs.appendFileSync(" + JSON.stringify(join(h.conf,"runner.env")) + ",'CODEX_HOME=/missing\\n');")
      : ctl.replace("MainPID:active?String(ownerPid):'0'", "MainPID:active && !fs.existsSync(dir+'/owned-pids/'+ownerPid+'.json')?String(ownerPid):'0'");
    expect(changed).not.toBe(ctl); writeFileSync(h.ctl, changed);
    const result=h.forward();expect(result.status).not.toBe(0);expect(tx().phase).toBe("start-intent");
    if(fault==="active")expect(result.stderr).toContain("Runner did not become active with a positive MainPID");
    if(fault==="service")expect(result.stderr).toContain("Runner activity is transitional or unknown");
  });
});

describe.skipIf(process.platform !== "linux")("snapshot-binding", { timeout: 30_000 }, () => {
  it.each(["uuid", "home", "source-home", "source-id", "source-native", "target-id", "target-native"])("rejects self-consistent snapshot metadata with crossed %s before stop", field => {
    ok(h.forward()); const record = tx(), path = join(h.dir, "backup/manifest.json"), m = JSON.parse(readFileSync(path,"utf8"));
    if (field === "uuid") m.uuid = "00000000-0000-4000-8000-000000000000";
    if (field === "home") m.home = join(h.dir, "other-home");
    if (field === "source-home") m.source.path = join(h.dir, "other-home");
    if (field === "source-id") m.sourceRelease.id = h.B;
    if (field === "source-native") m.sourceRelease.sha256 = "0".repeat(64);
    if (field === "target-id") m.targetRelease.id = h.A;
    if (field === "target-native") m.targetRelease.sha256 = "0".repeat(64);
    writeFileSync(path, JSON.stringify(m)); record.snapshot.manifestHash = createHash("sha256").update(readFileSync(path)).digest("hex"); rewrite(record);
    const before = h.callLog(); expect(h.restore().status).not.toBe(0); expect(h.callLog()).toBe(before); expect(h.current()).toBe(h.B);
  });
  it("refuses corrupt payload before stop or home replacement", () => {
    ok(h.forward()); const before=h.callLog(), ino=statSync(h.home).ino;
    writeFileSync(join(h.dir,"backup/state/sessions/old.jsonl"),"corrupt");
    expect(h.restore().status).not.toBe(0); expect(h.callLog()).toBe(before); expect(statSync(h.home).ino).toBe(ino);
  });
});

describe.skipIf(process.platform !== "linux")("path-agreement", { timeout: 30_000 }, () => {
  it.each(["requested", "next", "empty", "unset"])("refuses %s home disagreement before stop", field => {
    if (field === "requested") { const other=join(h.dir,"other"); mkdirSync(other,{mode:0o700}); writeFileSync(join(h.conf,"runner.env"),`CODEX_HOME='${other}'\n`,{mode:0o600}); }
    if (field === "next") writeFileSync(join(h.conf,"runner.env"),"CODEX_HOME='/missing'\n",{mode:0o600});
    if (field === "empty") writeFileSync(join(h.conf,"runner.env"),"CODEX_HOME=''\n",{mode:0o600});
    if (field === "unset") writeFileSync(join(h.conf,"runner.env"),"",{mode:0o600});
    const r=h.forward();expect(r.status).not.toBe(0);
    if (["empty","unset"].includes(field)) expect(r.stderr).toContain("explicit next-start CODEX_HOME");
    expect(h.callLog()).toBe(""); expect(h.current()).toBe(h.A);
  });
  it.each(["bytes", "config-inode", "home-inode"])("accepts same-path %s changes before restore", kind => {
    ok(h.forward());
    const env=join(h.conf,"runner.env");
    if (kind === "bytes") writeFileSync(env,`CODEX_HOME='${h.home}'\nTOKEN=changed\n`,{mode:0o600});
    if (kind === "config-inode") { renameSync(env,env+".old"); writeFileSync(env,`CODEX_HOME='${h.home}'\n`,{mode:0o600}); }
    if (kind === "home-inode") { renameSync(h.home,h.home+".old"); mkdirSync(h.home,{mode:0o700}); writeFileSync(join(h.home,"auth.json"),"CURRENT"); }
    ok(h.restore()); expect(h.current()).toBe(h.A); expect(history()).toBe("HISTORY");
  });
  it("refuses a path changed after preparation", () => {
    const ctl=readFileSync(h.ctl,"utf8");
    writeFileSync(h.ctl,ctl.replace("TOKEN=changed", "CODEX_HOME=/missing")); h.trigger("late-config");
    expect(h.forward().status).not.toBe(0); expect(h.current()).toBe(h.A); expect(h.callLog()).toBe("stop\n");
  });
});

describe.skipIf(process.platform !== "linux")("unfinished and locks", { timeout: 30_000 }, () => {
  it("excludes rival forward, restore, switch and prune while retaining source/target/tool", async () => {
    const tool=revisionOf("n2-physical-tool")+"-dirty";await h.close();h=await createStateFixture({toolId:tool});
    await interrupted(forwardArgs(),{phase:"snapshot-verified",when:"after"}); const uuid=tx().uuid;
    const before=h.callLog(); expect(h.forward("rival").status).not.toBe(0); expect(h.restore().status).not.toBe(0); expect(codeOnly(h.B).status).not.toBe(0); expect(h.state("prune",h.root,uuid).status).not.toBe(0);
    expect(h.callLog()).toBe(before); const r=h.state("protected",h.root); ok(r); expect(new Set(r.stdout.trim().split("\n"))).toEqual(new Set([h.A,h.B,tool]));
    ok(h.resume(uuid)); expect(tx().phase).toBe("completed");
  });
  it.each([".lock.update",".lock.links"])("preserves a held %s and takes no other unowned lock", lock => {
    mkdirSync(join(h.root,lock)); const r=h.forward(); expect(r.status).not.toBe(0); expect(existsSync(join(h.root,lock))).toBe(true); expect(h.callLog()).toBe("");
  });
  it("protects retained source only after completion and allows a same-native update", () => {
    ok(h.forward()); const r=h.state("protected",h.root); ok(r); expect(r.stdout.trim()).toBe(h.A); ok(h.forward("second"));
  });
});

describe.skipIf(process.platform !== "linux")("records and cutover", { timeout: 30_000 }, () => {
  it.each(["schema","uuid","root","home","service","staging","snapshot-path","asides","cleanup","source-id","target-id","source-native","target-native","tool"])("rejects malformed selected %s before mutation", field => {
    ok(h.forward()); const r=tx();
    if(field==="schema")r.schema=3;
    if(field==="uuid")r.uuid="00000000-0000-4000-8000-000000000000";
    if(field==="root")r.root=h.dir;
    if(field==="cleanup")r.cleanup={path:join(h.dir,"other-stage"),bytes:0,pending:true};
    if(field==="snapshot-path")r.snapshot.path="relative";
    if(field==="source-id")r.source.id="invalid";
    if(field==="target-id")r.target.id="invalid";
    if(field==="source-native")r.source.sha256="invalid";
    if(field==="target-native")r.target.sha256="invalid";
    if(field==="tool")r.tool="invalid";
    if(field==="home")r.home="relative";
    if(field==="service")r.service="other.service";
    if(field==="staging")r.snapshot.staging=join(h.dir,"other-stage");
    if(field==="asides")r.asides=[{attempt:r.uuid,aside:"/other"}];
    const path=h.recordPath(tx().uuid);writeFileSync(path,JSON.stringify(r));
    const before=h.callLog();expect(h.restore().status).not.toBe(0);expect(h.callLog()).toBe(before);
    if(field!=="service") { const inspect=h.state("inspect",h.root,path.split("/").at(-1)!.replace(/\.json$/,""));expect(inspect.status).not.toBe(0);if(field==="snapshot-path")expect(inspect.stderr).toContain("Malformed snapshot path"); }
  });
  it.each(["phase","retention","source"])("refuses unclassifiable protection %s", field=>{
    ok(h.forward());const r=tx();
    if(field==="phase")r.phase="unknown";
    if(field==="retention")r.snapshot.status="unknown";
    if(field==="source")r.source.id="unknown-id";
    rewrite(r);expect(h.state("protected",h.root).status).not.toBe(0);
  });
  it("does not scan optional historical diagnostics as authorization",()=>{
    ok(h.forward());const r=tx();r.created={malformed:"old diagnostic"};r.updaterPid="not-a-pid";rewrite(r);
    ok(h.state("protected",h.root));ok(h.forward("second"));
  });
  it.each(["prepared","stopped","snapshot-verified","switch-authorized","start-attempted","awaiting-acceptance","restore-prepared","restore-intent","quarantine-intent","quarantined","promote-intent","state-restored","code-recovery-prepared","credential-moved:auth.json","unknown"])("refuses old unfinished phase %s and changes no record bytes", phase=>{
    const dir=join(h.root,"codex-state/transactions");mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,"old.json");writeFileSync(path,JSON.stringify({schema:1,phase}),{mode:0o600});
    const before=readFileSync(path);const r=h.forward();expect(r.status).not.toBe(0);expect(r.stderr).toContain("previous tool release");expect(h.callLog()).toBe("");expect(readFileSync(path)).toEqual(before);expect(existsSync(join(h.root,"codex-state/v2"))).toBe(false);
    expect(h.state("protected",h.root).status).not.toBe(0);ok(h.state("inventory",h.root));
  });
  it.each([false,null,"yes"])("refuses old unretired backup %s", retired=>{
    const dir=join(h.root,"codex-state/backups");mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,"old.json"),JSON.stringify({retired}),{mode:0o600});
    expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe("");
  });
  it("allows all-terminal retired old records despite obsolete receipt damage and ignores barriers",()=>{
    for(const phase of ["completed","restored","retired"]){const dir=join(h.root,"codex-state/transactions");mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,phase+".json"),JSON.stringify({phase,acceptance:"malformed"}),{mode:0o600});}
    const dir=join(h.root,"codex-state/backups");mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,"old.json"),JSON.stringify({retired:true}),{mode:0o600});
    const barrier=join(h.root,"codex-state/barriers");mkdirSync(barrier,{mode:0o700});writeFileSync(join(barrier,"bad"),"invalid");symlinkSync("/missing",join(barrier,"dangling"));const ino=statSync(join(barrier,"bad")).ino;
    ok(h.forward());ok(h.restore());ok(h.state("prune",h.root,tx().uuid));expect(existsSync(join(barrier,"bad"))).toBe(true);expect(readFileSync(join(barrier,"bad"),"utf8")).toBe("invalid");expect(statSync(join(barrier,"bad")).ino).toBe(ino);expect(readlinkSync(join(barrier,"dangling"))).toBe("/missing");
  });
});

describe.skipIf(process.platform !== "linux")("prune and snapshot-residue", { timeout: 30_000 }, () => {
  it("discards a corrupt owned snapshot explicitly and never deletes its record or aside",()=>{
    ok(h.forward());ok(h.restore());const r=tx();writeFileSync(join(h.dir,"backup/state/sessions/old.jsonl"),"corrupt");
    ok(h.state("prune",h.root,r.uuid));ok(h.state("prune",h.root,r.uuid));expect(tx().snapshot.status).toBe("retired");expect(existsSync(h.recordPath(r.uuid))).toBe(true);expect(existsSync(r.replacement.aside)).toBe(true);expect(existsSync(join(h.dir,"backup"))).toBe(false);
  });
  it.each(["same-root","absent-root","reused-root","symlink"])("retries durable prune intent with %s", layout=>{
    ok(h.forward());const r=tx(),path=r.snapshot.path,st=statSync(path);r.prune={path,dev:st.dev,ino:st.ino,bytes:1,removed:false};r.snapshot.status="prune-intent";rewrite(r);
    if(layout==="same-root")rmSync(join(path,"manifest.json"));
    if(layout==="absent-root")rmSync(path,{recursive:true});
    if(layout==="reused-root"){renameSync(path,path+".original");mkdirSync(path,{mode:0o700});}
    if(layout==="symlink"){renameSync(path,join(h.dir,"original-record"));symlinkSync(join(h.dir,"original-record"),path);}
    const result=h.state("prune",h.root,r.uuid);
    if(["reused-root","symlink"].includes(layout)){expect(result.status).not.toBe(0);expect(existsSync(path)).toBe(true);expect(tx().snapshot.status).toBe("prune-intent");}
    else{ok(result);expect(tx().snapshot.status).toBe("retired");expect(existsSync(path)).toBe(false);}
  });
  it("recovers an invalid published destination into planned/failed then prunes without payload verification",async()=>{
    await interrupted(forwardArgs(),{to:"/backup",when:"after"});const r=tx();writeFileSync(join(h.dir,"backup/manifest.json"),"invalid");
    ok(h.resume(r.uuid,"recover"));expect(tx()).toMatchObject({phase:"failed",snapshot:{status:"planned"}});ok(h.state("prune",h.root,r.uuid));expect(tx().snapshot.status).toBe("retired");
  });
  it("recovers a verified record with a missing snapshot without activating the candidate",async()=>{
    await interrupted(forwardArgs(),{phase:"snapshot-verified",when:"after"});const uuid=tx().uuid;rmSync(join(h.dir,"backup"),{recursive:true});
    expect(h.resume(uuid).status).not.toBe(0);ok(h.resume(uuid,"recover"));expect(tx()).toMatchObject({phase:"failed",snapshot:{status:"retired"}});expect(h.current()).toBe(h.A);
  });
});

describe.skipIf(process.platform !== "linux")("pin-guard and old tools", { timeout: 30_000 }, () => {
  it("refuses cross-native code-only switching with zero link mutations",()=>{
    h.replace(h.B,{"node_modules/@openai/codex/vendor/fixture/bin/codex":"#!/bin/sh\n# different native\nexit 0\n"});
    const before=readlinkSync(join(h.root,"current"));expect(codeOnly(h.B).status).not.toBe(0);expect(readlinkSync(join(h.root,"current"))).toBe(before);expect(existsSync(join(h.root,"previous"))).toBe(false);
  });
  it.each(["source","target"])("refuses pre-N2 %s before stopping a state-aware forward", which=>{
    const id=which==="source"?h.A:h.B,helper=readFileSync(join(h.root,"releases",id,"deploy/kaoiro-runner-codex-state.mjs"),"utf8");
    h.replace(id,{"deploy/kaoiro-runner-codex-state.mjs":helper.replace("export const CODEX_STATE_SCHEMA = 2;","export const CODEX_STATE_SCHEMA = 1;")});
    const r=h.forward();expect(r.status).not.toBe(0);expect(h.callLog()).toBe("");expect(h.current()).toBe(h.A);
  });
  it("refuses a same-native pre-N2 activation while a v2 snapshot is retained",()=>{
    h.replace(h.B,{});ok(h.forward());const helper=readFileSync(join(h.root,"releases",h.A,"deploy/kaoiro-runner-codex-state.mjs"),"utf8");
    h.replace(h.A,{"deploy/kaoiro-runner-codex-state.mjs":helper.replace("export const CODEX_STATE_SCHEMA = 2;","export const CODEX_STATE_SCHEMA = 1;")});
    expect(codeOnly(h.A).status).not.toBe(0);expect(h.current()).toBe(h.B);ok(h.state("prune",h.root,tx().uuid));ok(codeOnly(h.A));
  });
});

describe.skipIf(process.platform !== "linux")("capacity, classification and stopped service", { timeout: 30_000 }, () => {
  it("refuses unclassified names before stopping or publishing a record",()=>{
    writeFileSync(join(h.home,"unknown-token"),"secret");expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe("");expect(existsSync(join(h.root,"codex-state/v2"))).toBe(false);
  });
  it("refuses an inactive source before a new forward",()=>{
    writeFileSync(join(h.dir,"active"),"inactive");expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe("");
  });
  it("refuses missing unified cgroup v2 before stop or snapshot",()=>{
    rmSync(join(h.dir,"fake-cgroup/cgroup.controllers"));const r=h.forward();expect(r.status).not.toBe(0);expect(r.stderr).toContain("unified cgroup v2");expect(h.callLog()).toBe("");
  });
  it("refuses a still-active service before copy/switch/start",()=>{
    h.trigger("remain-active");const ino=statSync(h.home).ino;expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe("stop\n");expect(h.current()).toBe(h.A);expect(statSync(h.home).ino).toBe(ino);expect(existsSync(join(h.dir,"backup"))).toBe(false);
  });
});


describe.skipIf(process.platform !== "linux")("live environment source", { timeout: 30_000 }, () => {
  it("reads a live default from real child HOME rather than next-start HOME",async()=>{
    await h.close(); h=await createStateFixture({liveDefault:true});
    h.trigger("manager-extra","HOME=/different-next-home\n");ok(h.forward());expect(tx().home).toBe(join(h.ordinary,".codex"));
  });
  it("refuses unknown live HOME even when next-start has an explicit equal path",async()=>{
    await h.close(); h=await createStateFixture({liveHomeMissing:true});const result=h.forward();expect(result.status).not.toBe(0);expect(result.stderr).toContain("Cannot establish running HOME");expect(h.callLog()).toBe("");
  });
  it("reads the manager-selected literal runner.env without executing its values",()=>{
    const path=join(h.conf,"alternate.env");writeFileSync(path,`CODEX_HOME='${h.home}'\n`,{mode:0o600});h.trigger("manager-extra",`KAOIRO_RUNNER_ENV=${path}\n`);ok(h.forward());
    writeFileSync(path,"CODEX_HOME='$(touch /not-executed)'\n",{mode:0o600});const before=h.callLog();expect(h.restore().status).not.toBe(0);expect(h.callLog()).toBe(before);
  });
});


describe.skipIf(process.platform !== "linux")("protection concurrency", { timeout: 45_000 }, () => {
  it("serializes actual install replacement with record publication and preserves the in-flight tool",async()=>{
    const tool=revisionOf("n2-physical-tool")+"-dirty";
    await h.close();h=await createStateFixture({toolId:tool});
    const out=join(h.dir,"tool-archive");mkdirSync(out);const archive=makeReleaseTarball(out,tool.replace(/-dirty$/,""),{dirty:true});
    const install=()=>runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-install.sh"),[archive,"--install-dir",h.root,"--allow-dirty"],h.env());
    let contention: ReturnType<typeof install> | undefined;
    await interrupted(forwardArgs(),{phase:"prepared",when:"after"},undefined,()=>{contention=install();});
    expect(contention!.status,contention!.stderr).toBe(75);
    const after=install();expect(after.status).not.toBe(0);expect(after.stderr).toContain("protected by a Codex backup");
    const r=h.state("protected",h.root);ok(r);expect(new Set(r.stdout.trim().split("\n"))).toEqual(new Set([h.A,h.B,tool]));
    ok(h.resume(tx().uuid));const terminal=h.state("protected",h.root);ok(terminal);expect(terminal.stdout.trim()).toBe(h.A);ok(install());
  });
});

describe.skipIf(process.platform !== "linux")("selected file privacy and capability grammar", { timeout: 30_000 }, () => {
  it.each(["mode","symlink","uid","hardlink","malformed-json"])("refuses selected record %s without printing its contents",kind=>{
    ok(h.forward());const path=h.recordPath(tx().uuid);
    if(kind==="mode")chmodSync(path,0o644);
    if(kind==="hardlink")linkSync(path,join(h.dir,"other-record-link"));
    if(kind==="uid"){const preload=join(h.dir,"fault-preload.mjs");writeFileSync(preload,readFileSync(preload,"utf8")+`\nconst stat=fs.lstatSync;fs.lstatSync=(p,...a)=>{const st=stat(p,...a);if(String(p)===${JSON.stringify(path)})st.uid+=1;return st};syncBuiltinESMExports();\n`);}
    if(kind==="symlink"){renameSync(path,join(h.dir,"original-record"));symlinkSync(join(h.dir,"original-record"),path);}
    if(kind==="malformed-json")writeFileSync(path,"PRIVATE_SENTINEL_CONTENT");
    const r=h.state("protected",h.root);expect(r.status).not.toBe(0);expect(r.stderr).not.toContain("PRIVATE_SENTINEL_CONTENT");
  });
  it("requires the explicitly requested snapshot path before any service call",()=>{
    ok(h.forward());const before=h.callLog();const r=h.restore("different-selection");expect(r.status).not.toBe(0);expect(r.stderr).toContain("No unique retained snapshot matches selection");expect(h.callLog()).toBe(before);
  });
  it.each(["duplicate","format","unsupported"])("refuses source capability %s before stopping",form=>{
    const helper=readFileSync(join(h.root,"releases",h.A,"deploy/kaoiro-runner-codex-state.mjs"),"utf8");
    const line="export const CODEX_STATE_SCHEMA = 2;";
    const replacement=form==="duplicate"?line+"\n"+line:form==="format"?"export const CODEX_STATE_SCHEMA=2;":"export const CODEX_STATE_SCHEMA = 3;";
    h.replace(h.A,{"deploy/kaoiro-runner-codex-state.mjs":helper.replace(line,replacement)});
    const r=h.forward();expect(r.status).not.toBe(0);expect(h.callLog()).toBe("");if(form==="duplicate")expect(r.stderr).toContain("Ambiguous Codex state capability");
  });
  it("accepts a CRLF capability line from the verified source without executing that source helper",()=>{
    const helper=readFileSync(join(h.root,"releases",h.A,"deploy/kaoiro-runner-codex-state.mjs"),"utf8");
    h.replace(h.A,{"deploy/kaoiro-runner-codex-state.mjs":helper.replace("export const CODEX_STATE_SCHEMA = 2;","export const CODEX_STATE_SCHEMA = 2;\r")+"\nthrow new Error('Source helper must not be executed during admission');\n"});ok(h.forward());
  });
});


describe.skipIf(process.platform !== "linux")("recursive prune interruption", { timeout: 45_000 }, () => {
  it("persists prune intent before actual partial recursive deletion and completes without intact payload",async()=>{
    ok(h.forward());const record=tx(),root=join(h.dir,"backup"),files=join(root,"state/sessions");
    for(let i=0;i<10000;i++)writeFileSync(join(files,`partial-${String(i).padStart(5,"0")}`),"x");
    const before=readdirSync(files).length;
    const worker=h.spawnHelper(["prune",h.root,record.uuid]);
    let partial=false;
    const deadline=Date.now()+15000;
    while(Date.now()<deadline && worker.exitCode===null){
      if(existsSync(files)){const left=readdirSync(files).length;if(left>0 && left<before){partial=true;worker.kill("SIGKILL");break;}}
      await new Promise(resolve=>setTimeout(resolve,1));
    }
    if(worker.exitCode===null && worker.signalCode===null && !partial)worker.kill("SIGKILL");
    await new Promise<void>(resolve=>{if(worker.exitCode!==null || worker.signalCode!==null)resolve();else worker.once("exit",()=>resolve());});
    expect(partial).toBe(true);expect(existsSync(root)).toBe(true);expect(tx().snapshot.status).toBe("prune-intent");
    for(const lock of [".lock.update",".lock.links"])rmSync(join(h.root,lock),{recursive:true});
    ok(h.state("prune",h.root,record.uuid));expect(tx().snapshot.status).toBe("retired");expect(existsSync(root)).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("persisted deletion checkpoints", { timeout: 30_000 }, () => {
  it("publishes prune intent before the actual recursive removal call",()=>{
    ok(h.forward());ok(h.state("prune",h.root,tx().uuid));
    const observations=readFileSync(join(h.dir,"removal-observations"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
    expect(observations.find(r=>!r.stage)).toMatchObject({pruneIntent:true});
  });
  it("publishes owned staging cleanup before the actual removal call",()=>{
    const preload=join(h.dir,"fault-preload.mjs");writeFileSync(preload,readFileSync(preload,"utf8")+"\nfs.copyFileSync=()=>{throw new Error('copy fault')};syncBuiltinESMExports();\n");
    expect(h.forward().status).not.toBe(0);const observations=readFileSync(join(h.dir,"removal-observations"),"utf8").trim().split("\n").map(s=>JSON.parse(s));
    expect(observations.find(r=>r.stage)).toMatchObject({cleanupPending:true});expect(tx().cleanup.pending).toBe(false);expect(existsSync(tx().cleanup.path)).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("admission and mutation entrances", { timeout: 35_000 }, () => {
  it("refuses a real live-home mismatch even though next-start and requested home agree",async()=>{
    await h.close();h=await createStateFixture({liveDifferent:true});expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe("");
  });
  it("checks the recorded installed service on a resumed operation",()=>{
    ok(h.forward());const record=tx();record.service="other.service";rewrite(record);const before=h.callLog();
    expect(h.resume(record.uuid).status).not.toBe(0);expect(h.callLog()).toBe(before);
  });
  it.each(["transaction","backup"])("blocks every remaining mutation entrance on an unresolved old %s",kind=>{
    ok(h.forward());const record=tx(),old=join(h.root,"codex-state",kind==="transaction"?"transactions":"backups");mkdirSync(old,{mode:0o700});
    const path=join(old,"old.json");writeFileSync(path,JSON.stringify(kind==="transaction"?{phase:"prepared"}:{retired:false}),{mode:0o600});
    const oldBytes=readFileSync(path),v2Bytes=readFileSync(h.recordPath(record.uuid)),before=h.callLog();
    mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    for(const args of [["guard",h.root,h.B],["preflight",h.root,h.B,record.uuid],["prepare",h.root,h.B,h.home,join(h.dir,"rival"),"kogane468-test",h.B,"1"],["prepare-restore",h.root,record.snapshot.path,h.home,"kogane468-test",h.B],["run",h.root,record.uuid,"resume"],["protected",h.root]])expect(h.state(...args).status,args[0]).not.toBe(0);
    rmSync(join(h.root,".lock.update"),{recursive:true});
    for(const action of ["resume","recover","prune"])expect(h.state(action,h.root,record.uuid).status,action).not.toBe(0);
    expect(readFileSync(path)).toEqual(oldBytes);expect(readFileSync(h.recordPath(record.uuid))).toEqual(v2Bytes);expect(h.callLog()).toBe(before);expect(h.current()).toBe(h.B);
  });
  it("refuses guard, preflight, run and prune with another unresolved operation",()=>{
    ok(h.forward());const record=tx(),rival={...record,uuid:"00000000-0000-4000-8000-000000000001",phase:"prepared"};rewrite(rival);
    const before=h.callLog(),bytes=readFileSync(h.recordPath(record.uuid));mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    for(const action of ["guard","preflight"])expect(h.state(action,h.root,h.B,record.uuid).status,action).not.toBe(0);
    expect(h.state("run",h.root,record.uuid,"resume").status).not.toBe(0);rmSync(join(h.root,".lock.update"),{recursive:true});
    expect(h.state("prune",h.root,record.uuid).status).not.toBe(0);expect(h.restore().status).not.toBe(0);expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);expect(h.callLog()).toBe(before);
  });
  it("preserves another worker's update lock for resume, recover and prune",()=>{
    ok(h.forward());const bytes=readFileSync(h.recordPath(tx().uuid));mkdirSync(join(h.root,".lock.update"),{mode:0o700});writeFileSync(join(h.root,".lock.update/sentinel"),"held");
    for(const action of ["resume","recover","prune"])expect(h.state(action,h.root,tx().uuid).status).not.toBe(0);
    expect(readFileSync(join(h.root,".lock.update/sentinel"),"utf8")).toBe("held");expect(readFileSync(h.recordPath(tx().uuid))).toEqual(bytes);expect(existsSync(tx().snapshot.path)).toBe(true);
  });
});

describe.skipIf(process.platform !== "linux")("post-start release and live-home checks", { timeout: 30_000 }, () => {
  it.each(["current","artifact","live-home"])("does not settle a forward after post-start %s changes",fault=>{
    let ctl=readFileSync(h.ctl,"utf8");
    if(fault==="current")ctl=ctl.replace("fs.appendFileSync(dir+'/calls','start\\n');",`fs.appendFileSync(dir+'/calls','start\\n');fs.unlinkSync(root+'/current');fs.symlinkSync('releases/${h.A}',root+'/current');`);
    if(fault==="artifact")ctl=ctl.replace("fs.appendFileSync(dir+'/calls','start\\n');",`fs.appendFileSync(dir+'/calls','start\\n');fs.appendFileSync(root+'/releases/${h.B}/dist/stub_dep.js','\\n// post-start artifact change\\n');`);
    if(fault==="live-home")ctl=ctl.replace(`CODEX_HOME:${JSON.stringify(h.home)}`,`CODEX_HOME:${JSON.stringify(h.ordinary)}`);
    expect(ctl).not.toBe(readFileSync(h.ctl,"utf8"));writeFileSync(h.ctl,ctl);
    const result=h.forward();expect(result.status).not.toBe(0);expect(tx().phase).toBe("start-intent");
    if(fault==="current")expect(result.stderr).toContain("Current differs from startup target");
  });
});


describe.skipIf(process.platform !== "linux")("capacity and stopped rechecks", { timeout: 30_000 }, () => {
  it("checks capacity before stop and record publication",()=>{
    const preload=join(h.dir,"fault-preload.mjs");writeFileSync(preload,readFileSync(preload,"utf8")+"\nconst statfs=fs.statfsSync;fs.statfsSync=p=>({...statfs(p),bavail:0});syncBuiltinESMExports();\n");
    expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe("");expect(existsSync(join(h.root,"codex-state/v2"))).toBe(false);
  });
  it.each(["mainpid","descendants"])("refuses stopped %s evidence before copy and switch",kind=>{
    if(kind==="mainpid"){const ctl=readFileSync(h.ctl,"utf8");writeFileSync(h.ctl,ctl.replace("MainPID:active?String(ownerPid):'0'","MainPID:active?String(ownerPid):'123'"));}else h.trigger("late-populated");
    const ino=statSync(h.home).ino;
    expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe(kind==="descendants"?"stop\nstart\n":"stop\n");expect(existsSync(join(h.dir,"backup"))).toBe(false);expect(h.current()).toBe(h.A);
    expect(statSync(h.home).ino).toBe(ino);expect(history()).toBe("HISTORY");expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe("CURRENT_TOKEN");
  });
});

describe.skipIf(process.platform !== "linux")("per-entry unfinished exclusion", { timeout: 30_000 }, () => {
  it.each(["guard","preflight","run","prepare","prepare-restore","prune"])("refuses %s before its first mutation with a second unfinished operation",action=>{
    ok(h.forward());const record=tx(),rival={...record,uuid:"00000000-0000-4000-8000-000000000001",phase:"prepared",snapshot:{...record.snapshot,path:join(h.dir,"other-snapshot"),staging:join(h.dir,".staging.codex-00000000-0000-4000-8000-000000000001")}};rewrite(rival);
    if(["guard","preflight","run"].includes(action)){record.phase="start-intent";rewrite(record);}
    if(action==="guard")ok(spawnSync(h.ctl,["--user","stop","kogane468-test"],{encoding:"utf8"}));
    const before=h.callLog(),bytes=readFileSync(h.recordPath(record.uuid)),rivalBytes=readFileSync(h.recordPath(rival.uuid));
    if(action!=="prune")mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    if(action==="guard")mkdirSync(join(h.root,".lock.links"),{mode:0o700});
    const args=action==="guard" || action==="preflight"?[action,h.root,h.B,record.uuid]:action==="prepare"?[action,h.root,h.B,h.home,join(h.dir,"rival"),"kogane468-test",h.B,"1"]:action==="prepare-restore"?[action,h.root,record.snapshot.path,h.home,"kogane468-test",h.B]:[action,h.root,record.uuid,"resume"];
    const r=h.state(...args);expect(r.status,r.stderr).not.toBe(0);expect(r.stderr).toContain("Unresolved Codex transaction requires recovery");expect(h.callLog()).toBe(before);expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);expect(readFileSync(h.recordPath(rival.uuid))).toEqual(rivalBytes);expect(existsSync(record.snapshot.path)).toBe(true);expect(h.records()).toHaveLength(2);
  });
});


describe.skipIf(process.platform !== "linux")("development activation option", { timeout: 35_000 }, () => {
  it.each(["forward","resume"])("preserves explicit allow-dirty through a state-aware %s",async mode=>{
    const native=readFileSync(join(h.root,"releases",h.B,"node_modules/@openai/codex/vendor/fixture/bin/codex"),"utf8");
    const preload=join(h.dir,"fault-preload.mjs");writeFileSync(preload,readFileSync(preload,"utf8")+'\nglobalThis.fetch=async()=>new Response(JSON.stringify({status:"ok",build_identity_formats:["legacy-calver","landing-calver-v1"]}),{status:200});\n');
    h.replace(h.B,{"dist/build-info.json":JSON.stringify({...JSON.parse(readFileSync(join(h.root,"releases",h.B,"dist/build-info.json"),"utf8")),version:"untagged",branch:"fixture"}),"node_modules/@openai/codex/vendor/fixture/bin/codex":native});
    if(mode==="forward"){const rejected=h.forward();expect(rejected.status).not.toBe(0);expect(h.callLog()).toBe("");ok(h.resume(tx().uuid,"recover"));ok(h.forward("allowed",["--allow-dirty"]));}
    else{await interrupted([...forwardArgs(),"--allow-dirty"],{phase:"start-intent",when:"after"});const uuid=tx().uuid;expect(h.resume(uuid).status).not.toBe(0);ok(h.resume(uuid,"resume",["--allow-dirty"]));}
    expect(h.records().filter(r=>r.phase==="completed")).toHaveLength(1);expect(h.current()).toBe(h.B);
  });
});

describe.skipIf(process.platform !== "linux")("pending owned cleanup", { timeout: 30_000 }, () => {
  it("keeps failed staging cleanup named and retries it without discarding state",()=>{
    const preload=join(h.dir,"fault-preload.mjs");
    writeFileSync(preload,readFileSync(preload,"utf8")+`\nconst savedRemove=fs.rmSync;fs.rmSync=(path,...args)=>{if(String(path).includes('/.staging.codex-')&&!fs.existsSync(dir+'/cleanup-failed')){fs.writeFileSync(dir+'/cleanup-failed','once');throw Error('cleanup interrupted')}return savedRemove(path,...args)};fs.copyFileSync=()=>{throw Error('copy interrupted')};syncBuiltinESMExports();\n`);
    expect(h.forward().status).not.toBe(0);const record=tx();expect(record.phase).toBe("failed");expect(record.cleanup.pending).toBe(true);expect(existsSync(record.cleanup.path)).toBe(true);expect(record.cleanup.path).toBe(record.snapshot.staging);expect(record.cleanup.bytes).toBeGreaterThanOrEqual(0);
    ok(h.resume(record.uuid,"recover"));expect(tx().cleanup.pending).toBe(false);expect(existsSync(record.cleanup.path)).toBe(false);expect(history()).toBe("HISTORY");expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe("CURRENT_TOKEN");
  });
  it("does not adopt or remove an unrecorded orphan staging directory",()=>{
    const path=join(h.dir,".staging.codex-00000000-0000-4000-8000-000000000000");mkdirSync(path,{mode:0o700});writeFileSync(join(path,"sentinel"),"orphan");
    ok(h.forward());expect(readFileSync(join(path,"sentinel"),"utf8")).toBe("orphan");expect(tx().snapshot.staging).not.toBe(path);
  });
});

describe.skipIf(process.platform !== "linux")("internal operation options", { timeout: 30_000 }, () => {
  it("rejects unknown mode and development option before touching a completed operation",()=>{
    ok(h.forward());const record=tx(),bytes=readFileSync(h.recordPath(record.uuid)),before=h.callLog();mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    for(const [mode,allow,message] of [["unknown","no","Unknown Codex operation mode"],["resume","unknown","Invalid development activation option"]] as const){
      const r=h.state("run",h.root,record.uuid,mode,allow);expect(r.status).not.toBe(0);expect(r.stderr).toContain(message);
    }
    expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);expect(h.callLog()).toBe(before);
  });
});

describe.skipIf(process.platform !== "linux")("post-start machine attestation", { timeout: 30_000 }, () => {
  it.each(["wrong-revision","malformed-json"])("retains start-intent when the actual CLI reports %s",fault=>{
    const cli=readFileSync(join(h.root,"releases",h.B,"dist/cli.js"),"utf8"),native=readFileSync(join(h.root,"releases",h.B,"node_modules/@openai/codex/vendor/fixture/bin/codex"),"utf8");
    const changed=fault==="wrong-revision"?cli.replace("...{}",`...{revision:${JSON.stringify(h.A)}}`):cli.replace("JSON.stringify(machine)",'"{malformed"');expect(changed).not.toBe(cli);
    h.replace(h.B,{"dist/cli.js":changed,"node_modules/@openai/codex/vendor/fixture/bin/codex":native});
    const r=h.forward();expect(r.status).not.toBe(0);expect(r.stderr).toContain("Runner artifact attestation failed after start");expect(tx().phase).toBe("start-intent");expect(h.current()).toBe(h.B);
  });
});


describe.skipIf(process.platform !== "linux")("managed child environments", { timeout: 30_000 }, () => {
  const lines = (name: string): any[] => existsSync(join(h.dir, name)) ? readFileSync(join(h.dir, name), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const inert = { GH_TOKEN: "ambient-gh-inert", EXTRA_SECRET: "ambient-extra-inert", KAOIRO_RUNNER_TOKEN: "ambient-runner-token-inert" };
  const recordAttestation = () => {
    const cli=readFileSync(join(h.root,"releases",h.B,"dist/cli.js"),"utf8"),native=readFileSync(join(h.root,"releases",h.B,"node_modules/@openai/codex/vendor/fixture/bin/codex"),"utf8");
    const site='if (process.argv.includes("--version")) {';
    const changed=`import { appendFileSync as recordEnvironment } from "node:fs";\n`+cli.replace(site,`${site}\nrecordEnvironment(${JSON.stringify(join(h.dir,"attest-env.jsonl"))}, JSON.stringify({ argv: process.argv.slice(1), env: process.env }) + "\\n");`);
    expect(changed).toContain(`${site}\nrecordEnvironment(`);
    h.replace(h.B,{"dist/cli.js":changed,"node_modules/@openai/codex/vendor/fixture/bin/codex":native});
  };
  it("closes both helper children to their keys while the parent keeps the inherited secrets and loader", () => {
    recordAttestation();
    const marker=join(h.dir,"marker.cjs"),runtime=join(h.dir,"runtime"),xdg=join(h.dir,"xdg");
    writeFileSync(marker,`require("node:fs").appendFileSync(${JSON.stringify(join(h.dir,"marker.jsonl"))}, JSON.stringify({ argv: process.argv.slice(1), secrets: process.env.EXTRA_SECRET === ${JSON.stringify(inert.EXTRA_SECRET)} }) + "\\n");\n`);
    writeFileSync(join(h.dir,"record-child-env"),"");
    const base=h.env();
    // The ambient CODEX_HOME differs from runner.env's: the attestation shim
    // sources runner.env, so its values are expected there and the ambient
    // one is not.
    const env: Record<string, string | undefined>={ ...base, ...inert, NODE_OPTIONS:`${base.NODE_OPTIONS} --require=${marker}`, BASH_ENV:join(h.dir,"bash-env"), ENV:join(h.dir,"sh-env"),
      CODEX_HOME:join(h.dir,"ambient-codex-home"), XDG_RUNTIME_DIR:runtime, DBUS_SESSION_BUS_ADDRESS:`unix:path=${join(runtime,"bus")}`, XDG_CONFIG_HOME:xdg };
    ok(runScript(h.updater, forwardArgs(), env));
    expect(tx().phase).toBe("completed");
    const parents=lines("marker.jsonl");
    expect(parents.some(m=>m.argv[0]?.endsWith("/kaoiro-runner-codex-state.mjs") && m.argv[1]==="run" && m.secrets)).toBe(true);
    expect(parents.filter(m=>["guard","promote"].includes(m.argv[1]) || m.argv[0]?.endsWith("/dist/cli.js"))).toEqual([]);
    const closed=(child: any) => {
      for (const value of Object.values(inert)) expect(JSON.stringify(child.env)).not.toContain(value);
      expect(child.env.NODE_OPTIONS ?? "").not.toContain(marker);
      for (const key of ["BASH_ENV","ENV","KAOIRO_RUNNER_CONFIG","KAOIRO_RUNNER_SERVER_URL"]) expect(child.env[key],key).toBeUndefined();
    };
    const nested=lines("child-env.jsonl").filter(c=>c.argv.some((a: string)=>a.endsWith("/kaoiro-runner-codex-state.mjs")) && ["guard","promote"].some(action=>c.argv.includes(action)));
    expect(new Set(nested.map(c=>c.argv.find((a: string)=>["guard","promote"].includes(a))))).toEqual(new Set(["guard","promote"]));
    for (const child of nested) {
      closed(child);
      expect(child.env).toMatchObject({ KAOIRO_SYSTEMCTL:h.ctl, KAOIRO_NODE:base.KAOIRO_NODE, XDG_RUNTIME_DIR:runtime, DBUS_SESSION_BUS_ADDRESS:env.DBUS_SESSION_BUS_ADDRESS });
      for (const key of ["CODEX_HOME","KAOIRO_RUNNER_DIR","KAOIRO_RUNNER_ENV","XDG_CONFIG_HOME"]) expect(child.env[key],key).toBeUndefined();
    }
    const attested=lines("attest-env.jsonl");
    expect(attested).toHaveLength(1);
    closed(attested[0]);
    expect(attested[0].env).toMatchObject({ KAOIRO_NODE:process.execPath, KAOIRO_RUNNER_DIR:h.conf, KAOIRO_RUNNER_ENV:join(h.conf,"runner.env"), XDG_CONFIG_HOME:xdg, CODEX_HOME:h.home });
    for (const key of ["KAOIRO_SYSTEMCTL","XDG_RUNTIME_DIR","DBUS_SESSION_BUS_ADDRESS"]) expect(attested[0].env[key],key).not.toBe(env[key]);
  });
  it.each(["KAOIRO_RUNNER_DIR","KAOIRO_RUNNER_ENV","XDG_CONFIG_HOME"] as const)("lets the attestation shim find runner.env through %s alone",selector=>{
    const alt=join(h.dir,"alt-config"),recorder=join(h.dir,"selector-node.sh");
    writeFileSync(recorder,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(h.dir,"selector.log")}'\nexec '${process.execPath}' "$@"\n`,{mode:0o755});
    const env: Record<string, string | undefined>={ ...h.env() };
    delete env.KAOIRO_RUNNER_DIR; delete env.KAOIRO_RUNNER_ENV; delete env.XDG_CONFIG_HOME;
    const file=selector==="KAOIRO_RUNNER_DIR"?join(alt,"runner.env"):selector==="KAOIRO_RUNNER_ENV"?join(alt,"selected.env"):join(alt,"kaoiro/runner.env");
    env[selector]=selector==="KAOIRO_RUNNER_ENV"?file:alt;
    mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,`KAOIRO_NODE='${recorder}'\n`,{mode:0o600});
    ok(runScript(h.updater, forwardArgs(), env));
    expect(readFileSync(join(h.dir,"selector.log"),"utf8")).toMatch(/\/dist\/cli\.js --version --json$/m);
  });
});

describe.skipIf(process.platform !== "linux")("common release-prune reader", { timeout: 45_000 }, () => {
  const exercise = async (mode: "state-aware" | "ordinary", action: "keep" | "replace" | "move-current" | "unreadable-current" | "fail-reader") => {
    const C=revisionOf("n2-prune-tool")+"-dirty";
    await h.close();h=await createStateFixture({toolId:C});ok(h.forward());
    const original=tx(),script=join(h.root,"releases",C,"deploy/kaoiro-runner-update.sh");
    const marker=join(h.dir,"prune-ready"),cont=join(h.dir,"prune-continue");
    const text=readFileSync(script,"utf8"),site="# --- prune: only now, and never what current / previous point at. The runner";
    expect(text).toContain(site);
    writeFileSync(script,text.replace(site,`touch '${marker}'\nwhile [ ! -f '${cont}' ]; do sleep 0.02; done\n${site}`));
    const generator=join(import.meta.dirname,"../../scripts/build-release-manifest.mjs");
    expect(spawnSync(process.execPath,[generator,join(h.root,"releases",C)]).status).toBe(0);
    const out=join(h.dir,"archives");mkdirSync(out);
    const D=revisionOf("n2-prune-target"),native=readFileSync(join(h.root,"releases",h.B,"node_modules/@openai/codex/vendor/fixture/bin/codex"),"utf8");
    const target=makeReleaseTarball(out,D,{extraFiles:{"node_modules/@openai/codex/vendor/fixture/bin/codex":native}});
    const args=["--install-dir",h.root,"--service","kogane468-test","--tarball",target,"--keep","1"];
    if(mode==="state-aware")args.push("--codex-home",h.home,"--codex-backup-dir",join(h.dir,"second"));
    const worker=h.spawnWorker(args),closed=new Promise<void>(resolve=>worker.once("close",()=>resolve()));
    try{
      const deadline=Date.now()+20000;
      while(!existsSync(marker) && Date.now()<deadline && worker.exitCode===null)await new Promise(resolve=>setTimeout(resolve,10));
      expect(existsSync(marker),h.workerOutput()).toBe(true);expect(h.current()).toBe(D);
      expect(h.records().every(record=>record.phase==="completed")).toBe(true);
      const before=readdirSync(join(h.root,"releases")).sort();
      if(action==="replace"){
        const old=gunzipSync(readFileSync(join(import.meta.dirname,"fixtures/codex-state-d3a08013.mjs.gz")));
        expect(createHash("sha256").update(old).digest("hex")).toBe("69256ebce16c669b3aeb2c0bc71089aa0eef258b0b66218f874ca7b159213f51");
        const prior=makeReleaseTarball(out,C.slice(0,40),{dirty:true,extraFiles:{"deploy/kaoiro-runner-codex-state.mjs":old.toString("utf8")}});
        ok(runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-install.sh"),[prior,"--install-dir",h.root,"--allow-dirty"],h.env()));
        expect(readFileSync(join(h.root,"releases",C,"deploy/kaoiro-runner-codex-state.mjs"))).toEqual(old);
        const stale=spawnSync(process.execPath,[join(h.root,"releases",C,"deploy/kaoiro-runner-codex-state.mjs"),"protected",h.root],{env:h.env(),encoding:"utf8"});
        expect(stale.status,stale.stderr).toBe(0);expect(stale.stdout.trim()).toBe("");
        const currentReader=spawnSync(process.execPath,[join(h.root,"releases",D,"deploy/kaoiro-runner-codex-state.mjs"),"protected",h.root],{env:h.env(),encoding:"utf8"});
        expect(currentReader.status,currentReader.stderr).toBe(0);expect(currentReader.stdout.trim().split("\n")).toContain(h.A);
      }
      if(action==="move-current")ok(runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-switch.sh"),[h.B,"--install-dir",h.root],h.env()));
      if(action==="unreadable-current"){rmSync(join(h.root,"current"));writeFileSync(join(h.root,"current"),"not a symlink");}
      if(action==="fail-reader")writeFileSync(join(h.root,"releases",D,"deploy/kaoiro-runner-codex-state.mjs"),"process.exit(67);\n");
      writeFileSync(cont,"continue");await closed;
      expect(h.records().find(record=>record.uuid===original.uuid)?.snapshot.status).toBe("retained");
      expect(existsSync(original.snapshot.path)).toBe(true);expect(existsSync(join(h.root,"releases",h.A))).toBe(true);
      if(action==="move-current" || action==="unreadable-current"){
        expect(worker.exitCode).toBe(75);expect(h.workerOutput()).toContain(`current is ${action==="move-current"?"releases/"+h.B:"<unreadable>"}; expected releases/${D}; release pruning skipped; a later update retries`);
        expect(h.workerOutput()).not.toContain("is running release");
      } else if(action==="fail-reader"){
        expect(worker.exitCode).toBe(78);expect(h.workerOutput()).toContain("Cannot determine retained Codex releases");
      } else expect(worker.exitCode,h.workerOutput()).toBe(0);
      if(action==="keep"){
        expect(existsSync(join(h.root,"releases",C))).toBe(false);
        ok(runScript(join(h.root,"releases",D,"deploy/kaoiro-runner-update.sh"),["--install-dir",h.root,"--service","kogane468-test","--restore-codex-backup",original.snapshot.path,"--codex-home",h.home],h.env()));
        expect(h.current()).toBe(h.A);expect(history()).toBe("HISTORY");
      }
      if(!["keep","replace"].includes(action)){
        expect(readdirSync(join(h.root,"releases")).sort()).toEqual(before);expect(h.workerStdout()).toBe("");
      }
    }finally{writeFileSync(cont,"continue");await closed;}
  };
  it.each(["keep","replace"] as const)("preserves the retained source after state-aware completion with tool %s",action=>exercise("state-aware",action));
  it.each(["keep","replace"] as const)("preserves the retained source after ordinary update with tool %s",action=>exercise("ordinary",action));
  it.each(["move-current","unreadable-current"] as const)("skips pruning with 75 when %s is observed in the window",action=>exercise("ordinary",action));
  it("refuses a failing activated reader with 78 before removing any release",()=>exercise("ordinary","fail-reader"));
});


describe.skipIf(process.platform !== "linux")("selected replacement and deletion metadata",()=>{
  it.each(["replacement-from","prior-phase","recursive-phase","staging","aside","aside-unlisted","promoted","startRequested","credential-list","duplicate-credential","unknown-credential","digest","aside-attempt","aside-path","duplicate-aside","cleanup-pending","cleanup-bytes","cleanup-fraction","cleanup-path","prune-path","prune-dev","prune-ino","prune-bytes","prune-fraction","service","manifest-hash"])("refuses selected %s metadata without mutation",field=>{
    const uuid="11111111-1111-4111-8111-111111111111",attempt="22222222-2222-4222-8222-222222222222",aside=join(h.dir,`.failed.codex-${attempt}`);
    const record: any={schema:2,uuid,root:h.root,service:"kogane468-test.service",home:h.home,source:{id:h.A,sha256:"0".repeat(64)},target:{id:h.B,sha256:"1".repeat(64)},tool:h.B,phase:"replace-intent",snapshot:{path:join(h.dir,"backup"),staging:join(h.dir,`.staging.codex-${uuid}`),status:"retained",manifestHash:"2".repeat(64)},asides:[{attempt,aside}],replacement:{attempt,from:{id:h.B,sha256:"1".repeat(64)},priorPhase:"completed",staging:join(h.dir,`.restore.codex-${attempt}`),aside,promoted:false,startRequested:false,credentials:["auth.json"],stateDigest:"3".repeat(64)}};
    if(["aside-attempt","aside-path","duplicate-aside"].includes(field))record.phase="completed";
    if(field.startsWith("cleanup-"))record.cleanup={pending:true,bytes:0,path:record.snapshot.staging};
    if(field.startsWith("prune-")){record.phase="completed";record.snapshot.status="prune-intent";record.prune={path:record.snapshot.path,dev:1,ino:1,bytes:0};}
    mkdirSync(join(h.root,"codex-state/v2/records"),{recursive:true,mode:0o700});rewrite(record);
    ok(h.state("inspect",h.root,uuid));
    const r=record.replacement;
    if(field==="replacement-from")r.from.sha256="invalid";
    if(field==="prior-phase")r.priorPhase="unknown";
    if(field==="recursive-phase")r.priorPhase="replace-intent";
    if(field==="staging")r.staging=join(h.dir,"unowned-stage");
    if(field==="aside")r.aside=join(h.dir,"unowned-aside");
    if(field==="aside-unlisted")record.asides=[];
    if(field==="promoted")r.promoted="false";
    if(field==="startRequested")r.startRequested="false";
    if(field==="credential-list")r.credentials="auth.json";
    if(field==="duplicate-credential")r.credentials=["auth.json","auth.json"];
    if(field==="unknown-credential")r.credentials=["arbitrary-name"];
    if(field==="digest")r.stateDigest="invalid";
    if(field==="aside-attempt"){record.asides[0].attempt="invalid";record.asides[0].aside=join(h.dir,".failed.codex-invalid");}
    if(field==="aside-path")record.asides[0].aside=join(h.dir,"unowned-aside");
    if(field==="duplicate-aside")record.asides.push({...record.asides[0]});
    if(field==="cleanup-pending")record.cleanup.pending="true";
    if(field==="cleanup-bytes")record.cleanup.bytes=-1;
    if(field==="cleanup-fraction")record.cleanup.bytes=0.5;
    if(field==="cleanup-path")record.cleanup.path=h.home;
    if(field==="prune-path")record.prune.path=h.home;
    if(field==="prune-dev")record.prune.dev="1";
    if(field==="prune-ino")record.prune.ino="1";
    if(field==="prune-bytes")record.prune.bytes=-1;
    if(field==="prune-fraction")record.prune.bytes=0.5;
    if(field==="service")record.service="../other.service";
    if(field==="manifest-hash")record.snapshot.manifestHash="invalid";
    rewrite(record);const bytes=readFileSync(h.recordPath(uuid)),result=h.state("inspect",h.root,uuid);
    expect(result.status).not.toBe(0);expect(readFileSync(h.recordPath(uuid))).toEqual(bytes);expect(h.callLog()).toBe("");
  });
});


describe.skipIf(process.platform !== "linux")("retained N1 integration successes",()=>{
  it("starts after stopping a service with a pre-existing foreign-UID cgroup member",()=>{
    const foreign=process.getuid!()===65534?65533:65534,proc=join(h.dir,"fake-proc/900002");
    mkdirSync(proc,{recursive:true});writeFileSync(join(proc,"status"),`Name:\tforeign-fixture\nUid:\t${foreign}\t${foreign}\t${foreign}\t${foreign}\n`);
    const preload=join(h.dir,"fault-preload.mjs");
    writeFileSync(preload,readFileSync(preload,"utf8")+`\nconst foreignRead=fs.readFileSync;fs.readFileSync=(path,...args)=>foreignRead(String(path)==='/proc/900002/status'?${JSON.stringify(join(proc,"status"))}:path,...args);syncBuiltinESMExports();\n`);
    writeFileSync(join(h.dir,"fake-cgroup/kaoiro-test/cgroup.procs"),"900002\n");writeFileSync(join(h.dir,"fake-cgroup/kaoiro-test/cgroup.events"),"populated 1\n");
    expect(foreign).not.toBe(process.getuid!());expect(readFileSync(join(proc,"status"),"utf8")).toContain(`Uid:\t${foreign}`);
    ok(h.forward());expect(h.callLog()).toBe("stop\nstart\n");expect(h.current()).toBe(h.B);expect(tx().phase).toBe("completed");
  });
  it("starts with a real SQLite state database without writing migration diagnostics",()=>{
    const database=join(h.home,"state_5.sqlite"),created=spawnSync(process.execPath,["--input-type=module","-e",`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER); INSERT INTO _sqlx_migrations VALUES(58,1);');db.close();`,database],{encoding:"utf8"});
    expect(created.status,created.stderr).toBe(0);const bytes=readFileSync(database);
    ok(h.forward());expect(h.callLog()).toBe("stop\nstart\n");expect(h.current()).toBe(h.B);expect(tx().phase).toBe("completed");
    expect(readFileSync(database)).toEqual(bytes);expect(readFileSync(join(tx().snapshot.path,"state/state_5.sqlite"))).toEqual(bytes);
    expect(tx()).not.toHaveProperty("estimate");expect(JSON.parse(readFileSync(join(tx().snapshot.path,"manifest.json"),"utf8"))).not.toHaveProperty("migrationLevels");
  });
});

describe.skipIf(process.platform !== "linux")("restore admission path arguments",()=>{
  it.each(["home","service"])("refuses restore admission with requested %s disagreement before stop",field=>{
    ok(h.forward());const other=join(h.dir,"other-home");mkdirSync(other,{mode:0o700});
    const before=h.callLog(),ino=statSync(h.home).ino;
    const result=runScript(h.updater,["--install-dir",h.root,"--service",field==="service"?"another-test":"kogane468-test","--restore-codex-backup",join(h.dir,"backup"),"--codex-home",field==="home"?other:h.home],h.env());
    expect(result.status).not.toBe(0);expect(result.stderr).toContain("Restore home/service differs from selected record");
    expect(h.callLog()).toBe(before);expect(h.current()).toBe(h.B);expect(statSync(h.home).ino).toBe(ino);expect(readdirSync(other)).toEqual([]);
  });
  it("refuses snapshot destination reuse before publishing another owner or stopping",()=>{
    ok(h.forward());const first=tx(),bytes=readFileSync(join(first.snapshot.path,"manifest.json")),before=h.callLog();
    expect(h.forward().status).not.toBe(0);expect(h.callLog()).toBe(before);expect(h.records()).toHaveLength(1);
    expect(readFileSync(join(first.snapshot.path,"manifest.json"))).toEqual(bytes);expect(tx().uuid).toBe(first.uuid);
  });
  it("refuses a new snapshot under the state registry before stop",()=>{
    const parent=join(h.root,"codex-state/probe-backups");mkdirSync(parent,{recursive:true,mode:0o700});
    const result=runScript(h.updater,["--install-dir",h.root,"--service","kogane468-test","--tarball",h.tarball(),"--codex-home",h.home,"--codex-backup-dir",join(parent,"new")],h.env());
    expect(result.status).not.toBe(0);expect(result.stderr).toContain("Snapshot overlaps protected state/releases");expect(h.callLog()).toBe("");expect(existsSync(join(parent,"new"))).toBe(false);expect(existsSync(join(h.root,"codex-state/v2"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("preflight operation boundaries",()=>{
  it.each(["terminal-record","different-target","third-current","unready-phase"])("refuses %s before authorization",async field=>{
    const C=revisionOf("outside-operation")+"-dirty";
    if(field==="third-current"){await h.close();h=await createStateFixture({toolId:C});}
    ok(h.forward());const record=tx();record.phase=field==="terminal-record"?"completed":field==="unready-phase"?"prepared":"start-intent";rewrite(record);
    if(field==="third-current"){
      rmSync(join(h.root,"current"));symlinkSync(`releases/${C}`,join(h.root,"current"));
    }
    mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    if(field==="unready-phase"){ok(spawnSync(h.ctl,["--user","stop","kogane468-test"],{env:h.env(),encoding:"utf8"}));mkdirSync(join(h.root,".lock.links"),{mode:0o700});}
    const bytes=readFileSync(h.recordPath(record.uuid)),before=h.callLog(),link=readlinkSync(join(h.root,"current"));
    const result=h.state(field==="unready-phase"?"guard":"preflight",h.root,field==="different-target"?h.A:h.B,record.uuid);
    expect(result.status).not.toBe(0);expect(result.stderr).toContain(field==="terminal-record"?"Historical terminal record cannot authorize a switch":field==="different-target"?"Transaction target differs":field==="third-current"?"Current is outside recorded operation":"Forward is not ready for switching");
    expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);expect(h.callLog()).toBe(before);expect(readlinkSync(join(h.root,"current"))).toBe(link);
  });
});

describe.skipIf(process.platform !== "linux")("stopped-proof component",()=>{
  it.each(["transitional","mainpid","descendants"])("rejects %s independently in the shipped stopped proof",fault=>{
    writeFileSync(join(h.dir,"active"),fault==="transitional"?"deactivating":"inactive");
    let control=readFileSync(h.ctl,"utf8");
    if(fault==="transitional")control=control.replace("ActiveState:active?'active':'inactive'","ActiveState:fs.readFileSync(dir+'/active','utf8')");
    if(fault==="mainpid")control=control.replace("MainPID:active?String(ownerPid):'0'","MainPID:active?String(ownerPid):'123'");
    writeFileSync(h.ctl,control);
    if(fault==="descendants")writeFileSync(join(h.dir,"fake-cgroup/kaoiro-test/cgroup.events"),"populated 1\n");
    const result=spawnSync(process.execPath,["--input-type=module","-e","const {assertStopped}=await import(process.argv[1]);assertStopped(process.argv[2],process.argv[3]);",join(h.root,"releases",h.B,"deploy/codex-service.mjs"),"kogane468-test",h.home],{env:h.env(),encoding:"utf8"});
    expect(result.status).not.toBe(0);expect(result.stderr).toContain(fault==="descendants"?"Runner descendants remain":"Runner is not fully stopped");expect(h.callLog()).toBe("");
  });
});

describe.skipIf(process.platform !== "linux")("additional guard boundaries", { timeout: 35_000 }, () => {
  const fixtureRecord = () => ({schema:2,uuid:"00000000-0000-4000-8000-000000000000",root:h.root,home:h.home,service:"kogane468-test.service",source:{id:h.A,sha256:"0".repeat(64)},target:{id:h.B,sha256:"1".repeat(64)},tool:h.B,phase:"completed",snapshot:{path:join(h.dir,"backup"),staging:join(h.dir,".staging.codex-00000000-0000-4000-8000-000000000000"),status:"retired"},asides:[]});
  const installRecord = (record: any, name=record.uuid+".json") => {mkdirSync(join(h.root,"codex-state/v2/records"),{recursive:true,mode:0o700});writeFileSync(join(h.root,"codex-state/v2/records",name),JSON.stringify(record),{mode:0o600});};
  it("rejects an unknown record filename before protection output",()=>{
    const record=fixtureRecord();record.uuid="not-a-uuid";installRecord(record,"not-a-uuid.json");const r=h.state("protected",h.root);expect(r.status).not.toBe(0);expect(r.stderr).toContain("Unknown state record filename");
  });
  it.each(["tool","target","from"])("rejects malformed protected %s on unfinished work",field=>{
    const record:any=fixtureRecord();record.phase=field==="from"?"replace-intent":"prepared";record.snapshot.status="planned";
    if(field==="tool")record.tool="invalid";else if(field==="target")record.target.id="invalid";else record.replacement={from:{id:"invalid"}};
    installRecord(record);const r=h.state("protected",h.root);expect(r.status).not.toBe(0);expect(r.stderr).toContain(field==="tool"?"Invalid protected tool":"Invalid protected operation release");
  });
  it("rejects an invalid UUID argument before resolving its record",()=>{
    const r=h.state("inspect",h.root,"not-a-uuid");expect(r.status).not.toBe(0);expect(r.stderr).toContain("Invalid transaction UUID");
  });
  it("rejects a non-array aside list with its selected-record error",()=>{
    const record:any=fixtureRecord();record.asides={};installRecord(record);const r=h.state("inspect",h.root,record.uuid);expect(r.status).not.toBe(0);expect(r.stderr).toContain("Malformed aside list");
  });
  it("rejects a noncanonical absent home path",()=>{
    const parent=join(h.dir,"canonical-parent");mkdirSync(parent,{mode:0o700});
    const script=`const {homePath}=await import(${JSON.stringify(join(h.root,"releases",h.B,"deploy/codex-service.mjs"))});console.log(homePath(process.argv[1],true));`;
    const r=spawnSync(process.execPath,["--input-type=module","-e",script,parent+"/../missing"],{env:h.env(),encoding:"utf8"});expect(r.status).not.toBe(0);expect(r.stderr).toContain("Home must use its canonical absolute path");
  });
  it("refuses restore across the home-parent device boundary before stop",()=>{
    ok(h.forward());const before=h.callLog(),preload=join(h.dir,"fault-preload.mjs");
    writeFileSync(preload,readFileSync(preload,"utf8")+`\nconst originalStat=fs.lstatSync;fs.lstatSync=(path,...args)=>{const result=originalStat(path,...args);if(String(path)===home)result.dev+=1;return result};syncBuiltinESMExports();\n`);
    const r=h.restore();expect(r.status).not.toBe(0);expect(r.stderr).toContain("Restore home and staging must share one filesystem");expect(h.callLog()).toBe(before);
  });
  it("requires current for a transaction preflight",()=>{
    const record=fixtureRecord();installRecord(record);rmSync(join(h.root,"current"));const r=h.state("preflight",h.root,h.B,record.uuid);expect(r.status).not.toBe(0);expect(r.stderr).toContain("Transaction requires an existing release");
  });
  it("refuses initial activation of a pre-N2 reader while a snapshot is retained",async()=>{
    await h.close();h=await createStateFixture({toolId:revisionOf("n2-initial-reader-tool")});ok(h.forward());const helper=readFileSync(join(h.root,"releases",h.B,"deploy/kaoiro-runner-codex-state.mjs"),"utf8");h.replace(h.B,{"deploy/kaoiro-runner-codex-state.mjs":helper.replace("export const CODEX_STATE_SCHEMA = 2;","export const CODEX_STATE_SCHEMA = 1;")});rmSync(join(h.root,"current"));
    const r=h.state("preflight",h.root,h.B,"");expect(r.status).not.toBe(0);expect(r.stderr).toContain("A retained v2 snapshot forbids activating a pre-N2 tool");
  });
  it("refuses recovery from a snapshot not marked retained",()=>{
    ok(h.forward());const record=tx();record.phase="start-intent";record.snapshot.status="planned";rewrite(record);const before=h.callLog();const r=h.resume(record.uuid,"recover");expect(r.status).not.toBe(0);expect(r.stderr).toContain("Snapshot is not retained");expect(h.callLog()).toBe(before);
  });
  it("refuses a different physical updater even for a terminal operation",async()=>{
    const C=revisionOf("n2-wrong-tool");await h.close();h=await createStateFixture({toolId:C});ok(h.forward());const r=runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-update.sh"),["--install-dir",h.root,"--resume-codex-transaction",tx().uuid],h.env());expect(r.status).not.toBe(0);expect(r.stderr).toContain("Use the recorded physical updater tool");
  });
  it.each(["phase","release"])("refuses a post-start record %s change",field=>{
    const ctl=readFileSync(h.ctl,"utf8"),change=field==="phase"?'record.phase="completed";':'record.target=record.source;';
    const hook=`const records=root+'/codex-state/v2/records';const file=records+'/'+fs.readdirSync(records).find(n=>n.endsWith('.json'));const record=JSON.parse(fs.readFileSync(file,'utf8'));${change}fs.writeFileSync(file,JSON.stringify(record));`;
    writeFileSync(h.ctl,ctl.replace("fs.appendFileSync(dir+'/calls','start\\n');","fs.appendFileSync(dir+'/calls','start\\n');"+hook));const r=h.forward();expect(r.status).not.toBe(0);expect(r.stderr).toContain(field==="phase"?"Startup phase changed during service operation":"Startup release changed during service operation");
  });
});

describe.skipIf(process.platform !== "linux")("guard recheck boundaries", { timeout: 40_000 }, () => {
  const atStop = (code:string) => {const s=readFileSync(h.ctl,"utf8"),next=s.replace("fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive');","fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive');"+code);expect(next).not.toBe(s);writeFileSync(h.ctl,next);};
  const preload = (code:string) => {const path=join(h.dir,"fault-preload.mjs");writeFileSync(path,readFileSync(path,"utf8")+"\n"+code+"\nsyncBuiltinESMExports();\n");};
  it("compares a self-consistent source native binding with the installed native",()=>{
    ok(h.forward());const record=tx(),path=join(record.snapshot.path,"manifest.json"),manifest=JSON.parse(readFileSync(path,"utf8"));record.source.sha256="0".repeat(64);manifest.sourceRelease.sha256=record.source.sha256;writeFileSync(path,JSON.stringify(manifest));record.snapshot.manifestHash=createHash("sha256").update(readFileSync(path)).digest("hex");rewrite(record);
    const before=h.callLog(),r=h.restore();expect(r.status).not.toBe(0);expect(r.stderr).toContain("Recorded native release changed");expect(h.callLog()).toBe(before);
  });
  it("refuses a source link moved during stop before taking a snapshot",()=>{
    atStop(`fs.unlinkSync(root+'/current');fs.symlinkSync('releases/${h.B}',root+'/current');`);const r=h.forward();expect(r.status).not.toBe(0);expect(r.stderr).toContain("Pre-start source link changed");expect(h.callLog()).toBe("stop\n");expect(existsSync(join(h.dir,"backup"))).toBe(false);
  });
  it("refuses stale stopped state through the direct switch guard",async()=>{
    await interrupted(forwardArgs(),{phase:"snapshot-verified",when:"after"});const record=tx();writeFileSync(join(h.home,"sessions/old.jsonl"),"LATER-SOURCE");mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    const r=runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-switch.sh"),[h.B,"--install-dir",h.root,"--codex-transaction",record.uuid],h.env());expect(r.status).not.toBe(0);expect(r.stderr).toContain("Stopped state differs from verified snapshot; recover");expect(h.current()).toBe(h.A);expect(tx().phase).toBe("snapshot-verified");expect(history()).toBe("LATER-SOURCE");
  });
  it("refuses a second admission over an unfinished replacement",async()=>{
    ok(h.forward());await interrupted(restoreCommand(),{phase:"replace-intent",when:"after",startRequested:false});const record=tx(),bytes=readFileSync(h.recordPath(record.uuid)),r=h.restore();expect(r.status).not.toBe(0);expect(r.stderr).toContain("Replacement is already unfinished");expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);
  });
  it("refuses changed restore current before staging and source restart",()=>{
    ok(h.forward());const before=h.callLog();atStop(`fs.unlinkSync(root+'/current');fs.symlinkSync('releases/${h.A}',root+'/current');`);const r=h.restore();expect(r.status).not.toBe(0);expect(r.stderr).toContain("Restore source link changed");expect(h.callLog()).toBe(before+"stop\n");expect(existsSync(tx().replacement.aside)).toBe(false);
  });
  it("refuses a published restore home under its admission release",async()=>{
    ok(h.forward());await interrupted(restoreCommand(),{to:"/codex",when:"after"});rmSync(join(h.root,"current"));symlinkSync(`releases/${h.B}`,join(h.root,"current"));h.boot();const r=h.resume(tx().uuid);expect(r.status).not.toBe(0);expect(r.stderr).toContain("Published restore home requires its source release");expect(h.current()).toBe(h.B);expect(history()).toBe(`BOOT:${h.B}`);
  });
  it.each(["extra-home","unexpected-credential","invalid-credential"])("refuses %s before moving any current credential",async fault=>{
    ok(h.forward());await interrupted(restoreCommand(),{from:"",when:"after"});const record=tx(),r=record.replacement;
    if(fault==="extra-home")mkdirSync(h.home,{mode:0o700});
    if(fault==="unexpected-credential"){r.credentials=r.credentials.filter((n:string)=>n!=="auth.json");rewrite(record);}
    if(fault==="invalid-credential"){rmSync(join(r.aside,"auth.json"));const target=join(h.dir,"credential-target");writeFileSync(target,"CURRENT-CREDENTIAL");symlinkSync(target,join(r.aside,"auth.json"));}
    const result=h.resume(record.uuid);expect(result.status).not.toBe(0);expect(result.stderr).toContain(fault==="extra-home"?"Inconsistent home/staging/aside layout":fault==="unexpected-credential"?"Unexpected credential during replacement":"Invalid credential entry");
    for(const name of ["auth.json",".credentials.json","secrets","mcp-oauth-locks"]){expect(existsSync(join(r.aside,name))).toBe(true);expect(existsSync(join(r.staging,name))).toBe(false);}
  });
  it.each(["uid","entry"])("keeps an unsafe cleanup %s named instead of removing it",kind=>{
    preload(`const make=fs.mkdirSync,stat=fs.lstatSync;fs.mkdirSync=(path,...args)=>{const result=make(path,...args);if(String(path).includes('/.staging.codex-')&&String(path).endsWith('/state')){${kind==="uid"?"fs.writeFileSync(String(path)+'/bad-cleanup','preserve');":""}}return result};${kind==="uid"?"fs.lstatSync=(path,...args)=>{const result=stat(path,...args);if(String(path).endsWith('/bad-cleanup'))result.uid+=1;return result};":""}`);
    if(kind==="entry")preload(`import {execFileSync as makeFifo} from 'node:child_process';const priorMake=fs.mkdirSync;fs.mkdirSync=(path,...args)=>{const result=priorMake(path,...args);if(String(path).includes('/.staging.codex-')&&String(path).endsWith('/state'))makeFifo('mkfifo',[String(path)+'/bad-cleanup']);return result};`);
    const r=h.forward();expect(r.status).not.toBe(0);expect(r.stderr).toContain(kind==="uid"?"Unsafe cleanup root":"Unsafe cleanup entry");expect(existsSync(join(tx().snapshot.staging,"state/bad-cleanup"))).toBe(true);
  });
  it.each(["phase","source-id","source-native"])("rereads %s before returning a stopped source",field=>{
    const change=field==="phase"?'record.phase="start-intent";':field==="source-id"?`record.source.id=${JSON.stringify(h.B)};`:'record.source.sha256="0".repeat(64);';
    preload(`const copy=fs.copyFileSync,removeStage=fs.rmSync,readRecord=fs.readFileSync;fs.copyFileSync=()=>{throw Error('copy checkpoint')};fs.rmSync=(path,...args)=>{const result=removeStage(path,...args);if(String(path).startsWith(dir+'/.staging.codex-'))fs.writeFileSync(dir+'/after-cleanup','ready');return result};fs.readFileSync=(path,...args)=>{const value=readRecord(path,...args);if(process.argv[2]==='run'&&String(path).startsWith(root+'/codex-state/v2/records/')&&fs.existsSync(dir+'/after-cleanup')){const record=JSON.parse(value);if(record.phase==='prepared'&&record.cleanup?.pending===false){fs.unlinkSync(dir+'/after-cleanup');${change}return JSON.stringify(record)}}return value};`);
    const result=h.forward();expect(result.status).not.toBe(0);expect(result.stderr).toContain("Source return phase changed before restart");expect(h.callLog()).toBe("stop\n");
  });
  it("refuses cancellation when current differs from its admission release",async()=>{
    ok(h.forward());await interrupted(restoreCommand(),{phase:"restore-prepared",when:"after"});const record=tx(),bytes=readFileSync(h.recordPath(record.uuid)),before=h.callLog();rmSync(join(h.root,"current"));symlinkSync(`releases/${h.A}`,join(h.root,"current"));const result=h.resume(record.uuid,"recover");expect(result.status).not.toBe(0);expect(result.stderr).toContain("Cancellation source link changed");expect(h.callLog()).toBe(before);expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);
  });
  it.each(["phase","current"])("rereads %s after switch before starting the target",field=>{
    const change=field==="phase"?'record.phase="completed";fs.writeFileSync(path,JSON.stringify(record));':`fs.unlinkSync(root+'/current');fs.symlinkSync('releases/${h.A}',root+'/current');`;
    preload(`const readAfterSwitch=fs.readFileSync;fs.readFileSync=(path,...args)=>{const value=readAfterSwitch(path,...args);if(process.argv[2]==='promote'&&String(path).startsWith(root+'/codex-state/v2/records/')){const record=JSON.parse(value);if(record.phase==='start-intent'){${change}}}return value};`);
    const result=h.forward();expect(result.status).not.toBe(0);expect(result.stderr).toContain(field==="phase"?"Startup phase changed after switch":"Switch did not reach recorded target");expect(h.callLog()).toBe("stop\n");
  });
  it.each(["ambiguous-home","changed-pid"])("refuses %s during live home observation",async kind=>{
    await h.close();h=await createStateFixture({liveDefault:true});const pid=JSON.parse(readFileSync(join(h.dir,"mainpid"),"utf8")).pid;
    preload(`const readLive=fs.readFileSync;fs.readFileSync=(path,...args)=>{const value=readLive(path,...args);if(String(path)===${JSON.stringify(`/proc/${pid}/environ`)}){${kind==="ambiguous-home"?"return Buffer.concat([value,Buffer.from('HOME=/different\\0')]);":"fs.writeFileSync(dir+'/live-read','ready');"}}return value};`);
    if(kind==="changed-pid"){const ctl=readFileSync(h.ctl,"utf8");writeFileSync(h.ctl,ctl.replace("MainPID:active?String(ownerPid):'0'","MainPID:active&&!fs.existsSync(dir+'/live-read')?String(ownerPid):'0'"));}
    const result=h.forward();expect(result.status).not.toBe(0);expect(result.stderr).toContain(kind==="ambiguous-home"?"Ambiguous running HOME":"Runner changed during home read");expect(h.callLog()).toBe("");expect(existsSync(join(h.root,"codex-state/v2"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("recovery command boundaries",()=>{
  const uuid="00000000-0000-4000-8000-000000000000";
  it.each([
    {name:"missing value",args:["--resume-codex-transaction"],message:"needs a value"},
    {name:"option-like value",args:["--resume-codex-transaction","--detach"],message:"must not begin with '-'"},
    {name:"repeated mode",args:["--resume-codex-transaction",uuid,"--resume-codex-transaction",uuid],message:"repeated or conflicting recovery option"},
    {name:"conflicting modes",args:["--resume-codex-transaction",uuid,"--recover-codex-transaction",uuid],message:"repeated or conflicting recovery option"},
    {name:"forward input",args:["--resume-codex-transaction",uuid,"--tarball","unused"],message:"resume/recover excludes forward and restore inputs"},
    {name:"restore input",args:["--recover-codex-transaction",uuid,"--restore-codex-backup","unused","--codex-home","unused"],message:"resume/recover excludes forward and restore inputs"},
  ])("rejects $name before acquiring a lock",({args,message})=>{
    const result=runScript(h.updater,["--install-dir",h.root,...args.map(value=>value==="unused"?join(h.dir,"unused"):value)],{...h.env(),KAOIRO_SYSTEMD_RUN:"/bin/false"});expect(result.status).toBe(64);expect(result.stderr).toContain(message);expect(h.callLog()).toBe("");expect(existsSync(join(h.root,".lock.update"))).toBe(false);expect(existsSync(join(h.root,"codex-state/v2"))).toBe(false);
  });
  it.each(["resume","recover"])("queues %s with its UUID and physical updater intact",mode=>{
    const stub=join(h.dir,"systemd-run.mjs"),argsPath=join(h.dir,"queued-args.json");writeFileSync(stub,`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});
    const result=runScript(h.updater,["--install-dir",h.root,`--${mode}-codex-transaction`,uuid,"--detach","--allow-dirty"],{...h.env(),KAOIRO_SYSTEMD_RUN:stub});ok(result);const queued=JSON.parse(readFileSync(argsPath,"utf8"));expect(queued).toContain(h.updater);expect(queued.slice(queued.indexOf(`--${mode}-codex-transaction`),queued.indexOf(`--${mode}-codex-transaction`)+2)).toEqual([`--${mode}-codex-transaction`,uuid]);expect(queued).toContain("--allow-dirty");expect(h.callLog()).toBe("");expect(existsSync(join(h.root,".lock.update"))).toBe(false);
  });
});
