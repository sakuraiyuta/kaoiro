import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

describe.skipIf(process.platform !== "linux")("restore-selection", { timeout: 45_000 }, () => {
  it("restores an explicitly selected older snapshot after an intermediate snapshot and release were pruned", async () => {
    await h.close();h=await createStateFixture({toolId:revisionOf("n2-retained-tool")+"-dirty"});
    ok(h.forward()); writeFileSync(join(h.home,"sessions/old.jsonl"),"NEWER");
    ok(h.forward("second")); const older=h.records().find(r=>r.snapshot.path.endsWith("/backup"))!, newer=h.records().find(r=>r.snapshot.path.endsWith("/second"))!;
    ok(h.state("prune",h.root,newer.uuid));
    const native=readFileSync(join(h.root,"releases",h.B,"node_modules/@openai/codex/vendor/fixture/bin/codex"),"utf8"),out=join(h.dir,"intermediate-archives");mkdirSync(out);
    for(const name of ["later-one","later-two"]){
      const id=revisionOf(name),tarball=makeReleaseTarball(out,id,{extraFiles:{"node_modules/@openai/codex/vendor/fixture/bin/codex":native}});
      ok(runScript(h.updater,["--install-dir",h.root,"--service","kogane468-test","--tarball",tarball,"--keep","3"],h.env()));
    }
    expect(existsSync(join(h.root,"releases",h.B))).toBe(false);
    const ino=statSync(join(h.home,"auth.json")).ino; ok(h.restore());
    expect(h.current()).toBe(h.A); expect(history()).toBe("HISTORY"); expect(statSync(join(h.home,"auth.json")).ino).toBe(ino); expect(older.source.id).toBe(h.A);
  },60000);
  it("restores the same snapshot twice with fresh asides and keeps them through cancellation and prune", async () => {
    ok(h.forward()); const uuid=tx().uuid;
    for (const value of ["NEW-ONE","NEW-TWO"]) { writeFileSync(join(h.home,"sessions/old.jsonl"),value); ok(h.restore()); }
    const entries=tx().asides; expect(entries).toHaveLength(2); expect(new Set(entries.map((e:any)=>e.aside)).size).toBe(2);
    await interrupted(restoreCommand(),{phase:"restore-prepared",when:"after"});
    ok(h.resume(uuid,"recover")); ok(h.state("prune",h.root,uuid));
    expect(tx().asides).toHaveLength(3); expect(tx().asides.slice(0,2)).toEqual(entries);
    expect(readFileSync(join(entries[0].aside,"sessions/old.jsonl"),"utf8")).toBe("NEW-ONE");
    expect(readFileSync(join(entries[1].aside,"sessions/old.jsonl"),"utf8")).toBe("NEW-TWO");
  });
});

describe.skipIf(process.platform !== "linux")("source-recovery", { timeout: 30_000 }, () => {
  it.each([
    {phase:"prepared",when:"after"},
    {to:"/backup",when:"before"},
    {to:"/backup",when:"after"},
    {phase:"snapshot-verified",when:"after"},
    {phase:"start-intent",when:"before"},
    {phase:"start-intent",when:"after"},
    {phase:"completed",when:"before"},
  ])("recovers after dead worker at $phase $to $when", async cut => {
    await interrupted(forwardArgs(),cut); const record=tx();
    expect(record.updaterPid).toBeGreaterThan(0); expect(h.current()).toBe(["completed"].includes(cut.phase||"")?h.B:h.A);
    if (["prepared","snapshot-verified"].includes(record.phase)) {
      const inode=statSync(h.home).ino; ok(h.resume(record.uuid,"recover")); expect(tx().phase).toBe("failed"); expect(statSync(h.home).ino).toBe(inode);
    } else { ok(h.resume(record.uuid,"recover")); expect(tx().phase).toBe("restored"); }
    ok(h.resume(record.uuid)); expect(h.current()).toBe(h.A); expect(history()).toBe("HISTORY");
  });
  it("refuses stale snapshot reuse after a source boot but keeps recover usable", async () => {
    await interrupted(forwardArgs(),{phase:"snapshot-verified",when:"after"},()=>{ ok(spawnSync(h.ctl,["--user","start","kogane468-test"],{encoding:"utf8"})); writeFileSync(join(h.home,"sessions/old.jsonl"),"BOOT-WRITE"); });
    const uuid=tx().uuid;const result=h.resume(uuid);expect(result.status).not.toBe(0);expect(result.stderr).toContain("Stopped state differs from verified snapshot; recover and take a new snapshot");expect(h.current()).toBe(h.A);
    ok(h.resume(uuid,"recover")); expect(history()).toBe("BOOT-WRITE"); expect(tx().phase).toBe("failed");
  });
});

describe.skipIf(process.platform !== "linux")("restore-resume", { timeout: 30_000 }, () => {
  it.each(["before","after"])("resumes %s home rename without losing refreshed credential identity", async when => {
    ok(h.forward()); writeFileSync(join(h.home,"sessions/old.jsonl"),"NEW"); writeFileSync(join(h.home,"auth.json"),"REFRESHED");
    const ino=statSync(join(h.home,"auth.json")).ino, uuid=tx().uuid;
    await interrupted(restoreCommand(),{from:"",when}); ok(h.resume(uuid)); ok(h.resume(uuid));
    expect(h.current()).toBe(h.A); expect(history()).toBe("HISTORY"); expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe("REFRESHED"); expect(statSync(join(h.home,"auth.json")).ino).toBe(ino);
    expect(readFileSync(join(tx().replacement.aside,"sessions/old.jsonl"),"utf8")).toBe("NEW");
  });
});

describe.skipIf(process.platform !== "linux")("boot ordering", { timeout: 45_000 }, () => {
  it.each([{phase:"start-intent",when:"after"},{promote:true}])("records forward intent before independent boot at $phase $promote",async cut=>{
    await interrupted(forwardArgs(),cut);
    expect(tx().phase).toBe("start-intent");const booted=h.boot();
    expect(booted).toBe(cut.promote?h.B:h.A);expect(history()).toBe(`BOOT:${booted}`);
    const uuid=tx().uuid;ok(h.resume(uuid,"recover"));expect(history()).toBe("HISTORY");expect(h.current()).toBe(h.A);
    expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe(`BOOT-CREDENTIAL:${booted}`);
  });
  it("runs the real default runner launch path with zero native spawns while H is absent",async()=>{
    ok(h.forward());const uuid=tx().uuid;
    await interrupted(restoreCommand(),{from:"",when:"after"});expect(existsSync(h.home)).toBe(false);
    await absentHomeBoot(h.dir,h.home);
    ok(h.resume(uuid));expect(h.current()).toBe(h.A);expect(history()).toBe("HISTORY");
  });
  it("never repeats replacement or compares mutable state after a promoted source boot",async()=>{
    ok(h.forward());const uuid=tx().uuid;
    await interrupted(restoreCommand(),{to:"/codex",when:"after"});expect(h.current()).toBe(h.A);expect(tx().replacement.startRequested).toBe(true);
    const ino=statSync(h.home).ino;writeFileSync(join(h.home,"sessions/old.jsonl"),"SOURCE-BOOT");writeFileSync(join(h.home,"auth.json"),"BOOT-REFRESH");
    ok(h.resume(uuid));ok(h.resume(uuid));expect(statSync(h.home).ino).toBe(ino);expect(history()).toBe("SOURCE-BOOT");expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe("BOOT-REFRESH");
  });
});

describe.skipIf(process.platform !== "linux")("independent restore boot boundaries", { timeout: 45_000 }, () => {
  const cuts: Record<string, unknown>[] = [
    ...["before","after"].map(when=>({from:"",when})),
    ...["auth.json",".credentials.json","secrets","mcp-oauth-locks"].flatMap(credential=>["before","after"].map(when=>({credential,when}))),
    ...["before","after"].map(when=>({phase:"replace-intent",startRequested:true,when})),
    {promote:true},
    ...["before","after"].map(when=>({to:"/codex",when})),
    ...["before","after"].map(when=>({phase:"restored",when})),
  ];
  it.each(cuts)("finishes after independent boot at $phase $from $credential $to $promote $when",async cut=>{
    ok(h.forward());const uuid=tx().uuid;
    await interrupted(restoreCommand(),cut);
    const homePresent=existsSync(h.home),selected=h.current();
    if(cut.credential || cut.startRequested===true || cut.promote)expect(homePresent).toBe(false);
    if(Object.hasOwn(cut,"from"))expect(homePresent).toBe(cut.when==="before");
    if(cut.to==="/codex"){expect(homePresent).toBe(cut.when==="after");expect(selected).toBe(h.A);}
    if(cut.startRequested===true)expect(tx().replacement.startRequested).toBe(cut.when==="after");
    if(cut.promote)expect(selected).toBe(h.A);
    if(cut.phase==="restored"){expect(homePresent).toBe(true);expect(selected).toBe(h.A);}
    if(homePresent){
      expect(h.boot()).toBe(selected);expect(history()).toBe(`BOOT:${selected}`);
      if(selected===h.A)expect(tx().replacement.startRequested).toBe(true);
    } else await absentHomeBoot(h.dir,h.home);
    const credentials=homePresent?readFileSync(join(h.home,"auth.json"),"utf8"):null;
    ok(h.resume(uuid));ok(h.resume(uuid));expect(tx().phase).toBe("restored");expect(h.current()).toBe(h.A);
    expect(history()).toBe(homePresent && selected===h.A?`BOOT:${h.A}`:"HISTORY");
    if(credentials!==null)expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe(credentials);
    expect(existsSync(tx().replacement.aside)).toBe(true);
    expect(existsSync(tx().replacement.staging)).toBe(false);
    expect(existsSync(join(h.dir,"backup"))).toBe(true);
  });
});

describe.skipIf(process.platform !== "linux")("credential location and directory identity", { timeout: 35_000 }, () => {
  it("moves all current credential files and directories intact without retaining them in aside",()=>{
    ok(h.forward());const names=["auth.json",".credentials.json","secrets","mcp-oauth-locks"],inodes=names.map(n=>statSync(join(h.home,n)).ino);
    ok(h.restore());expect(names.map(n=>statSync(join(h.home,n)).ino)).toEqual(inodes);
    for(const name of names)expect(existsSync(join(tx().replacement.aside,name))).toBe(false);
    expect(readFileSync(join(h.home,"secrets/token"),"utf8")).toBe("CURRENT_DIRECTORY_SECRET");
  });
  it.each(["both","neither"])("refuses %s credential locations before promotion without overwrite",async layout=>{
    ok(h.forward());await interrupted(restoreCommand(),{from:"",when:"after"});const record=tx(),r=record.replacement;
    if(layout==="both")writeFileSync(join(r.staging,"auth.json"),"OTHER_TOKEN");else rmSync(join(r.aside,"auth.json"));
    const before=readFileSync(h.recordPath(record.uuid));expect(h.resume(record.uuid).status).not.toBe(0);expect(existsSync(h.home)).toBe(false);expect(readFileSync(h.recordPath(record.uuid))).toEqual(before);
    if(layout==="both"){expect(readFileSync(join(r.staging,"auth.json"),"utf8")).toBe("OTHER_TOKEN");expect(readFileSync(join(r.aside,"auth.json"),"utf8")).toBe("CURRENT_TOKEN");}
  });
});


describe.skipIf(process.platform !== "linux")("restore cancellation and consecutive selection", { timeout: 35_000 }, () => {
  it("cancels an admitted restore before replacement and resumes its admission release",async()=>{
    ok(h.forward());const uuid=tx().uuid,ino=statSync(h.home).ino;
    await interrupted(restoreCommand(),{phase:"restore-prepared",when:"after"});
    ok(h.resume(uuid,"recover"));expect(h.current()).toBe(h.B);expect(tx().phase).toBe("completed");expect(statSync(h.home).ino).toBe(ino);
    ok(h.restore());expect(h.current()).toBe(h.A);
  });
  it("restores consecutively selected snapshots while retaining refreshed credentials",()=>{
    ok(h.forward());writeFileSync(join(h.home,"sessions/old.jsonl"),"INTERMEDIATE");ok(h.forward("second"));
    writeFileSync(join(h.home,"auth.json"),"REFRESHED-TWICE");const ino=statSync(join(h.home,"auth.json")).ino;
    ok(h.restore("second"));expect(history()).toBe("INTERMEDIATE");ok(h.restore());expect(history()).toBe("HISTORY");
    expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe("REFRESHED-TWICE");expect(statSync(join(h.home,"auth.json")).ino).toBe(ino);
  });
});


describe.skipIf(process.platform !== "linux")("credential rename interruption", { timeout: 35_000 }, () => {
  it.each(["auth.json",".credentials.json","secrets","mcp-oauth-locks"].flatMap(credential=>["before","after"].map(when=>({credential,when}))))("resumes $when moving $credential without copying or losing either state",async cut=>{
    ok(h.forward());writeFileSync(join(h.home,"sessions/old.jsonl"),"CURRENT-STATE");
    const names=["auth.json",".credentials.json","secrets","mcp-oauth-locks"],inodes=names.map(n=>statSync(join(h.home,n)).ino),uuid=tx().uuid;
    await interrupted(restoreCommand(),cut);expect(existsSync(h.home)).toBe(false);
    const aside=tx().replacement.aside;expect(readFileSync(join(aside,"sessions/old.jsonl"),"utf8")).toBe("CURRENT-STATE");
    ok(h.resume(uuid));ok(h.resume(uuid));expect(names.map(n=>statSync(join(h.home,n)).ino)).toEqual(inodes);expect(history()).toBe("HISTORY");
    expect(readFileSync(join(aside,"sessions/old.jsonl"),"utf8")).toBe("CURRENT-STATE");
  });
});

describe.skipIf(process.platform !== "linux")("restore protection and current identity", { timeout: 40_000 }, () => {
  it("protects the restore admission release independently of source and physical tool",async()=>{
    const tool=revisionOf("n2-physical-tool")+"-dirty";await h.close();h=await createStateFixture({toolId:tool});ok(h.forward());
    await interrupted(restoreCommand(),{phase:"restore-prepared",when:"after"});const r=h.state("protected",h.root);ok(r);expect(new Set(r.stdout.trim().split("\n"))).toEqual(new Set([h.A,h.B,tool]));
    ok(h.resume(tx().uuid));const terminal=h.state("protected",h.root);ok(terminal);expect(terminal.stdout.trim()).toBe(h.A);
  });
  it("refuses a third current release before stop and leaves previous unchanged on idempotent resume",async()=>{
    const tool=revisionOf("n2-physical-tool")+"-dirty";await h.close();h=await createStateFixture({toolId:tool});
    await interrupted(forwardArgs(),{phase:"prepared",when:"after"});const uuid=tx().uuid,before=h.callLog();
    rmSync(join(h.root,"current"));symlinkSync(`releases/${tool}`,join(h.root,"current"));expect(h.resume(uuid).status).not.toBe(0);expect(h.callLog()).toBe(before);
    rmSync(join(h.root,"current"));symlinkSync(`releases/${h.A}`,join(h.root,"current"));ok(h.resume(uuid));const previous=readlinkSync(join(h.root,"previous"));ok(h.resume(uuid));expect(readlinkSync(join(h.root,"previous"))).toBe(previous);expect(previous).toBe(`releases/${h.A}`);
  });
});


describe.skipIf(process.platform !== "linux")("restore intent admission", { timeout: 35_000 }, () => {
  it("refuses direct promotion without durable start intent while preserving H absent",async()=>{
    ok(h.forward());await interrupted(restoreCommand(),{to:"/codex",when:"before"});const record=tx();expect(existsSync(h.home)).toBe(false);expect(h.current()).toBe(h.A);
    record.replacement.startRequested=false;rewrite(record);mkdirSync(join(h.root,".lock.update"),{mode:0o700});
    const bytes=readFileSync(h.recordPath(record.uuid)),r=runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-switch.sh"),[h.A,"--install-dir",h.root,"--codex-transaction",record.uuid],h.env());
    expect(r.status).not.toBe(0);expect(r.stderr).toContain("Restore start intent is missing");expect(existsSync(h.home)).toBe(false);expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);
  });
});




describe.skipIf(process.platform !== "linux")("retained failed snapshot selection", { timeout: 45_000 }, () => {
  it("restores a terminal failed snapshot after later work and cancels back to its admission release",async()=>{
    await interrupted(forwardArgs(),{phase:"snapshot-verified",when:"after"});const uuid=tx().uuid;ok(h.resume(uuid,"recover"));
    writeFileSync(join(h.home,"sessions/old.jsonl"),"LATER-STATE");ok(h.forward("second"));const before=h.callLog();
    expect(h.resume(uuid,"recover").status).not.toBe(0);expect(h.callLog()).toBe(before);expect(h.current()).toBe(h.B);
    const ino=statSync(h.home).ino;await interrupted(restoreCommand(),{phase:"restore-prepared",when:"after"});
    ok(h.resume(uuid,"recover"));expect(h.current()).toBe(h.B);expect(statSync(h.home).ino).toBe(ino);expect(history()).toBe("LATER-STATE");
    expect(h.records().find(r=>r.uuid===uuid)!.phase).toBe("failed");ok(h.restore());expect(h.current()).toBe(h.A);expect(history()).toBe("HISTORY");expect(h.records().find(r=>r.uuid===uuid)!.phase).toBe("restored");
  });
});

describe.skipIf(process.platform !== "linux")("replacement verification before exposure",{timeout:35000},()=>{
  it.each(["before-home-removal","after-home-removal"])("preserves all objects when staging is corrupt %s",async cut=>{
    ok(h.forward());writeFileSync(join(h.home,"sessions/old.jsonl"),"TARGET-STATE");
    await interrupted(restoreCommand(),cut==="before-home-removal"?{from:"",when:"before"}:{phase:"replace-intent",startRequested:true,when:"before"});
    const record=tx(),homePresent=existsSync(h.home),before=h.callLog();
    expect(homePresent).toBe(cut==="before-home-removal");expect(h.current()).toBe(h.B);
    writeFileSync(join(record.replacement.staging,"sessions/old.jsonl"),"CORRUPT-STAGING");
    expect(h.resume(record.uuid).status).not.toBe(0);expect(h.current()).toBe(h.B);expect(h.callLog()).toBe(before);
    expect(existsSync(h.home)).toBe(homePresent);expect(readFileSync(join(record.replacement.staging,"sessions/old.jsonl"),"utf8")).toBe("CORRUPT-STAGING");
    if(homePresent)expect(history()).toBe("TARGET-STATE");else expect(readFileSync(join(record.replacement.aside,"sessions/old.jsonl"),"utf8")).toBe("TARGET-STATE");
  });
  it.each(["duplicate-aside-credential","missing-stage-credential","extra-home"])("refuses the switch guard with %s before selecting source",async fault=>{
    ok(h.forward());await interrupted(restoreCommand(),{phase:"replace-intent",startRequested:true,when:"after"});
    const record=tx(),r=record.replacement;expect(existsSync(h.home)).toBe(false);expect(h.current()).toBe(h.B);
    if(fault==="duplicate-aside-credential")writeFileSync(join(r.aside,"auth.json"),readFileSync(join(r.staging,"auth.json")),{mode:0o600});
    if(fault==="missing-stage-credential")rmSync(join(r.staging,"auth.json"));
    if(fault==="extra-home")mkdirSync(h.home,{mode:0o700});
    mkdirSync(join(h.root,".lock.update"),{mode:0o700});const bytes=readFileSync(h.recordPath(record.uuid)),before=h.callLog();
    const result=runScript(join(h.root,"releases",h.B,"deploy/kaoiro-runner-switch.sh"),[h.A,"--install-dir",h.root,"--codex-transaction",record.uuid],h.env());
    expect(result.status).not.toBe(0);expect(h.current()).toBe(h.B);expect(h.callLog()).toBe(before);expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);
    expect(existsSync(h.home)).toBe(fault==="extra-home");expect(existsSync(r.staging)).toBe(true);expect(existsSync(r.aside)).toBe(true);
  });
  it("requires source selection before direct home promotion",async()=>{
    ok(h.forward());await interrupted(restoreCommand(),{phase:"replace-intent",startRequested:true,when:"after"});
    const record=tx();for(const lock of [".lock.update",".lock.links"])mkdirSync(join(h.root,lock),{mode:0o700});
    const bytes=readFileSync(h.recordPath(record.uuid)),result=h.state("promote",h.root,record.uuid);
    expect(result.status).not.toBe(0);expect(result.stderr).toContain("Source must be selected before home promotion");
    expect(h.current()).toBe(h.B);expect(existsSync(h.home)).toBe(false);expect(readFileSync(h.recordPath(record.uuid))).toEqual(bytes);
  });
});
