import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Codex CLI session-reset composition (issue #246)", () => {
  it("実際の entrypoint は tool を列挙し、turn 境界で reset を要求する", async () => {
    let linkOptions!: Record<string, any>;
    let hostOptions!: Record<string, any>;
    const requests: { mode: string; reason?: string }[] = [];
    const sent: string[] = [];
    const link = {
      close: () => {},
      currentSessionId: () => null,
      requestSessionReset: async (mode: string, reason?: string) => {
        requests.push({ mode, ...(reason === undefined ? {} : { reason }) });
        return { requestId: "reset-1" };
      },
      send: () => {},
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
      run: async () => {},
      send: async (text: string) => {
        sent.push(text);
      },
    };

    await runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => {
          (linkOptions.onPersonaPrompt as (prompt: string) => void)("system prompt");
        });
        return link as never;
      },
      createHost: (_config, options) => {
        hostOptions = options as unknown as Record<string, any>;
        return host as never;
      },
      prepareStartup: async () => {},
    });

    const reset = (hostOptions.toolDescriptors as ToolDescriptor[]).find(
      (descriptor) => descriptor.name === "request_session_reset",
    );
    expect(reset).toBeDefined();
    expect(linkOptions.onSessionResetFailed).toBeTypeOf("function");

    await reset!.handler({ mode: "clear", reason: "start clean" });
    expect(requests).toEqual([]);
    hostOptions.onTurnEnd({ turnToken: "turn-1", conversationIds: [] });
    await vi.waitFor(() =>
      expect(requests).toEqual([{ mode: "clear", reason: "start clean" }]),
    );

    linkOptions.onSessionResetFailed({ requestId: "reset-1", reason: "runner_unavailable" });
    await vi.waitFor(() =>
      expect(sent.some((text) => text.includes("was not carried out"))).toBe(true),
    );
  });
});
