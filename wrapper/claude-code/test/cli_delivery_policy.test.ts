import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";
import { runClaudeCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";
import { NATIVE_CONTINUATIONS_ENV } from "../src/native_continuations_setting.js";

// The fake SDK here writes no native transcript, so these compositions
// select the legacy admission mode explicitly (native is the default).
beforeEach(() => { vi.stubEnv(NATIVE_CONTINUATIONS_ENV, "0"); });
afterEach(() => { vi.unstubAllEnvs(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(["already off", "claim in flight"] as const)("keeps one ordinary yield root when policy is %s and on does not re-promote it", async boundary => {
  const ready = deferred(), endRoot = deferred(), rootReceived = deferred();
  const config: WrapperConfig = { agent_id: "policy-claude", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P", server_url: "unused" };
  let claimCalls = 0, host!: AgentHost;
  const inputs: string[] = [];
  const wire = await phoenixLoopback(() => ({ inter_agent_delivery_modes: "v1", inter_agent_delivery_incarnation: "i",
    work_control: "v1", delivery_policy: "v1" }), event => {
    if (event === "yield_claim") {
      claimCalls++;
      wire.push("delivery_policy", { version: "0", revision: 2, policy: "off" });
      return { granted: true };
    }
    return {};
  });
  const signals = process.listeners("SIGINT");
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config, server_url: wire.url }),
    createHost: (cfg, options) => {
      host = new AgentHost(cfg, { ...options,
        queryFn: ((args: { prompt: AsyncIterable<SDKUserMessage>; options: any }) => Object.assign((async function* () {
          const input = args.prompt[Symbol.asyncIterator]();
          const hook = args.options.hooks.UserPromptSubmit.at(-1).hooks[0];
          const signal = { signal: new AbortController().signal };
          const prompt = async (id: string, text: string) => hook({ hook_event_name: "UserPromptSubmit", session_id: "s",
            prompt_id: id, prompt: text }, undefined, signal);
          const root = (await input.next()).value!;
          await prompt("root", root.message.content as string);
          yield { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
          ready.resolve(); await endRoot.promise;
          yield { type: "result", session_id: "s", result_index: 0, subtype: "success", result: "BASE done" } as SDKMessage;
          const next = (await input.next()).value!;
          inputs.push(next.message.content as string);
          await prompt("next", next.message.content as string);
          yield { type: "result", session_id: "s", result_index: 1, subtype: "success", result: "ROOT done" } as SDKMessage;
          rootReceived.resolve();
        })(), { interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query) as never });
      host.probeRateLimits = async () => {};
      return host;
    },
  });
  const inbound = (seq: number, body: string, grant: "normal" | "yield"): Envelope => ({
    version: "0", agent_id: "peer", persona: { id: "peer", name: "Peer", sprite_set: "peer" }, display_name: "Peer",
    ts: "T", type: "inter_agent_message", state: "thinking", delivery_seq: seq,
    payload: { to: config.agent_id, conversation_id: `cid-${seq}`, turn_number: 1, kind: "inform", body,
      work: { work_id: "W" }, delivery_authority: { requested: grant, granted: grant,
        ...(grant === "yield" ? { yield_token: "token", work_id: "W", authority_epoch: 1 } : {}) } },
  } as unknown as Envelope);
  const acks = () => wire.received.filter(item => item.event === "delivery_policy_applied");
  try {
    await vi.waitFor(() => expect(wire.joins).toBe(1));
    wire.push("delivery_policy", { version: "0", revision: 1, policy: "on" });
    wire.push("persona_prompt", { version: "0", prompt: "system" });
    await vi.waitFor(() => expect(acks()).toHaveLength(1));
    wire.push("envelope", inbound(1, "BASE", "normal") as unknown as Record<string, unknown>);
    await ready.promise;
    if (boundary === "already off") {
      wire.push("delivery_policy", { version: "0", revision: 2, policy: "off" });
      await vi.waitFor(() => expect(acks()).toHaveLength(2));
    }
    wire.push("envelope", inbound(2, "OFF ROOT", "yield") as unknown as Record<string, unknown>);
    const stages = () => wire.received.filter(item => item.event === "delivery_stage" && item.payload.delivery_seq === 2).map(item => item.payload);
    await vi.waitFor(() => expect(stages().filter(stage => stage.reason === "local_policy_disabled")).toHaveLength(1));
    expect(claimCalls).toBe(boundary === "already off" ? 0 : 1);
    expect(host.hasPendingPushedReceipt()).toBe(false);
    expect(wire.received.filter(item => item.event === "delivery_ack").at(-1)?.payload.delivery_seq).toBe(1);
    wire.push("delivery_policy", { version: "0", revision: 3, policy: "on" });
    await vi.waitFor(() => expect(acks()).toHaveLength(3));
    endRoot.resolve(); await rootReceived.promise;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("OFF ROOT");
    expect(inputs[0]).not.toContain("fold_id:");
    await vi.waitFor(() => expect(stages().filter(stage => stage.stage === "submitted")).toHaveLength(1));
    expect(stages().find(stage => stage.stage === "submitted")).toMatchObject({ mode: "normal", handoff: "prompt_hook" });
    expect(stages().filter(stage => stage.yield_disposition)).toHaveLength(1);
  } finally {
    endRoot.resolve(); host?.close(); await running; await wire.close();
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
  }
}, 10_000);

it.each(["ceiling false", "absent", "legacy false", "excluding list", "stored off"] as const)("orders queued peer and operator roots with %s", async mode => {
  for(const key of ["KAOIRO_CLAUDE_PHASE2_DELIVERY","KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS"])vi.stubEnv(key,undefined);
  if(mode==="legacy false")vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY","0");
  if(mode==="excluding list")vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS","other");
  const ready=deferred(),release=deferred(),order:string[]=[];
  let sent!: { mock: { calls: readonly unknown[][] } };
  const wire=await phoenixLoopback(()=>({delivery_policy:"v1",inter_agent_delivery_modes:"v1",inter_agent_reply_basis:"v1"}));
  const signals=process.listeners("SIGINT");
  const running=runClaudeCli({
    parseCliArgs:()=>({configPath:"test",prompt:undefined,resume:undefined}),
    loadConfig:()=>({agent_id:"ordering",persona:{id:"P",name:"P",sprite_set:"P"},display_name:"P",server_url:wire.url,in_flight_delivery_enabled:mode!=="ceiling false",...(mode==="legacy false"?{phase2_delivery:false}:{})}),
    createHost:(config,options)=>{
      const host=new AgentHost(config,{...options,queryFn:((args:{prompt:AsyncIterable<SDKUserMessage>;options:any})=>Object.assign((async function*(){
        const input=args.prompt[Symbol.asyncIterator]();
        const hook=args.options.hooks.UserPromptSubmit.at(-1).hooks[0];
        const root=(await input.next()).value!;
        await hook({hook_event_name:"UserPromptSubmit",session_id:"ordering",prompt_id:"base",prompt:root.message.content},undefined,{signal:new AbortController().signal});
        yield {type:"system",subtype:"init",session_id:"ordering"} as SDKMessage;
        ready.resolve();await release.promise;
        yield {type:"result",session_id:"ordering",result_index:0,subtype:"success",result:"base done"} as SDKMessage;
        for(let i=1;i<=2;i++){
          const text=(await input.next()).value!.message.content as string;
          order.push(text.includes("OPERATOR-ROOT")?"operator":"peer");
          await hook({hook_event_name:"UserPromptSubmit",session_id:"ordering",prompt_id:`root-${i}`,prompt:text},undefined,{signal:new AbortController().signal});
          yield {type:"result",session_id:"ordering",result_index:i,subtype:"success",result:"done"} as SDKMessage;
        }
      })(),{interrupt:async()=>{},supportedModels:async()=>[]})as unknown as Query)as never});
      host.probeRateLimits=async()=>{};sent=vi.spyOn(host,"send");return host;
    },
  });
  try{
    await vi.waitFor(()=>expect(wire.joins).toBe(1));
    wire.push("delivery_policy",{version:"0",revision:1,policy:mode==="stored off"?"off":"on"});
    wire.push("persona_prompt",{version:"0",prompt:"Ordering"});
    await vi.waitFor(()=>expect(wire.received.some(x=>x.event==="envelope" && x.payload.type==="state_change")).toBe(true));
    wire.push("instruction",{version:"0",text:"BASE",delivery_intent:"normal"});await ready.promise;
    wire.push("envelope",{version:"0",agent_id:"peer",persona:{id:"peer",name:"Peer",sprite_set:"peer"},ts:"T",type:"inter_agent_message",state:"thinking",payload:{to:"ordering",conversation_id:"order",turn_number:1,kind:"inform",body:"PEER-ROOT",delivery_authority:{requested:"normal",granted:"normal"}}});
    await vi.waitFor(()=>expect(sent.mock.calls.some(call=>String(call[0]).includes("PEER-ROOT"))).toBe(true));
    wire.push("instruction",{version:"0",text:"OPERATOR-ROOT",delivery_intent:"normal"});
    await vi.waitFor(()=>expect(sent.mock.calls.some(call=>String(call[0]).includes("OPERATOR-ROOT"))).toBe(true));
    release.resolve();await vi.waitFor(()=>expect(order).toHaveLength(2));
    expect(order).toEqual(mode==="ceiling false"?["peer","operator"]:["operator","peer"]);
  }finally{
    release.resolve();for(const listener of process.listeners("SIGINT"))if(!signals.includes(listener))listener("SIGINT");
    await running;await wire.close();
  }
});
