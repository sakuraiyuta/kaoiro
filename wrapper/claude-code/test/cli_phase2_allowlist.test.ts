import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "ao", name: "Ao", sprite_set: "ao" },
  display_name: "Ao",
  server_url: "ws://localhost:4000/wrapper",
};

it.each([
  { name: "matching trimmed id", flag: undefined, personas: "other, ao ,third", source: "policy" },
  { name: "different id", flag: undefined, personas: "aoi,other", source: "policy" },
  { name: "different case", flag: undefined, personas: "Ao", source: "policy" },
  { name: "empty list", flag: undefined, personas: "  ", source: "policy" },
  { name: "empty item", flag: undefined, personas: "ao,,other", source: "policy" },
  { name: "glob item", flag: undefined, personas: "ao,*", source: "policy" },
  { name: "non-enabling flag", flag: "true", personas: undefined, source: "policy" },
  { name: "list with non-enabling flag", flag: "true", personas: "ao", source: "policy" },
  { name: "global flag", flag: "1", personas: "other", source: "policy" },
] as const)("advertises Claude phase 2 for $name", async ({ flag, personas, source }) => {
  vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY", flag);
  vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS", personas);
  vi.stubEnv("KAOIRO_TEST_UNRELATED_SECRET", "unrelated-env-value");
  const writes: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    writes.push(String(chunk));
    return true;
  });
  let modes: unknown;
  try {
    await runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        modes = options.interAgentDeliveryModes;
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return { deliveryModes: () => undefined, close: () => {}, currentSessionId: () => null, send: () => {} } as never;
      },
      createHost: () => ({ canPushLiveInput: () => false, canFoldLiveInput: () => false, state: "idle", statusExtSnapshot: () => ({}), run: async () => {} }) as never,
    });
    expect(modes).toEqual({
      version: "v1",
      early: "fold",
      yield: "tool_boundary",
      stage_reports: true,
    });
    const sourceLogs = writes.filter(line => line.startsWith("[claude phase2 delivery] "));
    expect(sourceLogs).toEqual([`[claude phase2 delivery] source=${source}\n`]);
    expect(sourceLogs[0]).not.toContain("unrelated-env-value");
    expect(sourceLogs[0]).not.toContain(personas ?? "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS");
    const warnings = writes.filter(line => line.startsWith("claude: warn - "));
    expect(warnings).toHaveLength(Number(Boolean(flag)) + Number(Boolean(personas)));
    expect(warnings.join("")).toContain("is retired and has no effect");
    expect(warnings.join("")).not.toContain("unrelated-env-value");
  } finally {
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.each([undefined,false,true] as const)("warns for a direct wrapper legacy file key %s without gating",async fileKey=>{
  vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY",undefined);vi.stubEnv("KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS",undefined);
  const writes:string[]=[];const stderr=vi.spyOn(process.stderr,"write").mockImplementation(chunk=>{writes.push(String(chunk));return true;});
  let modes:unknown;
  try{
    await runClaudeCli({parseCliArgs:()=>({configPath:"test",prompt:undefined,resume:undefined}),
      loadConfig:()=>({...config,...(fileKey===undefined?{}:{phase2_delivery:fileKey})}),
      createServerLink:(_url,_id,options)=>{modes=options.interAgentDeliveryModes;queueMicrotask(()=>options.onPersonaPrompt?.("system"));return{deliveryModes:()=>undefined,currentSessionId:()=>null,send(){},close(){}}as never;},
      createHost:()=>({state:"idle",statusExtSnapshot:()=>({}),run:async()=>{}})as never});
    expect(modes).toMatchObject({early:"fold",yield:"tool_boundary"});
    const warnings=writes.filter(x=>x.startsWith("claude: warn - "));
    expect(warnings).toHaveLength(fileKey===undefined?0:1);
    if(fileKey!==undefined){expect(warnings[0]).toContain("phase2_delivery in the wrapper config");expect(warnings[0]).toContain("in_flight_delivery_enabled");}
  }finally{stderr.mockRestore();vi.unstubAllEnvs();}
});
