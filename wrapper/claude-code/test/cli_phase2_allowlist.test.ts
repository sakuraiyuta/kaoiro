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
  { name: "matching trimmed id", flag: undefined, personas: "other, ao ,third", source: "persona_list" },
  { name: "different id", flag: undefined, personas: "aoi,other", source: "off" },
  { name: "different case", flag: undefined, personas: "Ao", source: "off" },
  { name: "empty list", flag: undefined, personas: "  ", source: "off" },
  { name: "empty item", flag: undefined, personas: "ao,,other", source: "off" },
  { name: "glob item", flag: undefined, personas: "ao,*", source: "off" },
  { name: "non-enabling flag", flag: "true", personas: undefined, source: "off" },
  { name: "list with non-enabling flag", flag: "true", personas: "ao", source: "persona_list" },
  { name: "global flag", flag: "1", personas: "other", source: "flag" },
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
        return { close: () => {}, currentSessionId: () => null, send: () => {} } as never;
      },
      createHost: () => ({ state: "idle", statusExtSnapshot: () => ({}), run: async () => {} }) as never,
    });
    expect(modes).toEqual({
      version: "v1",
      early: source === "off" ? "none" : "fold",
      yield: source === "off" ? "none" : "tool_boundary",
      stage_reports: true,
    });
    const sourceLogs = writes.filter(line => line.startsWith("[claude phase2 delivery] "));
    expect(sourceLogs).toEqual([`[claude phase2 delivery] source=${source}\n`]);
    expect(sourceLogs[0]).not.toContain("unrelated-env-value");
    expect(sourceLogs[0]).not.toContain(personas ?? "KAOIRO_CLAUDE_PHASE2_DELIVERY_PERSONAS");
  } finally {
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});
