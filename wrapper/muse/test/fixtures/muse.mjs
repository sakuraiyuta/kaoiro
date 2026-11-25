#!/usr/bin/env node
// A fake `muse acp` agent for the muse adapter tests: plain ACP over stdio,
// no vendor extensions. It answers initialize / session/new / session/resume,
// echoes prompts, can ask for permission, can sleep until cancelled, and
// connects to the kaoiro MCP server it is handed (listing its tools into
// KAOIRO_TEST_MUSE_TOOLS_FILE when that is set).
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const sid = "fixture-session";
let model = "muse-spark-1.3";
let effort = "high";
let mode = "allow-all";
const MODES = [
  { id: "allow-all", name: "Allow all" },
  { id: "ask-unmatched", name: "Ask before unmatched actions" },
  { id: "deny-unmatched", name: "Deny unmatched actions" },
];
const modes = () => ({ currentModeId: mode, availableModes: MODES });
let promptCount = 0;
const MODELS = [
  { value: "muse-spark-1.3", name: "Muse Spark 1.3" },
  { value: "muse-wonder", name: "Muse Wonder" },
];
const EFFORTS = [
  { value: "low", name: "low" },
  { value: "high", name: "high" },
];
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: MODELS },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: effort, options: EFFORTS },
];
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }) + "\n");
const notification = (method, params) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const update = (data) => notification("session/update", { sessionId: sid, update: data });
const textChunk = (text) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const waiters = new Map();
const awaitResponse = (id) => new Promise((resolve) => waiters.set(id, resolve));
let sleepingPrompt;
let mcpClient;
let connecting = Promise.resolve();

async function connectMcp(servers) {
  if (process.env.KAOIRO_TEST_MUSE_NO_MCP) return;
  const mcp = servers?.[0];
  if (!mcp || mcp.type !== "http") return;
  const headers = Object.fromEntries((mcp.headers ?? []).map((h) => [h.name, h.value]));
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers },
  });
  mcpClient = new Client({ name: "muse-fixture", version: "0" });
  connecting = (async () => {
    await mcpClient.connect(transport);
    const tools = await mcpClient.listTools();
    if (process.env.KAOIRO_TEST_MUSE_TOOLS_FILE) {
      writeFileSync(
        process.env.KAOIRO_TEST_MUSE_TOOLS_FILE,
        JSON.stringify(tools.tools.map((t) => t.name)),
      );
    }
  })().catch(() => {});
  // Not awaited by the caller: like the real agent, the fixture connects
  // its MCP servers asynchronously and the session opens first; a prompt
  // that needs a tool awaits `connecting` itself.
}

function finish(id, text, stopReason = "end_turn") {
  if (text) textChunk(text);
  reply(id, { stopReason });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const msg = JSON.parse(line);
    if (msg.method === undefined && waiters.has(msg.id)) {
      const resolve = waiters.get(msg.id);
      waiters.delete(msg.id);
      resolve(msg);
      return;
    }
    switch (msg.method) {
      case "initialize":
        if (process.env.KAOIRO_TEST_MUSE_HANG_INIT) break;
        reply(msg.id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: false },
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
          authMethods: [],
        });
        break;
      case "session/new":
        void connectMcp(msg.params.mcpServers);
        reply(msg.id, { sessionId: sid, configOptions: configOptions(), modes: modes() });
        break;
      case "session/resume":
        if (msg.params.sessionId !== sid) return fail(msg.id, "unknown session");
        void connectMcp(msg.params.mcpServers);
        reply(msg.id, { configOptions: configOptions(), modes: modes() });
        break;
      case "session/set_mode":
        if (!MODES.some((m) => m.id === msg.params.modeId)) {
          return fail(msg.id, "unknown mode");
        }
        mode = msg.params.modeId;
        reply(msg.id, {});
        update({ sessionUpdate: "current_mode_update", currentModeId: mode });
        break;
      case "session/load":
        reply(msg.id, { configOptions: configOptions() });
        break;
      case "session/set_config_option": {
        const { configId, value } = msg.params;
        if (configId === "model" && MODELS.some((m) => m.value === value)) model = value;
        else if (configId === "effort" && EFFORTS.some((e) => e.value === value)) effort = value;
        else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
            error: { code: -32602, message: "Invalid params" } }) + "\n");
          break;
        }
        reply(msg.id, { configOptions: configOptions() });
        update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
        break;
      }
      case "session/prompt": {
        const text = msg.params.prompt[0].text;
        promptCount += 1;
        if (process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE) {
          const { appendFileSync } = await import("node:fs");
          appendFileSync(
            process.env.KAOIRO_TEST_MUSE_PROMPTS_FILE,
            JSON.stringify(text) + "\n",
          );
        }
        if (process.env.KAOIRO_TEST_MUSE_FAIL_FIRST_PROMPT && promptCount === 1) {
          return fail(msg.id, "fixture first prompt failure");
        }
        const lastLine = text.split("\n").pop();
        if (lastLine === "sleep") {
          sleepingPrompt = msg.id;
          update({ sessionUpdate: "tool_call", toolCallId: "long", title: "sleep",
            status: "in_progress", kind: "execute" });
          break;
        }
        if (lastLine === "fail") return fail(msg.id, "fixture turn failure");
        if (lastLine === "permission") {
          update({ sessionUpdate: "tool_call", toolCallId: "perm-tool", title: "write fixture",
            status: "in_progress", kind: "edit" });
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "perm-1",
            method: "session/request_permission", params: { sessionId: sid,
              toolCall: { toolCallId: "perm-tool", title: "write fixture", rawInput: { path: "x" } },
              options: [
                { optionId: "yes", name: "Allow", kind: "allow_once" },
                { optionId: "always", name: "Allow always", kind: "allow_always" },
                { optionId: "no", name: "Reject", kind: "reject_once" },
              ] } }) + "\n");
          const answer = await awaitResponse("perm-1");
          const outcome = answer.result?.outcome;
          finish(msg.id, outcome?.outcome === "selected" && outcome.optionId !== "no"
            ? "allowed" : "denied");
          break;
        }
        if (lastLine === "whoami-tool") {
          await connecting;
          const result = await mcpClient.callTool({ name: "whoami", arguments: {} });
          finish(msg.id, JSON.stringify(result));
          break;
        }
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
        update({ sessionUpdate: "tool_call", toolCallId: "echo-tool", title: "echo",
          status: "in_progress", kind: "other" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "echo-tool", status: "completed" });
        update({ sessionUpdate: "usage_update", used: 100, size: 1000 });
        finish(msg.id, `echo:${lastLine}`);
        break;
      }
      case "session/cancel":
        if (sleepingPrompt !== undefined) {
          const id = sleepingPrompt;
          sleepingPrompt = undefined;
          finish(id, "", "cancelled");
        }
        break;
      default:
        if (msg.id !== undefined) fail(msg.id, "method not found");
    }
  })().catch(() => process.exit(10));
});
