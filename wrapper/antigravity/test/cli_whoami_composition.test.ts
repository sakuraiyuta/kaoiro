import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor, WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, type AntigravityHostOptions, type SpawnedAgy } from "../src/host.js";
import { createHarnessHost } from "./host_test_harness.js";
import { runAntigravityCli } from "../src/cli.js";
import { ToolHost } from "../src/toolhost.js";

class FakeAgy extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killed: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal;
    return true;
  }

  finish(): void {
    this.stdout.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

async function callWhoami(toolHost: ToolHost): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(toolHost.socketPath);
    let buffer = "";
    socket.once("error", reject);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, nonce: toolHost.nonce, method: "call_tool", name: "whoami", input: {} })}\n`);
    });
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const response = JSON.parse(buffer.slice(0, newline)) as {
        result?: { content?: { text?: string }[] };
        error?: unknown;
      };
      socket.end();
      if (response.error) {
        reject(new Error(JSON.stringify(response.error)));
        return;
      }
      const text = response.result?.content?.[0]?.text;
      if (!text) {
        reject(new Error("No text content in whoami response"));
        return;
      }
      resolve(JSON.parse(text) as Record<string, unknown>);
    });
  });
}

describe("Antigravity CLI whoami composition (issue #418)", () => {
  it("reports session_id via whoami tool only after init event is received", async () => {
    const config: WrapperConfig = {
      agent_id: "test.agent",
      persona: { id: "momo", name: "Momo", sprite_set: "momo" },
      display_name: "Momo",
      server_url: "ws://localhost:4000",
    };
    let hostOptions!: AntigravityHostOptions;
    let actualHost!: AntigravityHost;
    let hostResolve!: () => void;
    const hostReady = new Promise<void>((resolve) => {
      hostResolve = resolve;
    });
    const calls: { child: FakeAgy }[] = [];
    const link = {
      close: () => {},
      send: () => {},
      setSessionId: () => {},
      reportDisconnectIntent: async () => true,
    };

    const cliPromise = runAntigravityCli({
      parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
      loadConfig: () => config,
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (cfg, options) => {
        hostOptions = options;
        actualHost = createHarnessHost(cfg, {
          ...options,
          verifyGate: async () => true,
          runtimeAssetsAvailable: () => true,
          agyPath: "/test/agy",
          spawn: () => {
            const child = new FakeAgy();
            calls.push({ child });
            return child as unknown as SpawnedAgy;
          },
        });
        hostResolve();
        return actualHost;
      },
    });

    await hostReady;
    const toolHost = await ToolHost.listen(hostOptions.toolDescriptors as ToolDescriptor[]);

    try {
      // Negative control: before the first init event, session_id key is absent
      const beforeInit = await callWhoami(toolHost);
      expect(beforeInit).not.toHaveProperty("session_id");

      // Deliver turn input and emit the first init event with conversation_id
      const sendPromise = actualHost.send("hello");
      await vi.waitFor(() => expect(calls.length).toBe(1));
      const call = calls[0]!;
      call.child.stdout.write('{"event":"init","conversation_id":"cid-issue-418","init":{"tools":[]}}\n');
      call.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      call.child.finish();
      await sendPromise;

      // Positive check: after init event, session_id matches the conversation id
      const afterInit = await callWhoami(toolHost);
      expect(afterInit).toMatchObject({
        session_id: "cid-issue-418",
      });
    } finally {
      toolHost.close();
      actualHost.close();
      await cliPromise;
    }
  });
});
