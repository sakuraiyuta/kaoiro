import "../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { expect } from "vitest";

export async function absentHomeBoot(dir: string, home: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address=server.address(); if(typeof address === "string" || !address) throw new Error("No endpoint address");
  let result: any;
  server.on("connection", socket=>socket.on("message", raw=>{
    const [jr,ref,topic,event,payload]=JSON.parse(String(raw));
    if(event === "phx_join" || event === "register" || event === "heartbeat") socket.send(JSON.stringify([jr,ref,topic,"phx_reply",{status:"ok",response:{}}]));
    if(event === "register") socket.send(JSON.stringify([jr,null,topic,"spawn",{version:"0",agent_id:"n2-absent-home",engine:"codex",cwd:dir,persona:{id:"fixture",name:"Fixture",sprite_set:"fixture"}}]));
    if(event === "spawn_result") result=payload;
  }));
  const trace=join(dir,"boot-spawns"),preload=join(dir,"boot-observer.mjs"),config=join(dir,"boot-runner.json");
  const tmp=join(dir,"boot-tmp");mkdirSync(tmp,{recursive:true,mode:0o700});
  writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn;cp.spawn=(file,args,...rest)=>{const kind=String(file).endsWith('/codex')?'native':args?.some(a=>String(a).includes('/codex/dist/cli.js'))?'wrapper':'other';fs.appendFileSync(${JSON.stringify(trace)},kind+'\\n');return original(file,args,...rest)};syncBuiltinESMExports();`);
  writeFileSync(config,JSON.stringify({host_id:"n2-boot",server_url:`ws://127.0.0.1:${address.port}/runner`,cwd_allowlist:[dir],capabilities:["codex"],codex:{auth_mode:"chatgpt"}}),{mode:0o600});
  const runner=spawn(process.execPath,[fileURLToPath(new URL("../dist/cli.js",import.meta.url)),config],{env:{PATH:process.env.PATH!,HOME:dir,CODEX_HOME:home,TMPDIR:tmp,NODE_OPTIONS:(process.env.NODE_OPTIONS||"")+" --import="+preload},stdio:["ignore","ignore","pipe"]});
  let stderr="";runner.stderr?.on("data",chunk=>{stderr+=chunk;});
  const closed=new Promise<void>(resolve=>runner.once("close",()=>resolve()));
  try{
    const deadline=Date.now()+8000;
    while(!result && Date.now()<deadline && runner.exitCode===null)await new Promise(resolve=>setTimeout(resolve,20));
    expect(result,stderr).toMatchObject({ok:false,reason:"error"});
    const spawns=existsSync(trace)?readFileSync(trace,"utf8").trim().split("\n"):[];
    expect(spawns.filter(x=>x==="native")).toHaveLength(0);
    expect(spawns.filter(x=>x==="wrapper")).toHaveLength(0);
  } finally {
    if(runner.exitCode===null && runner.signalCode===null)runner.kill("SIGTERM");
    await closed;
    for(const socket of server.clients)socket.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}
