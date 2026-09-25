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
  it("announces fresh idle before starting the optional account probe", async () => {
    const order: string[] = [];
    const link = {
      close: () => {}, currentSessionId: () => null,
      send: (event: { type: string; ext?: Record<string, unknown> }) => {
        if (event.type === "state_change") {
          order.push("idle");
          expect(event.ext).not.toHaveProperty("rate_limits");
        }
      },
    };
    const host = {
      state: "idle", statusExtSnapshot: () => ({}),
      statusSnapshot: () => ({ agent_id: config.agent_id, persona: config.persona, state: "idle" as const }),
      probeRateLimits: () => { order.push("probe"); return Promise.resolve(); },
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
    });
    expect(order).toEqual(["idle", "probe"]);
  });

  it("starts the isolated account probe during a resumed idle", async () => {
    const order: string[] = [];
    const host = {
      state: "idle", statusExtSnapshot: () => ({}),
      statusSnapshot: () => ({ agent_id: config.agent_id, persona: config.persona, state: "idle" as const }),
      probeRateLimits: () => { order.push("probe"); return Promise.resolve(); },
      run: async () => {},
    };
    await runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: "resume-session" }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return { close: () => {}, currentSessionId: () => null,
          send: () => order.push("idle"),
          setSessionId: (id: string) => order.push(`bind:${id}`),
        } as never;
      },
      createHost: () => host as never,
    });
    expect(order).toEqual(["idle", "probe", "bind:resume-session"]);
  });

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

  it("actual composition passes the loaded build identity to ServerLink", async () => {
    let linkOptions!: Record<string, unknown>;
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
      }),
      run: async () => {},
    };
    const buildInfo = {
      revision: "0123456789012345678901234567890123456789",
      dirty: false,
      version: "2026.9.0",
      channel: "release" as const,
    };

    await runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, unknown>;
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: () => host as never,
    });

    expect(linkOptions.buildInfo).toEqual(buildInfo);
  });
});
