import "../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStateFixture, type StateFixture } from "./codexStateFixture.js";

let h: StateFixture;
beforeEach(async () => { h = await createStateFixture(); });
afterEach(async () => { await h?.close(); });
const editControl = (fn: (s: string) => string) => { const s=readFileSync(h.ctl,"utf8"), next=fn(s); expect(next).not.toBe(s); writeFileSync(h.ctl,next); };
const atStop = (code: string) => editControl(s => s.replace("fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive');", "fs.writeFileSync(dir+'/active',fs.existsSync(dir+'/remain-active')?'active':'inactive');"+code));
const atStart = (code: string) => editControl(s => s.replace("fs.appendFileSync(dir+'/calls','start\\n');", "fs.appendFileSync(dir+'/calls','start\\n');"+code));
const record = () => h.records()[0]!;

describe.skipIf(process.platform !== "linux")("kept source-recovery safeguards", () => {
  it.each(["late-unknown","copy-fault","backup-fault","phase-fault"])("resumes source after %s with recoverable residue", fault => {
    if (fault === "late-unknown") h.trigger(fault);
    else if (fault === "copy-fault") {
      const preload=join(h.dir,"fault-preload.mjs");
      writeFileSync(preload,readFileSync(preload,"utf8")+`\nconst copy=fs.copyFileSync;fs.copyFileSync=(from,to,...args)=>{if(String(to).includes('/.staging.codex-'))throw new Error('copy fault');return copy(from,to,...args)};syncBuiltinESMExports();\n`);
    } else if (fault === "backup-fault") h.fault({to:"/backup",when:"after",error:true,once:true});
    else h.fault({phase:"snapshot-verified",when:"before",error:true,once:true});
    const ino=statSync(h.home).ino, r=h.forward();
    expect(r.status,r.stderr).not.toBe(0); expect(r.stderr).toContain("unchanged source was resumed");
    expect(h.callLog()).toBe("stop\nstart\n"); expect(h.current()).toBe(h.A); expect(statSync(h.home).ino).toBe(ino);
    expect(record().phase).toBe("failed"); expect(readFileSync(join(h.home,"auth.json"),"utf8")).toBe("CURRENT_TOKEN");
    expect(record().snapshot.status).toBe(["backup-fault","phase-fault"].includes(fault)?"retained":"retired");
    expect(existsSync(record().snapshot.staging)).toBe(false);
  });
  it.each(["reject-stop-active","reject-stop-inactive","transitional"])("handles %s without unsafe subsequent effects", fault => {
    if (fault === "reject-stop-active") h.trigger("reject-stop");
    else if (fault === "reject-stop-inactive") atStop("process.exit(77);");
    else { atStop("fs.writeFileSync(dir+'/active','deactivating');"); editControl(s=>s.replace("ActiveState:active?'active':'inactive'", "ActiveState:fs.readFileSync(dir+'/active','utf8')")); }
    const r=h.forward(); expect(r.status).not.toBe(0);
    if(fault!=="transitional")expect(r.status).toBe(77);
    expect(h.callLog()).toBe(fault === "reject-stop-inactive"?"stop\nstart\n":"stop\n"); expect(h.current()).toBe(h.A);
  });
  it.each(["error","transitional"])("refuses a late %s activity read before stop", mode => {
    editControl(s=>s.replace("const shim=root+'/current/deploy/kaoiro-runner-launch.sh';",`if(prop==='ActiveState' && fs.existsSync(root+'/codex-state/v2/records')) { ${mode==="error"?"process.exit(67);":"console.log('deactivating');process.exit(0);"} } const shim=root+'/current/deploy/kaoiro-runner-launch.sh';`));
    expect(h.forward().status).not.toBe(0); expect(h.callLog()).toBe(""); expect(record().phase).toBe("prepared");
  });
  it.each(["late-link","late-release","links-held"])("refuses source restart after %s", fault => {
    h.trigger("late-unknown");
    if (fault === "late-link") atStop(`fs.unlinkSync(root+'/current');fs.symlinkSync('releases/${h.B}',root+'/current');`);
    if (fault === "late-release") atStop(`fs.appendFileSync(root+'/releases/${h.A}/dist/stub_dep.js','changed');`);
    if (fault === "links-held") atStop("fs.mkdirSync(root+'/.lock.links');");
    const r=h.forward(); expect(r.status).not.toBe(0); expect(h.callLog()).toBe("stop\n"); expect(r.stderr).toContain("source recovery refused");
  });
  it.each(["start-intent","replace-intent","completed","corrupt"])("never treats changed phase %s as a pre-start source return", phase => {
    atStop(`for(const name of fs.readdirSync(root+'/codex-state/v2/records')) { const p=root+'/codex-state/v2/records/'+name,t=JSON.parse(fs.readFileSync(p));t.phase=${JSON.stringify(phase)};fs.writeFileSync(p,JSON.stringify(t)); }`);
    const r=h.forward(); expect(r.status).not.toBe(0); expect(h.callLog()).toBe("stop\n");
  });
  it.each(["fail-start","no-start","no-mainpid","bad-live"])("reports %s as failed source recovery", fault => {
    h.trigger("late-unknown");
    // The source start must be requested only after `failed` is durable.
    atStart("{const records=root+'/codex-state/v2/records';fs.appendFileSync(dir+'/start-phases',fs.readdirSync(records).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(records+'/'+n,'utf8')).phase).join(',')+'\\n');}"
      + (fault === "fail-start" ? "process.exit(66);" : ""));
    if (fault === "no-start") editControl(s=>s.replace("fs.writeFileSync(dir+'/active','active'); child.unref();", "fs.writeFileSync(dir+'/active','inactive'); child.unref();"));
    if (fault === "no-mainpid") editControl(s=>s.replace("MainPID:active?String(ownerPid):'0'", "MainPID:active&&!fs.existsSync(dir+'/owned-pids/'+ownerPid+'.json')?String(ownerPid):'0'"));
    if (fault === "bad-live") { const other=join(h.dir,"other-home");mkdirSync(other,{mode:0o700}); editControl(s=>s.replace(`CODEX_HOME:${JSON.stringify(h.home)}`,`CODEX_HOME:${JSON.stringify(other)}`)); }
    const r=h.forward(); expect(r.status).not.toBe(0); expect(h.callLog()).toBe("stop\nstart\n"); expect(r.stderr).not.toContain("unchanged source was resumed");
    expect(readFileSync(join(h.dir,"start-phases"),"utf8")).toBe("failed\n"); expect(record().phase).toBe("failed");
  });
  it.each(["active","inactive"])("restarts a failed restore only if admission began %s", activity => {
    const forward=h.forward(); expect(forward.status,forward.stderr).toBe(0);
    writeFileSync(join(h.dir,"active"),activity);h.trigger("late-populated");
    if(activity === "inactive") { writeFileSync(join(h.dir,"fake-cgroup/kaoiro-test/cgroup.procs"),"900002\n");writeFileSync(join(h.dir,"fake-cgroup/kaoiro-test/cgroup.events"),"populated 1\n"); }
    const ino=statSync(h.home).ino;
    const r=h.restore(); expect(r.status).not.toBe(0); expect(h.callLog()).toBe(activity==="active"?"stop\nstart\nstop\nstart\n":"stop\nstart\n");
    expect(statSync(h.home).ino).toBe(ino); expect(h.current()).toBe(h.B); expect(record().phase).toBe("restore-prepared");
  });
});
