import { describe, expect, it } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Codex CLI whoami composition (issue #254)", () => {
  it("actual entrypoint gives whoami the live host rate-limit snapshot", async () => {
    let hostOptions!: Record<string, unknown>;
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

    await runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, unknown>;
        return host as never;
      },
      prepareStartup: async () => {},
    });

    const whoami = (hostOptions.toolDescriptors as ToolDescriptor[]).find(
      (descriptor) => descriptor.name === "whoami",
    );
    expect(whoami).toBeDefined();
    expect(whoami!.handler).toBeTypeOf("function");
    const result = await whoami!.handler!({});
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      rate_limits: {
        seven_day: { utilization: 0.25, resets_at: 1787371200 },
      },
    });
  });
});
