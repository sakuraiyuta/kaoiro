// Existing Claude real-process tests substitute a CLI executable. This suite
// uses the bundled CLI itself, so it is opt-in like live_agy_stream_input:
// KAOIRO_LIVE_CLAUDE=1 env -u CODEX_HOME pnpm exec vitest run test/haiku55_native.test.ts
// Only the Messages API response is synthesized; model resolution, catalog,
// effort control and getContextUsage come from the installed SDK/CLI.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";
import { runClaudeCli } from "../src/cli.js";

const levels = ["low", "medium", "high", "xhigh", "max"] as const;
const cases = [
  { model: "haiku", canonical: "claude-haiku-5-5", capacity: 1_000_000, disable1m: false, effort: undefined },
  { model: "claude-haiku-5-5", canonical: "claude-haiku-5-5", capacity: 1_000_000, disable1m: false, effort: "high" as const },
  { model: "haiku", canonical: "claude-haiku-5-5", capacity: 200_000, disable1m: true, effort: undefined },
  { model: "claude-haiku-4-5-20251001", canonical: "claude-haiku-4-5-20251001", capacity: 200_000, disable1m: false, effort: undefined },
];
interface CapturedRequest {
  model: string;
  max_tokens: number;
  thinking?: { type: string };
  output_config?: { effort?: string };
}

describe.skipIf(process.env.KAOIRO_LIVE_CLAUDE !== "1")("Haiku via the installed native SDK/CLI", () => {
  it.each(cases)("retains $model (disable1m=$disable1m, effort=$effort) and projects $capacity", async scenario => {
    const root = mkdtempSync(join(tmpdir(), "niko-haiku55-native-"));
    const requests: CapturedRequest[] = [];
    const sent: Envelope[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(request.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}");
          return;
        }
        const payload = JSON.parse(body) as CapturedRequest;
        requests.push({
          model: payload.model, max_tokens: payload.max_tokens,
          ...(payload.thinking === undefined ? {} : { thinking: payload.thinking }),
          ...(payload.output_config === undefined ? {} : { output_config: payload.output_config }),
        });
        const emit = (event: string, data: unknown): void => {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        emit("message_start", { type: "message_start", message: {
          id: "msg_native_test", type: "message", role: "assistant", model: payload.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        } });
        emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
        emit("content_block_stop", { type: "content_block_stop", index: 0 });
        emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
        emit("message_stop", { type: "message_stop" });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing loopback address");
    const env: Record<string, string> = Object.fromEntries(Object.keys(process.env).map(key => [key, ""]));
    Object.assign(env, {
      PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root,
      ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CONFIG_DIR: join(root, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: scenario.disable1m ? "1" : "",
    });
    const config: WrapperConfig = {
      agent_id: "test.haiku55.native",
      persona: { id: "p", name: "Native", sprite_set: "p" },
      display_name: "Native", server_url: "ws://unused",
      model: scenario.model,
      ...(scenario.effort === undefined ? {} : { effort: scenario.effort }),
    };
    let host: AgentHost | undefined;
    let startupError: unknown;
    const running = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "Reply ok.", resume: undefined }),
      loadConfig: () => config,
      createServerLink: (_url, _id, options) => {
        queueMicrotask(() => {
          options.onPersonaPrompt?.("Native model regression test");
          options.onInterAgentDeliveryStatus?.({ issued_seq: 0, acked_seq: 0 });
        });
        return {
          send: (envelope: Envelope) => { sent.push(envelope); },
          close: () => {}, currentSessionId: () => null, setSessionId: () => {},
          reportSessionLifecycle: () => {}, acknowledgeInterAgentDelivery: () => {},
          flushInterAgentRetirements: async () => {}, reportDisconnectIntent: async () => {},
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          queryOptions: { ...options.queryOptions, cwd: root, env },
        });
        return host;
      },
    });
    void running.catch(error => { startupError = error; });
    try {
      await vi.waitFor(() => {
        if (startupError !== undefined) throw startupError;
        expect(sent.some(envelope => envelope.type === "result")).toBe(true);
        expect(host?.statusExtSnapshot().context).toBeDefined();
        expect((host?.statusExtSnapshot().models as unknown[] | undefined)?.length).toBeGreaterThan(1);
      }, { timeout: 30_000 });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(request => request.model === scenario.canonical)).toBe(true);
      const legacy = scenario.canonical === "claude-haiku-4-5-20251001";
      expect(requests[0]).toMatchObject(legacy
        ? { max_tokens: 32_000, thinking: { type: "enabled" } }
        : { max_tokens: 128_000, thinking: { type: "adaptive" }, output_config: { effort: scenario.effort ?? "medium" } });
      expect(host!.statusExtSnapshot()).toMatchObject({
        model: scenario.model, model_source: "config",
        effective: { model: scenario.model, model_source: "config" },
        context: { max_tokens: scenario.capacity },
        session_capabilities: { supports_effort_switch: !legacy },
      });
      expect(host!.statusExtSnapshot()).not.toHaveProperty("engine_fallback_model");
      const effortResults = [];
      for (const level of levels) {
        if (legacy) {
          await expect(host!.setEffort(level)).rejects.toThrow("effort_level_unsupported");
        } else {
          await expect(host!.setEffort(level)).resolves.toBeUndefined();
          expect(host!.statusExtSnapshot().effort).toBe(level);
        }
        effortResults.push({ level, accepted: !legacy });
      }
      console.log(JSON.stringify({ native_sdk_capture: {
        model: scenario.model, disable1m: scenario.disable1m, requests,
        context: host!.statusExtSnapshot().context, effortResults,
      } }));
    } finally {
      host?.close();
      try { await running; } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 45_000);
});
