import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { artifactBuildIdentity, BUILD_REPOSITORY_ID } from "../build-identity.mjs";
import { startReleaseAttempt, completeReleaseAttempt } from "../production-release-record.mjs";
import { cleanupProductionRunner, listRetainedProductionRunners, queueProductionRunner, runnerWorkerUnit } from "../production-runner-worker.mjs";
import { collectRunnerCompletion } from "../collect-production-release.mjs";

const roots=[];
const saved=new Map();
function env(key,value) { if(!saved.has(key))saved.set(key,process.env[key]); process.env[key]=value; }
afterEach(()=>{for(const [key,value] of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}saved.clear();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"fuji571-retained-worker-test-"));roots.push(root);
  const bin=join(root,"bin"),runner=join(root,"runner"),tool=join(runner,"current/deploy/kaoiro-runner-update.sh");
  mkdirSync(bin);mkdirSync(join(runner,"current/deploy"),{recursive:true});writeFileSync(tool,"#!/bin/sh\nexit 0\n",{mode:0o755});
  const stateFile=join(root,"state.json"),callsFile=join(root,"calls.jsonl");writeFileSync(stateFile,"{}");
  const program=`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.FUJI571_CALLS,JSON.stringify({bin:require('node:path').basename(process.argv[1]),args:a})+'\\n');const state=JSON.parse(fs.readFileSync(process.env.FUJI571_STATE));if(a[1]==='show'){const value=state[a[2]]??{LoadState:'not-found',ActiveState:'inactive',InvocationID:''};console.log(Object.entries(value).map(([k,v])=>k+'='+v).join('\\n'));}if(a[1]==='stop'){for(const unit of a.slice(2))delete state[unit];fs.writeFileSync(process.env.FUJI571_STATE,JSON.stringify(state));}if(a[1]==='reset-failed')process.exit(1);\n`;
  for(const name of ["systemctl","systemd-run"])writeFileSync(join(bin,name),program,{mode:0o755});
  env("PATH",`${bin}:${process.env.PATH}`);env("FUJI571_STATE",stateFile);env("FUJI571_CALLS",callsFile);
  const revision="a".repeat(40),identity=artifactBuildIdentity({revision,dirty:false,version:"2026.10.09.1",branch:"develop",channel:"dev",landing:{schema:1,kind:"landing",repository_id:BUILD_REPOSITORY_ID,revision,branch:"develop",version:"2026.10.09.1",original_run_id:1,created_at:"2026-10-09T00:00:00Z"}});
  const {dir,plan}=startReleaseAttempt(join(root,"attempts"),identity,["homeguard"],[]);
  const unit=runnerWorkerUnit(plan.attempt_uuid,"homeguard");
  const queue=extra=>queueProductionRunner({dir,host:"homeguard",runnerRoot:runner,updateArgs:["--from-repo",root],...extra});
  const calls=()=>readFileSync(callsFile,"utf8").trim().split("\n").map(JSON.parse);
  const state=values=>writeFileSync(stateFile,JSON.stringify(values));
  const t=n=>new Date(Date.parse(plan.created_at)+n).toISOString();
  const receipt={schema:1,kind:"production_completion",environment:"production",publication_mode:"by_landing",repository_id:BUILD_REPOSITORY_ID,attempt_uuid:plan.attempt_uuid,revision,version:identity.version,branch:"develop",completed_at:t(3),host_ids:plan.host_ids,codex_host_ids:[],server:{transaction_id:"fixture-server",image_id:`sha256:${"b".repeat(64)}`,container_id:"fixture-container",health_revision:revision,health_dirty:false,stability_passed:true,journal_sha256:"c".repeat(64),manifest_sha256:"d".repeat(64)},runners:[{host_id:"homeguard",revision,version:identity.version,branch:"develop",dirty:false,unit:"kaoiro-runner",update_invocation_id:"e".repeat(32),service_active:true,worker_exit:0,worker_started_at:t(1),worker_finished_at:t(2),artifact_sha256:"f".repeat(64),codex:null}],canary:{passed:true,operator:"fixture-operator",revision,completed_at:t(2),evidence_sha256:"0".repeat(64)}};
  const finished={LoadState:"loaded",ActiveState:"active",SubState:"exited",Result:"success",ExecMainCode:"1",ExecMainStatus:"0",InvocationID:"e".repeat(32),ExecStart:`{ path=${tool} ; argv[]=${tool} ; }`};
  return {root,dir,plan,unit,queue,calls,state,receipt,finished,bin,runner};
}
test("the default constructor durably queues a delayed retained worker without detach",()=>{
  const f=fixture(),result=f.queue();
  assert.equal(result.completed,false);assert.equal(result.delay_seconds,180);
  const baseline=JSON.parse(readFileSync(result.baseline_file));assert.equal(baseline.updater,f.unit);assert.equal(baseline.attempt_uuid,f.plan.attempt_uuid);
  const invocation=f.calls().find(call=>call.bin==="systemd-run");
  assert.ok(invocation.args.includes("--on-active=180s"));assert.ok(invocation.args.includes("--property=Type=oneshot"));assert.ok(invocation.args.includes("--property=RemainAfterExit=yes"));assert.ok(invocation.args.includes("--timer-property=AccuracySec=1s"));assert.ok(invocation.args.includes("--timer-property=RandomizedDelaySec=0"));
  assert.ok(invocation.args.includes("--no-block"));assert.ok(!invocation.args.includes("--detach"));assert.ok(!invocation.args.some(arg=>arg.includes("KAOIRO_RUNNER_TOKEN=")));
  assert.throws(()=>f.queue(),/already queued/);assert.equal(f.calls().filter(call=>call.bin==="systemd-run").length,1);
});
test("uncertain submission remains reserved and is never queued twice",()=>{
  const f=fixture();
  assert.throws(()=>f.queue({systemdRunBin:join(f.root,"missing-command")}),/ENOENT/);
  assert.throws(()=>f.queue(),/already queued/);
});
test("unit collisions, nonpositive delays, and unapproved update arguments refuse before enqueue",()=>{
  const f=fixture();f.state({[f.unit]:{LoadState:"loaded",ActiveState:"active"}});
  assert.throws(()=>f.queue(),/already exists/);f.state({});
  for(const delaySeconds of [0,-1,NaN,86401])assert.throws(()=>f.queue({delaySeconds}),/delay/);
  for(const updateArgs of [["--allow-dirty","yes"],["--tarball","x","--from-repo","y"],["--from-repo","x","--codex-home","h","--codex-backup-dir","b"]])assert.throws(()=>f.queue({updateArgs}));
  assert.equal(f.calls().filter(call=>call.bin==="systemd-run").length,0);
});
test("completion must be valid and bound to this inventory before the exact units are cleaned",()=>{
  const f=fixture();f.queue();f.state({[f.unit]:f.finished,[f.unit.replace(/service$/,"timer")]:{LoadState:"loaded",ActiveState:"active"}});
  assert.throws(()=>cleanupProductionRunner({dir:f.dir,host:"homeguard"}),/ENOENT/);
  writeFileSync(join(f.dir,"completion.json"),JSON.stringify({...f.receipt,revision:"b".repeat(40),server:{...f.receipt.server,health_revision:"b".repeat(40)},runners:f.receipt.runners.map(r=>({...r,revision:"b".repeat(40)})),canary:{...f.receipt.canary,revision:"b".repeat(40)}}));
  assert.throws(()=>cleanupProductionRunner({dir:f.dir,host:"homeguard"}),/another attempt/);
  rmSync(join(f.dir,"completion.json"));completeReleaseAttempt(f.dir,f.receipt,{allowedHosts:f.plan.host_ids});
  f.state({[f.unit]:{...f.finished,InvocationID:"f".repeat(32)}});assert.throws(()=>cleanupProductionRunner({dir:f.dir,host:"homeguard"}),/differs/);
  assert.equal(f.calls().filter(call=>call.args[1]==="stop").length,0);
  f.state({[f.unit]:f.finished,[f.unit.replace(/service$/,"timer")]:{LoadState:"loaded",ActiveState:"active"}});
  assert.equal(cleanupProductionRunner({dir:f.dir,host:"homeguard"}).reused,false);
  assert.deepEqual(f.calls().find(call=>call.args[1]==="stop").args,["--user","stop",f.unit,f.unit.replace(/service$/,"timer")]);
  assert.equal(cleanupProductionRunner({dir:f.dir,host:"homeguard"}).reused,true);
});
test("retained listing warns on absent or invalid completion and never cleans anything",()=>{
  const f=fixture();f.queue();f.state({[f.unit]:f.finished});
  const root=join(f.root,"attempts");assert.equal(listRetainedProductionRunners(root)[0].warning,true);
  writeFileSync(join(f.dir,"completion.json"),"{}");assert.equal(listRetainedProductionRunners(root)[0].warning,true);
  rmSync(join(f.dir,"completion.json"));completeReleaseAttempt(f.dir,f.receipt,{allowedHosts:f.plan.host_ids});
  assert.equal(listRetainedProductionRunners(root)[0].warning,false);
  assert.equal(f.calls().filter(call=>call.args[1]==="stop").length,0);
  assert.deepEqual(listRetainedProductionRunners(join(f.root,"missing")),[]);
});
test("the default completion reader accepts retained success and refuses collected or running workers",()=>{
  const f=fixture(),queued=f.queue(),baseline=JSON.parse(readFileSync(queued.baseline_file));
  mkdirSync(join(f.runner,"current/dist"));writeFileSync(join(f.runner,"current/dist/build-info.json"),JSON.stringify(f.plan.identity));
  const configPath=join(f.root,"runner.config.json");writeFileSync(configPath,JSON.stringify({host_id:"homeguard"}));
  const options={runnerRoot:f.runner,configPath};
  const states={[f.unit]:{...f.finished,ExecMainStartTimestamp:new Date(Date.parse(baseline.created_at)+10).toISOString(),ExecMainExitTimestamp:new Date(Date.parse(baseline.created_at)+20).toISOString()},"kaoiro-runner":{LoadState:"loaded",ActiveState:"active",MainPID:"1234"}};
  f.state(states);assert.equal(collectRunnerCompletion(f.plan,baseline,options).update_invocation_id,"e".repeat(32));
  for(const bad of [{LoadState:"not-found",ActiveState:"inactive"},{...states[f.unit],SubState:"running"},{...states[f.unit],ExecMainStatus:"1"},{...states[f.unit],ExecStart:"{ path=/another/tool ; }"},{...states[f.unit],InvocationID:baseline.previous_invocation}]) {
    f.state({...states,[f.unit]:bad});assert.throws(()=>collectRunnerCompletion(f.plan,baseline,options));
  }
});
