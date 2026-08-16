import { describe, expect, it } from "vitest";
import {
  type InterAgentTool,
  type WrapperConfig,
} from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { buildKaoiroMcpServer } from "../src/inter_agent_sdk.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Claude CLI whoami composition (issue #254)", () => {
  it("actual entrypoint gives whoami the live host rate-limit snapshot", async () => {
    let interAgent!: InterAgentTool;
    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      statusSnapshot: () => ({
        agent_id: config.agent_id,
        persona: config.persona,
        state: "idle" as const,
        rate_limits: {
          seven_day: { utilization: 0.25, resets_at: 1787371200 },
        },
      }),
      run: async () => {},
    };

    await runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: () => host as never,
      buildMcpServer: (actualInterAgent, claudeOnly) => {
        interAgent = actualInterAgent;
        return buildKaoiroMcpServer(actualInterAgent, claudeOnly);
      },
    });

    const result = await interAgent.whoami();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      rate_limits: {
        seven_day: { utilization: 0.25, resets_at: 1787371200 },
      },
    });
  });
});
