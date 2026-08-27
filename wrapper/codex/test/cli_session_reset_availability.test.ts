import { describe, expect, it } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Codex CLI session-reset availability (issue #246)", () => {
  it("ADR-0043 に従い request_session_reset を公開しない", async () => {
    let hostOptions!: Record<string, unknown>;
    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
    };
    const host = {
      state: "idle",
      statusExtSnapshot: () => ({}),
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

    const descriptors = hostOptions.toolDescriptors as ToolDescriptor[];
    // ADR-0043: codex exec has no per-request approval path for this heavy action.
    expect(descriptors.map((descriptor) => descriptor.name)).not.toContain(
      "request_session_reset",
    );
    expect(descriptors.map((descriptor) => descriptor.name)).toContain("ask_user_question");
  });
});
