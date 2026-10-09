#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { collectRunnerBaseline, unitSnapshot } from "./collect-production-release.mjs";
import { validateProductionReceipt } from "./production-release-record.mjs";
import { validateFrozenBuildIdentity } from "./build-identity.mjs";
import { validateReleasePlan } from "./production-release-plan.mjs";
import { RELEASE_ALIAS, parseReleaseOptions } from "./production-release-state.mjs";
import { readPrivateJson, withAsyncReleaseLock, writePrivateRecord } from "./production-release-files.mjs";
import { canonicalRunnerReleaseRow, importRunnerReleaseFact, recordRunnerReleaseActivity,
  validateRunnerReleaseContext } from "./production-release-runner-facts.mjs";
import { reconcileProductionReleases } from "./production-release-reconciliation.mjs";
import { unitCommandSnapshot, verifyRetainedUnitCommand } from "./production-release-unit.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const must=(condition,message)=>{if(!condition)throw new Error(`production worker refused: ${message}`);};
const read=file=>{const raw=readFileSync(file);must(raw.length<=524_288,"record byte bound");return JSON.parse(raw);};
const hostKey=id=>{must(RELEASE_ALIAS.test(id??""),"public host alias required");return id;};
function planFor(dir,host) {
  const plan=read(join(dir,"attempt.json"));
  must(plan.schema===1 && UUID.test(plan.attempt_uuid) && basename(resolve(dir))===plan.attempt_uuid &&
    Array.isArray(plan.host_ids) && plan.host_ids.length>0 && plan.host_ids.length<=16 &&
    new Set(plan.host_ids).size===plan.host_ids.length && plan.host_ids.includes(host) &&
    Array.isArray(plan.codex_host_ids) && plan.codex_host_ids.every(id=>plan.host_ids.includes(id)),"attempt/host binding");
  validateFrozenBuildIdentity(plan.identity);
  validateReleasePlan(plan, plan.attempt_uuid);
  return plan;
}
function recordedReceipt(dir,plan) {
  const receipt=validateProductionReceipt(read(join(dir,"completion.json")),{repositoryId:plan.identity.landing.repository_id,allowedHosts:plan.host_ids});
  must(receipt.attempt_uuid===plan.attempt_uuid && receipt.revision===plan.identity.revision &&
    receipt.version===plan.identity.version && receipt.branch===plan.identity.branch &&
    JSON.stringify([...receipt.host_ids].sort())===JSON.stringify([...plan.host_ids].sort()) &&
    JSON.stringify([...receipt.codex_host_ids].sort())===JSON.stringify([...plan.codex_host_ids].sort()),"completion belongs to another attempt or inventory");
  return receipt;
}
export const runnerWorkerUnit=(uuid,host)=>{
  must(typeof uuid==="string" && uuid.length===36 && UUID.test(uuid),"attempt UUID");
  must(typeof host==="string" && host.length>0,"host ID");
  return `kaoiro-release-${uuid}-${hostKey(host)}.service`;
};
export async function queueProductionRunner({dir,host,runnerRoot,service="kaoiro-runner",updateArgs,delaySeconds=180, configPath,
  systemctlBin="systemctl",systemdRunBin="systemd-run"}) {
  const plan=planFor(dir,host),unit=runnerWorkerUnit(plan.attempt_uuid,host);
  must(Number.isSafeInteger(delaySeconds) && delaySeconds>=1 && delaySeconds<=86_400,"bounded positive start delay");
  must(Array.isArray(updateArgs) && updateArgs.length>=2 && updateArgs.length<=32 && updateArgs.length%2===0,"updater option/value pairs");
  const allowed=new Set(["--tarball","--from-repo","--target","--keep","--codex-home","--codex-backup-dir",
    "--release-repo","--release-authority","--release-attempt","--release-plan-sha256","--release-target",
    "--release-alias","--expected-authority-sha256","--skip-release-reconciliation","--skip-reason"]),options=new Map();
  for(let i=0;i<updateArgs.length;i+=2) {
    const key=updateArgs[i],value=updateArgs[i+1];
    must(allowed.has(key) && !options.has(key) && typeof value==="string" && value.length>0 &&
      Buffer.byteLength(value)<=4096 && !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith("-"),"invalid updater argument");
    options.set(key,value);
  }
  must(options.has("--tarball") !== options.has("--from-repo"),"one production source required");
  must(!options.has("--target") || options.has("--from-repo"),"cross target requires repository source");
  must(options.has("--codex-home")===options.has("--codex-backup-dir"),"Codex state options must be paired");
  must(!options.has("--codex-home") || plan.codex_host_ids.includes(host),"Codex update must be in the fixed inventory");
  configPath ??= join(process.env.KAOIRO_RUNNER_DIR ?? join(homedir(), ".config/kaoiro"), "runner.config.json");
  const context = validateRunnerReleaseContext({ root: runnerRoot, dir, alias: host, configPath });
  const required = { "--release-attempt": plan.attempt_uuid, "--release-plan-sha256": context.plan_sha256,
    "--release-target": plan.identity.revision, "--release-alias": host,
    "--expected-authority-sha256": context.authority.sha256 };
  for (const [key, value] of Object.entries(required)) {
    must(!options.has(key) || options.get(key) === value, `captured ${key} differs from frozen plan`);
    options.set(key, value);
  }
  const audit = await reconcileProductionReleases({ installRoot: runnerRoot, alias: host,
    repository: options.get("--release-repo") ?? options.get("--from-repo"), targetRevision: plan.identity.revision,
    attemptUuid: plan.attempt_uuid, planDigest: context.plan_sha256, expectedAuthorityDigest: context.authority.sha256,
    assertionPath: options.get("--release-authority"), skipCsv: options.get("--skip-release-reconciliation"),
    skipReason: options.get("--skip-reason") });
  const executedArgs = ["--install-dir",resolve(runnerRoot),"--service",service,...[...options].flat()];
  const file=join(dir,`runner-baseline-${hostKey(host)}.json`);
  return withAsyncReleaseLock(dir, `queue-${hostKey(host)}`, async () => {
    must(!existsSync(file),"attempt/host was already queued; use a new attempt for uncertain submission");
    const existing=unitSnapshot(unit,systemctlBin),timer=unitSnapshot(unit.replace(/\.service$/,".timer"),systemctlBin);
    must(existing.LoadState==="not-found" && timer.LoadState==="not-found","dedicated unit name already exists");
    const baseline=collectRunnerBaseline(plan,host,service,runnerRoot,systemctlBin,unit,
      { context, updateArgs: executedArgs, audit, delaySeconds });
    baseline.simulation ||= systemdRunBin!=="systemd-run";
    baseline.delay_seconds=delaySeconds;
    writePrivateRecord(dir, basename(file), baseline, { kind: "runner-fact" });
    must(!baseline.simulation, "simulated submission cannot import production intent");
    importRunnerReleaseFact(context, "baseline", baseline);
    recordRunnerReleaseActivity(context, { state: "intent", unit, currentRevision: baseline.source_revision });
    const args=["--user","--no-block",`--unit=${unit.replace(/\.service$/,"")}`,`--on-active=${delaySeconds}s`,
      "--timer-property=AccuracySec=1s","--timer-property=RandomizedDelaySec=0","--property=Type=oneshot","--property=RemainAfterExit=yes","--expand-environment=no",
      `--setenv=PATH=${process.env.PATH}`,...(process.env.KAOIRO_NODE?[`--setenv=KAOIRO_NODE=${process.env.KAOIRO_NODE}`]:[]),
      `--setenv=KAOIRO_RUNNER_DIR=${dirname(configPath)}`,
      `--setenv=KAOIRO_RELEASE_RETAINED_UNIT=${unit}`,
      "--",baseline.node_path,baseline.launcher,"worker",baseline.tool_sha256,dirname(baseline.updater_tool),...executedArgs];
    execFileSync(systemdRunBin,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:15_000,maxBuffer:16_384});
    recordRunnerReleaseActivity(context, { state: "queued", unit, currentRevision: baseline.source_revision });
    return {queued:true,completed:false,unit,baseline_file:file,delay_seconds:delaySeconds};
  });
}
export function cleanupProductionRunner({dir,host,runnerRoot=dirname(dirname(resolve(dir))),configPath,
  systemctlBin="systemctl"}) {
  const plan=planFor(dir,host),file=join(dir,`runner-baseline-${hostKey(host)}.json`),baseline=read(file);
  must(!baseline.simulation && systemctlBin==="systemctl","simulated units cannot use production cleanup");
  configPath ??= join(process.env.KAOIRO_RUNNER_DIR ?? join(homedir(), ".config/kaoiro"), "runner.config.json");
  const context = validateRunnerReleaseContext({ root: runnerRoot, dir, alias: host, configPath });
  const canonical = canonicalRunnerReleaseRow(context);
  must(canonical.completion, "canonical completion required before dedicated unit cleanup");
  const receipt = validateProductionReceipt(canonical.completion, { allowedHosts: plan.host_ids });
  if (existsSync(join(dir, "completion.json"))) {
    must(JSON.stringify(recordedReceipt(dir,plan)) === JSON.stringify(receipt), "copied completion differs from canonical receipt");
  }
  const unit=runnerWorkerUnit(plan.attempt_uuid,host),fact=receipt.runners.find(item=>item.host_id===host);
  must(baseline.updater===unit && baseline.attempt_uuid===plan.attempt_uuid && fact,"recorded dedicated worker required");
  const state=unitSnapshot(unit,systemctlBin);
  if(state.LoadState==="not-found")return {cleaned:true,unit,reused:true};
  must(state.InvocationID===fact.update_invocation_id && state.ActiveState==="active" && state.SubState==="exited" &&
    state.Result==="success" && state.ExecMainCode==="1" && state.ExecMainStatus==="0", "unit differs from recorded completed worker");
  verifyRetainedUnitCommand(unitCommandSnapshot(unit), baseline.node_path,
    [baseline.node_path,baseline.launcher,"worker",baseline.tool_sha256,dirname(baseline.updater_tool),...baseline.update_args]);
  const names=[unit,unit.replace(/\.service$/,".timer")].filter(name=>unitSnapshot(name,systemctlBin).LoadState!=="not-found");
  execFileSync(systemctlBin,["--user","stop","--",...names],{stdio:"pipe",timeout:15_000});
  for(const name of names) {
    try {execFileSync(systemctlBin,["--user","reset-failed","--",name],{stdio:"pipe",timeout:5000});}
    catch(error) {if(unitSnapshot(name,systemctlBin).LoadState!=="not-found")throw error;}
  }
  for(const name of names)must(unitSnapshot(name,systemctlBin).LoadState==="not-found","retained worker was not removed");
  return {cleaned:true,unit,reused:false};
}
export function listRetainedProductionRunners(root,{systemctlBin="systemctl"}={}) {
  const rows=[];
  if(!existsSync(root))return rows;
  const dirs=readdirSync(root).filter(name=>UUID.test(name));must(dirs.length<=1000,"attempt listing bound");
  for(const name of dirs) {
    const dir=join(root,name);if(!lstatSync(dir).isDirectory())continue;
    const raw=read(join(dir,"attempt.json")),plan=planFor(dir,raw.host_ids?.[0]);
    let recorded=false;
    try {recordedReceipt(dir,plan);recorded=true;} catch { /* Invalid completion records must also remain visible. */ }
    for(const host of plan.host_ids) {
      const unit=runnerWorkerUnit(name,host),state=unitSnapshot(unit,systemctlBin);
      if(state.LoadState!=="not-found")rows.push({attempt_uuid:name,host_id:host,unit,state:state.ActiveState,
        recorded,warning:!recorded});
    }
  }
  return rows;
}
async function main() {
  const [command,...argv]=process.argv.slice(2),flags=parseReleaseOptions(argv,
    ["attempt", "host", "runner-root", "config", "service", "update-args", "delay", "root"]);
  if(command==="queue")console.log(JSON.stringify(await queueProductionRunner({dir:flags.attempt,host:flags.host,runnerRoot:flags["runner-root"],configPath:flags.config,
    service:flags.service,updateArgs:JSON.parse(flags["update-args"]),delaySeconds:flags.delay===undefined?180:Number(flags.delay)})));
  else if(command==="cleanup")console.log(JSON.stringify(cleanupProductionRunner({dir:flags.attempt,host:flags.host})));
  else if(command==="list")console.log(JSON.stringify(listRetainedProductionRunners(flags.root)));
  else throw new Error("unknown worker command");
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{await main();}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
