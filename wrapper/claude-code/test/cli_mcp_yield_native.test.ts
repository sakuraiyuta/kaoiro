import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { AgentHost } from "../src/host.js";
import { runClaudeCli } from "../src/cli.js";
import { buildKaoiroMcpServer } from "../src/inter_agent_sdk.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const modes = ["running", "permission", "permission-control", "stdio"] as const;
it.each(modes)("retains native root MCP outcomes: %s", async mode => {
  const root = await mkdtemp(join(tmpdir(), "fuji521-native-test-"));
  const requests: any[] = [], callbacks: any[] = [], pushes: string[] = [];
  const barriers: ServerResponse[] = [];
  let released = false, permission: any, outgoing: any, host!: AgentHost;
  let lateEntered = false;
  const provider = createServer(async (req, res) => {
    if (req.url === "/barrier") {
      if (released) res.end("released"); else barriers.push(res);
      return;
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (!req.url?.startsWith("/v1/messages") ||
        req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}");
      return;
    }
    const body = JSON.parse(raw); requests.push(body);
    if (requests.length === 2) await new Promise(r => setTimeout(r, 200));
    if (res.destroyed) return;
    const first = requests.length === 1;
    const names = mode === "stdio" ? ["slow", "late"] : ["send_to_agent"];
    const blocks = first ? names
      .map(name => ({ type: "tool_use", id: `tool521_${name}`,
        name: `mcp__${mode === "stdio" ? "external" : "kaoiro"}__${name}`,
        input: {} })) : [{ type: "text", text: "" }];
    const emit = (event: string, data: any) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    emit("message_start", { type: "message_start", message: {
      id: `msg${requests.length}`, type: "message", role: "assistant",
      model: body.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 } } });
    blocks.forEach((block, index) => {
      emit("content_block_start", { type: "content_block_start", index,
        content_block: block });
      emit("content_block_delta", { type: "content_block_delta", index,
        delta: first ? { type: "input_json_delta", partial_json: JSON.stringify(
          mode === "stdio" ? {} : { to: "receiver", kind: "query", body: "ONCE",
            wait_for_response: true, timeout_ms: 10_000 }) }
          : { type: "text_delta", text: "DONE" } });
      emit("content_block_stop", { type: "content_block_stop", index });
    });
    emit("message_delta", { type: "message_delta", delta: {
      stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 } });
    emit("message_stop", { type: "message_stop" }); res.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const wire = await phoenixLoopback(() => ({ inter_agent_delivery_modes: "v1",
    inter_agent_reply_basis: "v1", work_control: "v1", delivery_policy: "v1",
    inter_agent_delivery_incarnation: "i" }), (event, payload: any) => {
    if (event === "yield_claim") return { granted: true };
    if (event === "envelope" && payload.type === "permission_request") {
      permission = payload.payload;
      const late = mode === "stdio" &&
        permission.tool_name === "mcp__external__late";
      if (late) lateEntered = true;
      if (mode === "running" || (mode === "stdio" && !late))
        wire.push("permission_decision", { request_id: permission.request_id,
          allow: true });
    }
    if (event === "envelope" && payload.type === "inter_agent_message")
      outgoing = payload;
    return {};
  });
  const marker = join(root, "stdio.jsonl");
  const running = runClaudeCli({
    parseCliArgs: () => ({ configPath: "native" }),
    loadConfig: () => ({ agent_id: "sender", display_name: "Sender",
      persona: { id: "p", name: "P", sprite_set: "p" },
      server_url: wire.url, cwd: root,
      model: "claude-haiku-4-5-20251001", in_flight_delivery_enabled: true }),
    createHost: (cfg, options) => {
      host = new AgentHost(cfg, { ...options, queryOptions: {
        ...options.queryOptions, cwd: root, settingSources: [],
        ...(mode === "stdio" ? { mcpServers: {
          ...options.queryOptions?.mcpServers,
          external: { command: process.execPath,
            args: [fileURLToPath(new URL("./fixtures/mcp_yield_stdio.mjs",
              import.meta.url)), marker, `http://127.0.0.1:${port}/barrier`] },
        } } : {}),
        env: { PATH: process.env.PATH, HOME: process.env.HOME,
          TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "config"),
          ANTHROPIC_API_KEY: "loopback-placeholder",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      } });
      const push = host.pushLiveInput.bind(host);
      host.pushLiveInput = args => {
        const result = push(args);
        if (result.kind === "pushed") { pushes.push(args.kind); }
        return result;
      };
      return host;
    },
    buildMcpServer: (...args) => {
      const sdk = buildKaoiroMcpServer(...args);
      const registered = (sdk.instance as any)._registeredTools.send_to_agent;
      const original = registered.handler;
      registered.handler = async (...input: any[]) => {
        const result = await original(...input);
        callbacks.push(result); return result;
      };
      return sdk;
    },
  });
  const inbound = (seq: number, grant: string) => ({ version: "0",
    agent_id: "director", persona: { id: "p", name: "P", sprite_set: "p" },
    ts: "T", type: "inter_agent_message", state: "thinking", delivery_seq: seq,
    payload: { to: "sender", conversation_id: `cid${seq}`, turn_number: 1,
      kind: "request", body: `INPUT521-${seq}`, work: { work_id: "W" },
      delivery_authority: { requested: grant, granted: grant,
        ...(grant === "yield" ? { yield_token: "y", work_id: "W",
          authority_epoch: 1 } : {}) } } });
  const check = (fn: () => void) => vi.waitFor(fn, {
    timeout: 15_000, interval: 20,
  });
  const results = () => requests.flatMap(r => r.messages)
    .flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(b => b.type === "tool_result");
  try {
    await check(() => expect(wire.joins).toBe(1));
    wire.push("delivery_policy", { version: "0", revision: 1, policy: "on" });
    wire.push("persona_prompt", { prompt: "Native loopback measurement." });
    wire.push("envelope", inbound(1, "normal"));
    if (mode === "permission" || mode === "permission-control") {
      await check(() => expect(permission).toBeDefined());
      if (mode === "permission-control") wire.push("permission_decision", {
        request_id: permission.request_id, allow: true });
    }
    if (mode === "stdio") await check(() => expect(barriers.length).toBe(1));
    else if (mode !== "permission")
      await check(() => expect(outgoing).toBeDefined());
    if (mode !== "permission-control")
      wire.push("envelope", inbound(2, "yield"));
    if (mode === "permission") {
      await check(() => expect(results().some(b =>
        JSON.stringify(b).includes("Tool permission request aborted")))
      .toBe(true));
      wire.push("permission_decision", {
        request_id: permission.request_id, allow: true,
      });
      expect(outgoing).toBeUndefined(); expect(callbacks).toEqual([]);
    } else {
      if (mode !== "permission-control") await check(() =>
        expect(wire.received.some(x => x.event === "yield_claim")).toBe(true));
      if (mode === "stdio") {
        released = true; barriers.splice(0).forEach(r => r.end("done"));
      }
      else wire.push("envelope", {
        ...inbound(3, "normal"), agent_id: "receiver",
        payload: { to: "sender",
          conversation_id: outgoing.payload.conversation_id,
          turn_number: 2, kind: "response", body: "REPLY521-COMPLETE" } });
      await check(() => expect(results().some(b => JSON.stringify(b).includes(
        mode === "stdio" ? "STDIO521-COMPLETE" : "REPLY521-COMPLETE")))
      .toBe(true));
      if (mode === "stdio") {
        await check(() => expect(pushes).toContain("cut"));
        const external = (await readFile(marker, "utf8")).trim()
          .split("\n").map(line => JSON.parse(line));
        expect(external.filter(x => x.name === "slow").map(x => x.event))
          .toEqual(["start", "end"]);
        expect(external.some(x => x.name === "late")).toBe(false);
        await check(() => expect(results().some(b =>
          b.tool_use_id === "tool521_late" && b.is_error)).toBe(true));
      } else {
        expect(callbacks).toHaveLength(1);
        expect(JSON.stringify(callbacks[0])).toContain("REPLY521-COMPLETE");
        expect(requests.flatMap(r => r.messages).some(m => m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("REPLY521-COMPLETE")))
          .toBe(false);
        expect(wire.received.filter(x => x.event === "envelope" &&
          x.payload.type === "inter_agent_message")).toHaveLength(1);
      }
    }
    if (mode !== "permission-control")
      await check(() => expect(pushes).toContain("cut"));
  } finally {
    console.log(JSON.stringify({ native_mcp_yield: { mode, paid_calls: 0,
      model: "claude-haiku-4-5-20251001", pushes, lateEntered,
      tool_results: results().map(b => ({ id: b.tool_use_id, error: b.is_error,
        outcome: JSON.stringify(b.content).includes("REPLY521-COMPLETE")
          ? "reply"
          : JSON.stringify(b.content).includes("STDIO521-COMPLETE") ? "stdio"
            : JSON.stringify(b.content).slice(0, 240) })) } }));
    released = true; barriers.splice(0).forEach(r => r.end("cleanup"));
    host?.close(); await running; await wire.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
