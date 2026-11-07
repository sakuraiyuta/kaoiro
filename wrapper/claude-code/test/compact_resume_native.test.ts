import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? jsonlFiles(join(dir, entry.name))
    : Promise.resolve(entry.isFile() && entry.name.endsWith(".jsonl") ? [join(dir, entry.name)] : [])));
  return nested.flat();
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// The built CLI constructs the real Host, transport, SDK and bundled CLI.
// Only external services are fixtures; production input, hooks and results remain intact.
it.each([... ["native", "legacy"].flatMap(ownership =>
  ["text", "tool", "root", "two", "starved", "queued"].map(scenario => ({ ownership, scenario }))), { ownership: "native", scenario: "post" }])(
  "compact resume $ownership $scenario", async ({ownership,scenario}) => {
    const sdkPath = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const sdk = JSON.parse(await readFile(join(sdkPath, "package.json"), "utf8"));
    expect([sdk.version, sdk.claudeCodeVersion]).toEqual(["0.3.319", "2.1.319"]);
    const root = await mkdtemp(join(tmpdir(), "kaoiro-compact-resume-native-"));
    const cfg = join(root, ".claude"), cwd = join(root, "project");
    await mkdir(cfg); await mkdir(cwd);
    await writeFile(join(cfg, "settings.json"), JSON.stringify({ agentPushNotifEnabled: true }));
    await writeFile(join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, cachedGrowthBookFeatures: {
      tengu_amber_sentinel: true, tengu_kairos_push_notifications: true,
    }, cachedGrowthBookFeaturesAt: Date.now() }));
    const persistent = true;
    const resumeNote = "RESUME-991: resume work: reply to the original request, send a new work request, and write WORK-RESUMED to a file.\nUnicode: \u65e5\u672c\u8a9e \u00e9\nTrailing spaces:  \n";
    let postSent = false; let foldToolIssued = false; let action=0; const issued:any[]=[]; let taskIssued = false, compactIssued = false, compactSeen = false, searched = false, calls = 0;
    let taskBarrier: ServerResponse | undefined;
    let secondBarrier: ServerResponse | undefined, held=false;
    const queueRows=async()=>{
      const rows:any[]=[];
      for(const file of await jsonlFiles(join(cfg,"projects"))) for(const line of (await readFile(file,"utf8")).split("\n")){
        try{const q=JSON.parse(line);if(q.type==="queue-operation")rows.push(q);}catch{}
      }
      return rows;
    };
    const toolResults: unknown[] = [], requests: unknown[] = [];
    const provider = createServer(async (request, response) => {
      if(request.url==="/task2"){secondBarrier=response;return;}
      if (request.url === "/task") { taskBarrier = response; return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(request.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}"); return;
      }
      const payload = JSON.parse(raw); calls++;
      const offered = (name: string) => (payload.tools ?? []).some((tool: any) => tool.name === name);
      const messages = JSON.stringify(payload.messages);
      const compactRequest = compactIssued && (JSON.stringify(payload.system).includes("summarizing conversations") || messages.includes("detailed summary of the conversation"));

      if (compactRequest && !compactSeen) {
        compactSeen = true;
        if (!taskBarrier) throw Error("compact before Monitor barrier");
        if(!["root","post"].includes(scenario)){taskBarrier.writeHead(200); taskBarrier.end("release"); taskBarrier = undefined;}
        await delay(1500);
      }
      for (const message of payload.messages ?? []) for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type === "tool_result") toolResults.push(part);
      }
      const address = provider.address(); if (!address || typeof address === "string") throw Error("No provider port");
      const command = (path: string, event: boolean) => {
        const code = `require("http").get("http://127.0.0.1:${address.port}/${path}",r=>{r.resume();r.on("end",()=>{${event ? 'console.log("EVENT-991");' : ""}${event && persistent ? "setTimeout(()=>{},60000);" : ""}})})`;
        const twice=`const h=require("http");h.get("http://127.0.0.1:${address.port}/task",r=>{r.resume();r.on("end",()=>{console.log("EVENT-991-N1");h.get("http://127.0.0.1:${address.port}/task2",s=>{s.resume();s.on("end",()=>{console.log("EVENT-991-N2");setTimeout(()=>{},60000);});});});})`;
        return shellQuote(process.execPath) + " -e " + shellQuote(scenario==="two" ? twice : code);
      };
      let use: { name: string; input: Record<string, unknown> } | undefined;
      const source = "Monitor";
      if (!searched && offered("ToolSearch") && (!offered(source) || !offered("mcp__kaoiro__request_compact"))) {
        searched = true; use = { name: "ToolSearch", input: { query: "select:Monitor,mcp__kaoiro__request_compact,mcp__kaoiro__send_to_agent" } };
      } else if (!taskIssued && offered(source) && messages.includes("START-991")) {
        taskIssued = true;
        use = { name: source, input: { command: command("task", true), description: "fixture monitor",
          persistent, timeout_ms: 60000 } };
      } else if (taskIssued && !compactIssued && offered("mcp__kaoiro__request_compact")) {
        compactIssued = true;
        use = { name: "mcp__kaoiro__request_compact", input: { reason:"probe", resume_prompt:resumeNote } };
      }
      if (compactRequest) use = undefined;
      if (!compactRequest && compactSeen && !foldToolIssued && ["tool","starved","post"].includes(scenario) && messages.includes("<task-notification>")) {
        foldToolIssued = true; use = {name:"Bash",input:{command: shellQuote(process.execPath) + " -e 'setTimeout(()=>{},400)'",description:"notification tool boundary"}};
      }

      const delivered=messages.includes("[kaoiro] Compaction has finished.");
      if(scenario==="two" && !compactRequest && !held && messages.includes("<event>EVENT-991-N1</event>")){
        held=true;
        await wait(async()=>!!secondBarrier && (await queueRows()).some(q=>q.operation==="enqueue" && q.content?.startsWith("[kaoiro] Compaction")));
        secondBarrier!.end("N2");secondBarrier=undefined;
        await wait(async()=>(await queueRows()).some(q=>q.operation==="enqueue" && q.content?.includes("<event>EVENT-991-N2</event>")));
      }
      if(!compactRequest && delivered && !use && action<3){
        if(action===0)use={name:"mcp__kaoiro__send_to_agent",input:{to:"fixture.peer",kind:"response",conversation_id:"fixture-conversation-991",body:"RESUMED-REPLY",done:false}};
        else if(action===1)use={name:"mcp__kaoiro__send_to_agent",input:{to:"fixture.peer",kind:"request",body:"RESUMED-NEW-WORK",done:false}};
        else use={name:"Bash",input:{command:"printf WORK-RESUMED > resumed.txt",description:"resume ordinary work"}};
        issued.push({action,id:`fixture_call_${calls}`,tool:use.name}); action++;
      }
      if(scenario==="post" && messages.includes("<task-notification>") && !use && !postSent){
        postSent=true; use={name:"mcp__kaoiro__send_to_agent",input:{to:"fixture.peer",kind:"request",body:"NATIVE-AFTER-RESUME",done:false}};
      }
      const noteExact = (payload.messages ?? []).some((m: any) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }])
        .some((part: any) => part.type === "text" && part.text?.includes(resumeNote)));
      requests.push({ delivered, noteExact, queued: messages.includes("QUEUED-991"), noticeN2: messages.includes("<event>EVENT-991-N2</event>"),
 call: calls, tool: use?.name ?? "text", offered: (payload.tools ?? []).map((t: any) => t.name), notice: messages.includes("<task-notification>") });
      const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      emit("message_start", { type: "message_start", message: { id: `msg_${calls}`, type: "message", role: "assistant", model: payload.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: use
        ? { type: "tool_use", id: `fixture_call_${calls}`, name: use.name, input: {} } : { type: "text", text: "" } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: use
        ? { type: "input_json_delta", partial_json: JSON.stringify(use.input) } : { type: "text_delta", text: compactRequest ? "Summary: Monitor is active. Continue with the resume note." : "DONE-991" } });
      emit("content_block_stop", { type: "content_block_stop", index: 0 });
      emit("message_delta", { type: "message_delta", delta: { stop_reason: use ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
      emit("message_stop", { type: "message_stop" }); response.end();
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address(); if (!address || typeof address === "string") throw Error("No provider port");
    const wire = await phoenixLoopback(() => ({ inter_agent_reply_basis: "v1", notice_attribution: "v1", permission_sync: true }),
      (event, payload) => {
        if(event === "envelope" && payload.type === "permission_request") wire.push("permission_decision", {request_id:(payload.payload as any).request_id,allow:true});
        if(event==="envelope" && payload.type==="inter_agent_message")return {ingress_stamp:[1,2]};
        return {};
      });
    const file = join(root, "wrapper.json");
    await writeFile(file, JSON.stringify({ agent_id: "fixture.991", persona: { id: "fixture", name: "Fixture", sprite_set: "fixture" },
      display_name: "Fixture", server_url: wire.url, model: "claude-haiku-4-5-20251001", permission_mode: "default",
      allowed_tools: ["Monitor", "Bash"] }));
    const cli = join(root,"driver.mjs");
    await writeFile(cli, `
      import {runClaudeCli} from ${JSON.stringify(new URL("../dist/cli.js",import.meta.url).href)};
      import {AgentHost} from ${JSON.stringify(new URL("../dist/host.js",import.meta.url).href)};
      const record=(event,data)=>console.error('AUTH_TRACE '+JSON.stringify({event,...data}));
      await runClaudeCli({createHost:(config,options)=>{
        const wrapped={...options,...(process.env.PROBE_SCENARIO==='starved'?{resumeReceiptMaxWaitMs:200}:{})};
        record('mode',{nativeContinuations:options.nativeContinuations});
        const hooks={...options.queryOptions?.hooks};
        hooks.UserPromptSubmit=[...(hooks.UserPromptSubmit??[]),{hooks:[async input=>{record('hook',{input});return {};}]}];
        wrapped.queryOptions={...options.queryOptions,hooks};
        for(const name of ['onTurnStart','onTurnEnd','onPromptAdmitted'])wrapped[name]=(...args)=>{record(name,{args});return options[name]?.(...args);};
        const host=new AgentHost(config,wrapped),resolve=host.resolveToolOrigin.bind(host);
        host.resolveToolOrigin=async id=>{const origin=await resolve(id);record('resolved_origin',{id,token:origin?.token,aborted:origin?.signal?.aborted});return origin;};
        return host;
      }});
    `);
    const child = spawn(process.execPath, [cli, file], { cwd, stdio: ["ignore", "pipe", "pipe"], env: {
      PROBE_SCENARIO:scenario, KAOIRO_CLAUDE_NATIVE_CONTINUATIONS:ownership==="native"?"1":"0", PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: cfg, LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      // Remote feature payloads override the seeded gates; disable fetching while retaining disk reads.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: "1",
    } });
    let output = ""; child.stdout.on("data", chunk => { output += chunk;  }); child.stderr.on("data", chunk => { output += chunk;  });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const wait = async (ready: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (await ready()) return;
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(30);
      }
      throw Error(JSON.stringify({ ownership, scenario, requests, toolResults, output }));
    };
    const results = () => wire.received.filter(item => item.event === "envelope" && item.payload.type === "result");
    const sends = () => wire.received.filter(item => item.event === "envelope" && item.payload.type === "inter_agent_message");
    try {
      await wait(() => wire.joins === 1);
      wire.push("persona_prompt", { version: "0", prompt: "Native fixture. Follow the scripted task, then report. Do not call PushNotification." });
      await wait(() => wire.received.some(item => item.event === "envelope" && item.payload.type === "state_change"));
      const input = (turn: number, body: string) => wire.push("envelope", { version: "0", agent_id: "fixture.peer", persona: { id: "peer", name: "Peer", sprite_set: "peer" },
        display_name: "Peer", ts: "2026-10-20T00:00:00Z", type: "inter_agent_message", state: "thinking", ingress_stamp: [1, turn],
        payload: { to: "fixture.991", conversation_id: "fixture-conversation-991", turn_number: turn, kind: "request", body,
          owner: { kind: "user", id: "fixture-operator" }, new_conversation: false, meta: { done: false, propose_next: "" } }, ext: {} });
      input(1, "START-991");
      await wait(()=>compactSeen);
      if(scenario==="queued") input(2,"QUEUED-991");
      if(scenario==="starved"){
        await wait(()=>output.includes('"reason":"starved"'));
        await wait(()=>wire.received.some(x=>x.event==="envelope" && x.payload.type==="state_change" && x.payload.state==="error"));
        expect(output).not.toContain('"event":"admitted_root"');
        expect(sends()).toHaveLength(0);
        return;
      }
      await wait(()=>issued.length===3 && toolResults.some((r:any)=>r.tool_use_id===issued[2].id));
      await wait(()=>results().length>=(["root","post"].includes(scenario)?3:scenario==="two"?5:4));
      const trace=output.split("\n").filter(l=>l.startsWith("AUTH_TRACE ")).map(l=>JSON.parse(l.slice(11)));
      expect(trace.find(x=>x.event==="mode").nativeContinuations).toBe(ownership==="native");
      const hooks=trace.filter(x=>x.event==="hook" && x.input.hook_event_name==="UserPromptSubmit").map(x=>x.input);
      const noteHook=hooks.find(x=>x.prompt.startsWith("[kaoiro] Compaction has finished."));
      expect(noteHook.prompt).toContain("[kaoiro-resume:");
      expect(noteHook.prompt.endsWith(resumeNote)).toBe(true);
      const noticeHooks=hooks.filter(x=>x.prompt.startsWith("<task-notification>"));
      expect(noticeHooks).toHaveLength(["root","post"].includes(scenario)?0:scenario==="two"?2:1);
      expect(noticeHooks.every(x=>x.prompt_id!==noteHook.prompt_id)).toBe(true);
      expect(output).toContain('"event":"admitted_root"');
      expect(sends()).toHaveLength(2);
      expect(sends()[0]!.payload.payload).toMatchObject({kind:"response",in_reply_to:1});
      expect(sends()[1]!.payload.payload).toMatchObject({kind:"request",in_reply_to:0});
      const receiptEvents=[...output.matchAll(/\[kaoiro\]\[claude-code-receipt\] (\{[^\n]*\})/g)].map(m=>JSON.parse(m[1]!));
      const noteToken=receiptEvents.find(x=>x.event==="admitted_root" && x.prompt_id===noteHook.prompt_id).turn_token;
      if(ownership==="native")expect(trace.filter(x=>x.event==="resolved_origin").every(x=>x.token===noteToken && x.aborted===false)).toBe(true);
      expect(trace.filter(x=>x.event==="onTurnStart" && x.args[0].kind==="sdk_notification")).toHaveLength(ownership==="native" && scenario==="tool"?1:0);
      expect(await readFile(join(cwd,"resumed.txt"),"utf8")).toBe("WORK-RESUMED");
      expect(output).not.toContain("notification result fail-stop");
      expect(requests.some((x:any)=>x.delivered && x.noteExact)).toBe(true);
      if (!["root","post"].includes(scenario)) expect(requests.some((x:any)=>x.notice && !x.delivered)).toBe(true);
      if(scenario==="two"){
        expect(requests.some((x:any)=>x.noticeN2 && !x.delivered)).toBe(true);
        const rows=(await queueRows()).filter(q=>q.operation==="enqueue");
        expect(rows.findIndex(q=>q.content?.includes("<event>EVENT-991-N2</event>"))).toBeGreaterThan(rows.findIndex(q=>q.content?.startsWith("[kaoiro] Compaction")));
      }
      if(scenario==="queued"){
        await wait(()=>requests.some((x:any)=>x.queued) && results().length>=5);
        expect(requests.findIndex((x:any)=>x.queued)).toBeGreaterThan(requests.findIndex((x:any)=>x.delivered));
      }
      if(scenario==="post"){
        taskBarrier!.end("after resume"); taskBarrier=undefined;
        await wait(()=>sends().length===3 && results().length>=4);
        const after=output.split("\n").filter(l=>l.startsWith("AUTH_TRACE ")).map(l=>JSON.parse(l.slice(11)));
        const notification=after.find(x=>x.event==="onTurnStart" && x.args[0].kind==="sdk_notification").args[0].turnToken;
        expect(notification).not.toBe(noteToken);
        expect(after.filter(x=>x.event==="resolved_origin").at(-1)).toMatchObject({token:notification,aborted:false});
        expect(sends()[2]!.payload.payload).toMatchObject({kind:"request",in_reply_to:0,body:"NATIVE-AFTER-RESUME"});
      }
      const before = results().length;
      input(scenario==="queued" ? 5 : 3,"AFTER-991");
      await wait(()=>output.includes("AFTER-991") && results().length > before);
      console.log(JSON.stringify({compact_resume:{ownership,scenario,sdk:sdk.version,cli:sdk.claudeCodeVersion,noteToken,notificationRoots:noticeHooks.length,sends:sends().length}}));

    } finally {
      secondBarrier?.end("cleanup"); taskBarrier?.end("cleanup");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const fallback = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
      fallback.unref(); await closed; clearTimeout(fallback);
      await wire.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 90000,
);
