#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateProductionReceipt, receiptDigest } from "./production-release-record.mjs";
import { validateFrozenBuildIdentity } from "./build-identity.mjs";
import { readPublishedProductionRelease } from "./production-release-tags.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const read=file=>{const raw=readFileSync(file);if(raw.length>524_288)throw new Error("completion input exceeds bound");return JSON.parse(raw);};
const must=(value,message)=>{if(!value)throw new Error(message);};
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
function completedAttempt(dir) {
  const plan=read(join(dir,"attempt.json")),receipt=read(join(dir,"completion.json"));
  validateFrozenBuildIdentity(plan.identity);
  validateProductionReceipt(receipt,{repositoryId:plan.identity.landing.repository_id,allowedHosts:plan.host_ids});
  must(UUID.test(plan.attempt_uuid) && basename(resolve(dir))===plan.attempt_uuid &&
    receipt.attempt_uuid===plan.attempt_uuid && receipt.revision===plan.identity.revision &&
    receipt.version===plan.identity.version && receipt.branch===plan.identity.branch &&
    JSON.stringify([...receipt.host_ids].sort())===JSON.stringify(plan.host_ids) &&
    JSON.stringify([...receipt.codex_host_ids].sort())===JSON.stringify(plan.codex_host_ids),"completion/card attempt differs");
  return {plan,receipt};
}
export function productionDispatchCard({dir,cwd,repository="sakuraiyuta/kaoiro"}) {
  must(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),"invalid fixed repository");
  const {receipt}=completedAttempt(dir);
  const tools=resolve(cwd),head=execFileSync("git",["rev-parse","HEAD"],{cwd:tools,encoding:"utf8",stdio:"pipe",timeout:5000}).trim();
  must(/^[0-9a-f]{40}$/.test(head),"reviewed tool commit unavailable");
  const command=`gh workflow run production-release.yml --repo ${quote(repository)} --ref develop -f ${quote(`receipt=${JSON.stringify(receipt)}`)}`;
  const verification=`node ${quote(join(tools,"scripts/collect-production-release.mjs"))} ack --attempt ${quote(resolve(dir))} --repo ${quote(tools)}`;
  return {schema:1,attempt_uuid:receipt.attempt_uuid,revision:receipt.revision,version:receipt.version,receipt_sha256:receiptDigest(receipt),
    tools_revision:head,repository,workflow:"production-release.yml",ref:"develop",command,verification,
    notice:"Run with the operator's own gh after canary. Dispatch success is not publication acknowledgment; verification must exit 0 after both remote refs agree."};
}
export function auditProductionCompletions({root,cwd,remote="origin"}) {
  if(!existsSync(root))return [];
  const names=readdirSync(root).filter(name=>UUID.test(name));must(names.length<=1000,"completion audit listing bound");
  const rows=[];
  for(const name of names) {
    const dir=join(root,name);if(!lstatSync(dir).isDirectory() || !existsSync(join(dir,"completion.json")))continue;
    let receipt,plan;
    try {({receipt,plan}=completedAttempt(dir));}
    catch {rows.push({attempt_uuid:name,status:"invalid_completion"});continue;}
    try {
      const pair=readPublishedProductionRelease({cwd,receipt,remote,repositoryId:receipt.repository_id,allowedHosts:plan.host_ids});
      rows.push({attempt_uuid:name,revision:receipt.revision,status:"published",tag:pair.tag,object:pair.object});
    } catch(error) {
      rows.push({attempt_uuid:name,revision:receipt.revision,status:error.message==="release publication has not been acknowledged" ? "publication_missing" : "publication_unconfirmed"});
    }
  }
  return rows;
}
async function main() {
  const [command,...args]=process.argv.slice(2),flags={};
  for(let i=0;i<args.length;i+=2){must(args[i]?.startsWith("--") && args[i+1],"option/value pairs required");flags[args[i].slice(2)]=args[i+1];}
  if(command==="card")console.log(JSON.stringify(productionDispatchCard({dir:flags.attempt,cwd:flags.repo,repository:flags.repository}),null,2));
  else if(command==="audit") {
    const rows=auditProductionCompletions({root:flags.root,cwd:flags.repo});console.log(JSON.stringify(rows,null,2));
    if(rows.some(row=>row.status!=="published"))process.exitCode=1;
  } else throw new Error("unknown production dispatch command");
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{await main();}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
