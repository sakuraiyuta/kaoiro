import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { classifyInterAgentError } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";
import { runClaudeCli } from "../src/cli.js";

describe.skipIf(process.env.KAOIRO_LIVE_CLAUDE !== "1")("native Claude context error", () => {
  it("classifies an SDK-observed preflight block", async () => {
    const root = mkdtempSync(join(tmpdir(), "momo-522-native-"));
    const events: Array<Record<string, unknown>> = [];
    const sent: Envelope[] = [];
    const ends: Array<{ reason?: string; detail?: string }> = [];
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (req.url?.startsWith("/v1/messages") && !req.url.includes("count_tokens")) requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback address");
    const env: Record<string, string> = Object.fromEntries(Object.keys(process.env).map(key => [key, ""]));
    Object.assign(env, { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root,
      ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CONFIG_DIR: join(root, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "32000", CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "10", DISABLE_AUTO_COMPACT: "1" });
    const config: WrapperConfig = { agent_id: "test.native", persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P", server_url: "ws://unused", model: "haiku" };
    let host: AgentHost | undefined;
    let startupError: unknown;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "Reply ok.", resume: undefined }),
      loadConfig: () => config,
      createServerLink: (_url, _id, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("Native regression test"));
        return { deliveryModes: () => undefined, send: (e: Envelope) => sent.push(e), close: () => {},
          currentSessionId: () => null, setSessionId: () => {}, reportSessionLifecycle: () => {},
          acknowledgeInterAgentDelivery: () => {}, flushInterAgentRetirements: async () => {}, reportDisconnectIntent: async () => {} } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, { ...options, queryOptions: { ...options.queryOptions, cwd: root, env },
          onTurnEnd: info => { if (info.error) ends.push(info.error); options.onTurnEnd?.(info); },
          queryFn: args => {
            const real = query(args);
            return new Proxy(real, { get(target, key) {
              if (key === Symbol.asyncIterator) return async function* () {
                for await (const message of target) {
                  if (message.type === "assistant") events.push({ type: message.type, error: message.error });
                  if (message.type === "result") events.push({ type: message.type, subtype: message.subtype, is_error: message.is_error, terminal_reason: message.terminal_reason });
                  yield message;
                }
              };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            } });
          },
        });
        return host;
      },
    });
    void running.catch(error => { startupError = error; });
    try {
      await vi.waitFor(() => { if (startupError !== undefined) throw startupError; expect(ends).toHaveLength(1); }, { timeout: 30_000 });
      expect(requests).toBe(0);
      expect(events).toContainEqual({ type: "assistant", error: "invalid_request" });
      expect(events).toContainEqual({ type: "result", subtype: "success", is_error: true, terminal_reason: "blocking_limit" });
      expect(ends[0]).toEqual({ reason: "prompt_too_long" });
      expect(classifyInterAgentError(ends[0]!).code).toBe("context_overflow");
      expect(sent.find(e => e.type === "result")?.payload).toMatchObject({ error_code: "invalid_request", error_summary: "コンテキストの上限に達しました。" });
    } finally {
      host?.close();
      try { await running; } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
    }
  }, 45_000);
});
