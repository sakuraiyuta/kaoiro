import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { Supervisor, MAX_RESTARTS } from "../src/supervisor.js";
import { toManagedChild } from "../src/spawn.js";

// Actual wrapper processes run built CLI/Host/Session. The server link and
// app-server JSONL child are fixtures, so this verifies supervision, not Codex.
it("restarts broken app-server only in a new wrapper lifetime, bounds retries, and never replays the initial prompt or restarts a stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "fuji-348-supervision-"));
  const require = createRequire(import.meta.url);
  const moduleUrl = (name: string) => pathToFileURL(require.resolve(`@kaoiro/codex/dist/${name}.js`)).href;
  const rpc = join(home, "rpc.mjs"), entry = join(home, "entry.mjs");
  writeFileSync(rpc, `import {createInterface} from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line), reply=result=>send({id:r.id,result});
 if(r.method==='initialize')reply({userAgent:'fixture/0.153.4'});
 if(r.method==='thread/start')reply({thread:{id:'thread'},model:'gpt-5.6-sol',reasoningEffort:'medium'});
 if(r.method==='account/rateLimits/read')send({id:r.id,error:{code:-32600,message:'no account'}});
 if(r.method==='turn/start'){reply({turn:{id:'turn'}});send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});}
}).on('close',()=>process.exit(0));`);
  writeFileSync(entry, `import {spawn} from 'node:child_process';
import {runCodexCli} from ${JSON.stringify(moduleUrl("cli"))};
import {CodexHost} from ${JSON.stringify(moduleUrl("host"))};
import {AppServerSession} from ${JSON.stringify(moduleUrl("app_server_session"))};
let child, callbacks;
process.on('message', command=>{
 if(command==='break')child?.kill('SIGKILL');
 if(command==='next')callbacks.onInstruction('EXPLICIT_NEXT');
});
await runCodexCli({backend:'app-server',
 createServerLink:(_url,_id,options)=>{callbacks=options;queueMicrotask(()=>options.onPersonaPrompt('Fixture'));return {
  send:e=>process.send?.({kind:'envelope',envelope:e}),close(){},currentSessionId:()=>null,setSessionId(){},
  reportDisconnectIntent:async()=>{},
 };},
 createHost:(config,options)=>new CodexHost(config,{...options,
  codexFactory:()=>{process.send?.({kind:'fallback'});throw Error('Unexpected exec fallback');},
  onTurnStart:info=>{options.onTurnStart?.(info);process.send?.({kind:'start'});},
  appServerSessionFactory:options=>AppServerSession.create({...options,transport:{spawnChild:()=>{
   child=spawn(process.execPath,[${JSON.stringify(rpc)}],{stdio:['pipe','pipe','pipe']});
   process.send?.({kind:'child',pid:child.pid});return child;
  }}}),
 }),
}).catch(error=>{process.send?.({kind:'error',message:String(error)});process.exitCode=1;})
.finally(()=>process.disconnect?.());`);
  const children: ChildProcess[] = [], prompts: Array<string | undefined> = [];
  const messages: Array<Array<{ kind: string; envelope?: { type: string; state: string } }>> = [];
  // close follows the Supervisor exit handler and drains the child IPC/stdout.
  const exits: Promise<void>[] = [], stderr: string[] = [];
  const supervisor = new Supervisor({ hostId: "fixture", cwdAllowlist: [home], wrapperServerUrl: "ws://fixture",
    launch: (_id, config, cwd, resume, prompt, engine) => {
      expect(engine).toBe("codex");expect(resume).toBeUndefined();
      const index = children.length, configPath = join(home, `config-${index}.json`);
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });prompts.push(prompt);messages.push([]);stderr.push("");
      const child = spawn(process.execPath, [entry, configPath, ...(prompt === undefined ? [] : [prompt])], {
        cwd, env: { ...process.env, HOME: home, CODEX_HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);exits.push(new Promise(resolve => child.once("close", () => resolve())));
      child.on("message", message => messages[index]!.push(message as { kind: string }));
      child.stderr?.on("data", chunk => { stderr[index] += String(chunk); });
      return toManagedChild(child);
    },
    sendResult: () => {}, sendResetResult: () => {}, sendSessions: () => {}, sendStopAgent: () => {}, listSessions: () => [], sessionExists: () => false,
  });
  const spawnMessage = { version: "0", agent_id: "fixture.codex", engine: "codex", cwd: home,
    persona: { id: "p", name: "P", sprite_set: "p" }, model: "gpt-5.6-sol", initial_prompt: "ONCE" };
  const started = (index: number) => vi.waitFor(() => expect(messages[index]?.filter(m => m.kind === "start"), stderr[index]).toHaveLength(1), { timeout: 10_000 });
  const idle = (index: number) => vi.waitFor(() => expect(messages[index]?.some(m => m.kind === "envelope" && m.envelope?.state === "idle"), stderr[index]).toBe(true), { timeout: 10_000 });
  try {
    supervisor.handleSpawn(spawnMessage);await started(0);
    for (let index = 0; index <= MAX_RESTARTS; index++) {
      expect(messages[index]!.filter(m => m.kind === "child")).toHaveLength(1);
      expect(messages[index]!.filter(m => m.kind === "fallback")).toHaveLength(0);
      children[index]!.send("break");await exits[index];
      expect(messages[index]!.filter(m => m.kind === "child")).toHaveLength(1);
      if (index < MAX_RESTARTS) {
        await idle(index + 1);
        expect(children[index + 1]!.pid).not.toBe(children[index]!.pid);
        expect(prompts[index + 1]).toBeUndefined();expect(messages[index + 1]!.filter(m => m.kind === "start")).toHaveLength(0);
        children[index + 1]!.send("next");await started(index + 1);
      }
    }
    expect(children).toHaveLength(MAX_RESTARTS + 1);
    expect(prompts).toEqual(["ONCE", ...Array(MAX_RESTARTS).fill(undefined)]);
    // A deliberate new spawn resets the budget, but stop is never a restart.
    supervisor.handleSpawn(spawnMessage);const stopped = children.length - 1;await started(stopped);
    supervisor.handleStop(spawnMessage);await exits[stopped];
    expect(children).toHaveLength(MAX_RESTARTS + 2);
  } finally {
    supervisor.stopAll();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(exits);rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
