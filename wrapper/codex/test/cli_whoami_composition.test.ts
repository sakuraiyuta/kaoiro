import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { ToolHost } from "../src/toolhost.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("Codex CLI whoami composition (issue #254)", () => {
  it("actual entrypoint gives whoami the live host rate-limit snapshot", async () => {
    let hostOptions!: Record<string, unknown>;
    const buildArtifact = JSON.parse(readFileSync(
      fileURLToPath(new URL("../dist/build-info.json", import.meta.url)), "utf8",
    )) as { revision: string; dirty: boolean; version: string; channel: "dev" | "release" };
    const disconnectReasons: string[] = [];
    const link = {
      close: () => {},
      currentSessionId: () => null,
      send: () => {},
      reportDisconnectIntent: async (reason: string) => {
        disconnectReasons.push(reason);
        return true;
      },
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

    const toolHost = await ToolHost.listen(hostOptions.toolDescriptors as ToolDescriptor[]);
    try {
      const result = await new Promise<{ content: { text: string }[] }>((resolve, reject) => {
        const socket = createConnection(toolHost.socketPath);
        let buffer = "";
        socket.once("error", reject);
        socket.on("connect", () => {
          socket.write(`${JSON.stringify({ id: 1, method: "call_tool", name: "whoami", input: {} })}\n`);
        });
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const response = JSON.parse(buffer.slice(0, newline)) as { result: { content: { text: string }[] } };
          socket.end();
          resolve(response.result);
        });
      });
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      build: {
        revision: buildArtifact.revision,
        dirty: buildArtifact.dirty,
        version: buildArtifact.version,
        channel: buildArtifact.channel,
      },
      rate_limits: {
        seven_day: { utilization: 0.25, resets_at: 1787371200 },
      },
      });
    } finally {
      toolHost.close();
    }
    expect(disconnectReasons).toEqual(["stop"]);
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

    await runCodexCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ ...config }),
      loadWrapperBuildInfo: () => buildInfo,
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, unknown>;
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: () => host as never,
      prepareStartup: async () => {},
    });

    expect(linkOptions.buildInfo).toEqual(buildInfo);
  });
});
