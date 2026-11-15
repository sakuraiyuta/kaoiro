#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
if (process.argv.includes("--version")) {
  console.log("grok fixture 1.0.52");
  process.exit(0);
}
if (process.argv.includes("inspect")) {
  if (process.env.KAOIRO_TEST_GROK_INSPECT_FAIL === "1") process.exit(2);
  if (process.env.KAOIRO_TEST_GROK_INSPECT_UNKNOWN === "1") {
    console.log('{"future":true}');
    process.exit(0);
  }
  if (process.env.KAOIRO_TEST_GROK_INSPECT_HANG === "1") {
    if (process.env.KAOIRO_TEST_GROK_PID_FILE)
      writeFileSync(process.env.KAOIRO_TEST_GROK_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  console.log(
    JSON.stringify({
      permissions: {
        sources: ["fixture"],
        loaded: 1,
        skipped: [],
        managedSettingsActive: false,
      },
      externalCompat: {
        cells: [
          {
            vendor: "claude",
            surface: "hooks",
            enabled: true,
            source: "config",
          },
        ],
      },
    }),
  );
  process.exit(0);
}
const sid = "fixture-session";
const record = (event, extra = {}) => {
  if (process.env.KAOIRO_TEST_GROK_EVENTS)
    appendFileSync(process.env.KAOIRO_TEST_GROK_EVENTS, JSON.stringify({ event, pid: process.pid,
      profile: process.env.GROK_SANDBOX, ...extra }) + "\n");
};
record("spawn");
if (process.env.KAOIRO_TEST_GROK_IGNORE_TERM === "1") {
  setInterval(() => {}, 1000);
  const child = spawn(process.execPath, [
    "-e",
    'process.on("SIGTERM",()=>{});console.log("ready");' +
      "setInterval(()=>{},1000);",
  ]);
  child.stdout.once("data", () => {
    if (process.env.KAOIRO_TEST_GROK_PID_FILE)
      writeFileSync(process.env.KAOIRO_TEST_GROK_PID_FILE, String(child.pid));
  });
}
// Like Grok 1.0.52: four models, the fourth without the xhigh effort, and a
// selection that lives in the session rather than in the process.
const LEVELS = ["xhigh", "high", "medium", "low"];
const MODELS = [
  { id: "grok-4.7", name: "Grok 4.7", levels: LEVELS, window: 200_000 },
  { id: "grok-4.7-build-fast", name: "Grok 4.7 Fast", levels: LEVELS, window: 200_000 },
  { id: "grok-4.6", name: "Grok 4.6", levels: LEVELS, window: 150_000 },
  { id: "grok-4.5", name: "Grok 4.5", levels: LEVELS.slice(1), window: 100_000 },
];
let model = "grok-4.7";
let effort = process.env.KAOIRO_TEST_GROK_EFFORT ?? "high";
const noConfig = process.env.KAOIRO_TEST_GROK_CONFIG === "none";
const modelState = () => ({
  currentModelId: model,
  availableModels: MODELS.map((m) => ({
    modelId: m.id, name: m.name,
    _meta: { totalContextTokens: m.window, contextWindows: [m.window, m.window],
      supportsReasoningEffort: true,
      reasoningEfforts: m.levels.map((value) => ({ id: value, value, label: value, default: value === "high" })) },
  })),
});
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: MODELS.map((m) => ({ value: m.id, name: m.name })) },
  { id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select",
    currentValue: effort,
    options: MODELS.find((m) => m.id === model).levels.map((value) => ({ value, name: value })) },
];
const persist = () => {
  if (process.env.KAOIRO_TEST_GROK_SESSION_FILE)
    writeFileSync(process.env.KAOIRO_TEST_GROK_SESSION_FILE, JSON.stringify({ model, effort }));
};
const restore = () => {
  const file = process.env.KAOIRO_TEST_GROK_SESSION_FILE;
  if (!file || !existsSync(file)) return;
  ({ model, effort } = JSON.parse(readFileSync(file, "utf8")));
};
const invalidParams = (id) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id,
    error: { code: -32602, message: "Invalid params" } }) + "\n");
// One simulated model call. The prompt grows with the call number, so the
// last call, the first call and the turn's sum all differ.
let turnCalls = 0;
let turnModel = model;
let billingCalls = 0;
const modelCall = (n) => {
  turnCalls = n;
  record("model_call", { model, call: n });
  notification("_x.ai/session_notification", { sessionId: sid, update: {
    sessionUpdate: "response_completed", signature: "fixture",
    usage: { input_tokens: 1000 * n, output_tokens: 5, cache_read_input_tokens: 100 * n,
      cache_creation_input_tokens: 10 * n, reasoning_tokens: 1 } } });
};
const waitRelease = async () => {
  const file = process.env.KAOIRO_TEST_GROK_RELEASE_FILE;
  while (file && !existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 5));
};
let client;
let transport;
// Settles when the MCP connection attempt has ended, whatever its outcome.
let connecting = Promise.resolve();
let prompt;
// The prompt id Grok uses: the client's `_meta.promptId`, else the JSON-RPC id.
const promptIds = new Map();
let running;
const queueChanged = (id) => {
  running = id;
  notification("_x.ai/queue/changed", { sessionId: sid, entries: [],
    ...(id === undefined ? {} : { runningPromptId: id, runningKind: "prompt" }) });
};
// Prompts Grok starts on its own (issue 1128), scripted by the scenes below.
const waiters = new Map();
const awaitResponse = (id) => new Promise((resolve) => waiters.set(id, resolve));
let foreign;
let foreignHold = false;
let ownQueued;
const FOREIGN_TOKENS = 7000;
const startForeign = (id) => {
  foreign = id;
  running = id;
  notification("_x.ai/queue/changed", { sessionId: sid,
    entries: ownQueued === undefined ? [] : [{ id: ownQueued, kind: "prompt" }],
    runningPromptId: id, runningKind: "prompt" });
};
const endForeign = (category) => {
  notification("_x.ai/session_notification", { sessionId: sid,
    update: { sessionUpdate: "turn_completed", prompt_id: foreign },
    ...(category ? { _meta: { cancellationCategory: category } } : {}) });
  foreign = undefined;
  foreignHold = false;
  if (ownQueued === undefined) queueChanged(undefined);
  else { const own = ownQueued; ownQueued = undefined; queueChanged(own); }
};
const foreignBody = async (withPermission) => {
  textChunk("FOREIGN_TEXT");
  update({ sessionUpdate: "tool_call", toolCallId: "foreign-tool", title: "foreign tool",
    status: "in_progress", kind: "execute" });
  if (withPermission) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "foreign-permission",
      method: "session/request_permission", params: { sessionId: sid,
        toolCall: { toolCallId: "foreign-tool", title: "foreign tool" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" }] } }) + "\n");
    const answer = await awaitResponse("foreign-permission");
    record("foreign-permission-response", { outcome: answer.result?.outcome?.outcome });
  }
  notification("_x.ai/session_notification", { sessionId: sid, update: {
    sessionUpdate: "response_completed", signature: "fixture",
    usage: { input_tokens: FOREIGN_TOKENS, output_tokens: 5, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, reasoning_tokens: 1 } } });
};
let memory = "";
let rules = "";
const reply = (id, result) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }) + "\n",
  );
const notification = (method, params) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }) + "\n",
  );
const update = (data) =>
  notification("session/update", {
    sessionId: sid,
    update: data,
    ...(running === undefined ? {} : { _meta: { promptId: running } }),
  });
const textChunk = (text) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const finish = (id, text, stopReason = "end_turn", category, noCall = false) => {
  if (turnCalls === 0 && stopReason === "end_turn" && !noCall) modelCall(1);
  if (text)
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  const promptId = promptIds.get(id) ?? String(id);
  promptIds.delete(id);
  notification("_x.ai/session_notification", {
    sessionId: sid,
    update: { sessionUpdate: "turn_completed", prompt_id: promptId },
  });
  queueChanged(undefined);
  reply(id, {
    stopReason,
    _meta: {
      ...(text === "no-prompt-id" ? {} : { promptId }),
      requestId: String(id),
      modelId: turnModel,
      ...(turnCalls > 0 ? { inputTokens: 1110 * turnCalls } : {}),
      ...(category ? { cancellationCategory: category } : {}),
    },
  });
  prompt = undefined;
};
process.on("SIGTERM", () => {
  if (process.env.KAOIRO_TEST_GROK_IGNORE_TERM === "1") return;
  record("exit");
  void client?.close().finally(() => process.exit(0));
  if (!client) process.exit(0);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const msg = JSON.parse(line);
    record(msg.method ?? "response", { ...(msg.params?.sessionId ? { sessionId: msg.params.sessionId } : {}),
      ...(msg.method === "session/set_config_option"
        ? { configId: msg.params.configId, value: msg.params.value } : {}) });
    const fault = process.env.KAOIRO_TEST_GROK_SWITCH_FAULT;
    if (fault && process.env.GROK_SANDBOX === "read-only") {
      if (fault === `${msg.method}:exit`) process.exit(13);
      if (fault === `${msg.method}:close`) { process.stdout.end(); return; }
      if (fault === `${msg.method}:hang`) return;
      if (fault === `${msg.method}:fail`) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
          error: { code: -32603, message: "fixture fault" } }) + "\n");
        return;
      }
    }
    switch (msg.method) {
      case "_x.ai/billing": {
        billingCalls += 1;
        // Default to valid to exercise the production startup publication in host tests.
        const [initial, subsequent] = (process.env.KAOIRO_TEST_GROK_BILLING ?? "valid").split("-then-");
        const mode = billingCalls > 1 && subsequent ? subsequent : initial;
        if (mode === "hang") break;
        if (mode === "delay")
          await new Promise((resolve) => setTimeout(resolve,
            Number(process.env.KAOIRO_TEST_GROK_BILLING_DELAY_MS ?? 10)));
        if (mode === "unsupported" || mode === "auth" || mode === "transport") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
            error: mode === "unsupported"
              ? { code: -32601, message: "Method not found" }
              : mode === "auth"
                ? { code: -32000, message: "fixture auth error", data: { status: 401 } }
                : { code: -32603, message: "fixture transport error" } }) + "\n");
          break;
        }
        if (mode === "malformed") {
          reply(msg.id, { config: { creditUsagePercent: 12.5,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2099-12-31T00:00:00Z" } } });
          break;
        }
        const percent = mode === "sequence" ? 10 + billingCalls : 12.5;
        reply(msg.id, { config: {
          creditUsagePercent: percent,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: mode === "expired" ? "2019-12-25T00:00:00Z" : "2099-12-24T00:00:00Z",
            end: mode === "expired" ? "2020-01-01T00:00:00Z" : "2099-12-31T00:00:00Z" },
          billingPeriodEnd: "PRIVATE_BILLING_FIELD",
          subscription: { amount: 999 },
        } });
        break;
      }
      case "initialize":
        if (process.env.KAOIRO_TEST_GROK_INITIALIZE_FAIL === "1") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32603, message: "LAUNCH_ERROR_BODY_MARKER" },
          }) + "\n");
          break;
        }
        reply(msg.id, {
          protocolVersion: 1,
          agentCapabilities:
            process.env.KAOIRO_TEST_GROK_MCP_MODE === "no-http"
              ? {}
              : { loadSession: true, mcpCapabilities: { http: true, sse: true },
                ...(process.env.KAOIRO_TEST_GROK_NO_RESUME === "1" ? {}
                  : { sessionCapabilities: { list: {}, resume: {}, close: {} } }) },
          authMethods: [],
          ...(noConfig ? {} : { _meta: { modelState: modelState() } }),
        });
        break;
      case "session/resume":
        // Like Grok 1.0.52: -32603 for an unknown id or another cwd, and no
        // replay before the response.
        if (msg.params.sessionId !== sid || (process.env.KAOIRO_TEST_GROK_RESUME_CWD &&
          msg.params.cwd !== process.env.KAOIRO_TEST_GROK_RESUME_CWD)) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
            error: { code: -32603, message: "RESUME_ERROR_BODY_MARKER" } }) + "\n");
          break;
        }
      // falls through
      case "session/load":
      case "session/new": {
        const loading = msg.method === "session/load";
        const resuming = msg.method === "session/resume";
        if (!loading && !resuming) rules = msg.params._meta.rules;
        else restore();
        if (loading) {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY_ONLY" } });
          // Grok replays past hook executions on load (issue 633).
          notification("_x.ai/session/update", {
            sessionId: sid, update: { sessionUpdate: "hook_execution", event_name: "session_start", runs: [] },
          });
          notification("_x.ai/session_notification", {
            sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: "replayed-id" },
          });
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "replay-permission",
            method: "session/request_permission", params: { sessionId: sid,
              toolCall: { toolCallId: "replayed-tool", title: "replay" },
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } }) + "\n");
        }
        const mcp = msg.params.mcpServers[0];
        const mode = process.env.KAOIRO_TEST_GROK_MCP_MODE ?? "ok";
        const headers = Object.fromEntries(
          (mcp.headers ?? []).map((h) => [h.name, h.value]),
        );
        const token = /^Bearer (.+)$/.exec(headers.Authorization ?? "")?.[1];
        // Test-only side channels: the token this process received, and whether
        // it can be found in this process's argv or environment.
        if (token && process.env.KAOIRO_TEST_GROK_TOKEN_FILE)
          writeFileSync(process.env.KAOIRO_TEST_GROK_TOKEN_FILE, token);
        if (token && process.env.KAOIRO_TEST_GROK_SCAN_FILE)
          writeFileSync(
            process.env.KAOIRO_TEST_GROK_SCAN_FILE,
            JSON.stringify({
              type: mcp.type,
              url: mcp.url,
              tokenInArgv: JSON.stringify(process.argv).includes(token),
              tokenInEnv: JSON.stringify(process.env).includes(token),
              tokenInUrl: String(mcp.url).includes(token),
            }),
          );
        // Like Grok, reply first and connect afterwards, and carry on without
        // the server when the connection fails.
        reply(msg.id, {
          ...(loading || resuming ? {} : { sessionId: sid }),
          ...(noConfig ? {} : { configOptions: configOptions() }),
        });
        // Like Grok 1.0.52: the session_start hook follows the response on
        // both session/new and session/load (issue 633).
        notification("_x.ai/session_notification", {
          sessionId: sid,
          update: { sessionUpdate: "hook_execution", event_name: "session_start", runs: [] },
        });
        for (let i = 0; i < Number(process.env.KAOIRO_TEST_GROK_LOADING_FLOOD ?? 0); i++)
          notification("_x.ai/session_notification", {
            sessionId: sid, update: { sessionUpdate: "loading_flood" },
          });
        if (loading && process.env.GROK_SANDBOX === "read-only" && fault?.startsWith("readiness:")) {
          if (fault.endsWith(":exit")) setTimeout(() => process.exit(13), 30);
          if (fault.endsWith(":close")) setTimeout(() => process.stdout.end(), 30);
          break;
        }
        if (mode !== "never-connect") {
          const sent =
            mode === "drop-headers"
              ? {}
              : mode === "wrong-token"
                ? { Authorization: `Bearer ${"x".repeat(token?.length ?? 43)}` }
                : headers;
          transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
            requestInit: { headers: sent },
          });
          client = new Client({ name: "grok-fixture", version: "0" });
          connecting = (async () => {
            await client.connect(transport);
            await client.listTools();
          })().catch(() => {});
        }
        break;
      }
      case "session/set_config_option": {
        const { configId, value } = msg.params;
        if (process.env.KAOIRO_TEST_GROK_SET_HANG === "1") break;
        if (configId === "model") {
          if (process.env.KAOIRO_TEST_GROK_MODEL_FAIL === "1" || !MODELS.some((m) => m.id === value))
            return invalidParams(msg.id);
          model = value;
        } else if (configId === "reasoning_effort") {
          if (process.env.KAOIRO_TEST_GROK_EFFORT_FAIL === "1" ||
            !MODELS.find((m) => m.id === model).levels.includes(value)) return invalidParams(msg.id);
          effort = value;
        } else return invalidParams(msg.id);
        persist();
        const announce = () => {
          update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
          notification("_x.ai/session_notification", { sessionId: sid, update: {
            sessionUpdate: "model_changed", model_id: model, reasoning_effort: effort } });
        };
        // Real Grok answers first; this knob puts the notifications ahead.
        if (process.env.KAOIRO_TEST_GROK_NOTIFY_FIRST === "1") announce();
        reply(msg.id, { configOptions: configOptions() });
        if (process.env.KAOIRO_TEST_GROK_NOTIFY_FIRST !== "1") announce();
        break;
      }
      case "session/prompt": {
        prompt = msg.id;
        promptIds.set(msg.id, msg.params._meta?.promptId ?? String(msg.id));
        record("prompt_id", { promptId: msg.params._meta?.promptId ?? null });
        if (!/^foreign-(during|interrupt)$/.test(msg.params.prompt[0].text))
          queueChanged(promptIds.get(msg.id));
        turnCalls = 0;
        turnModel = process.env.KAOIRO_TEST_GROK_REPORT_MODEL ?? model;
        const text = msg.params.prompt[0].text;
        const calls = /^calls-(\d+)$/.exec(text);
        if (calls) {
          for (let n = 1; n <= Number(calls[1]); n++) {
            if (n > 1) await waitRelease();
            update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
            modelCall(n);
          }
          finish(msg.id, "");
          break;
        }
        if (text === "no-calls") {
          finish(msg.id, "", "end_turn", undefined, true);
          break;
        }
        if (text === "rogue-config-update") {
          const rogue = configOptions();
          rogue[0] = { ...rogue[0], currentValue: "grok-4.5" };
          update({ sessionUpdate: "config_option_update", configOptions: rogue });
          finish(msg.id, "");
          break;
        }
        if (text === "rogue-model-changed") {
          notification("_x.ai/session_notification", { sessionId: sid, update: {
            sessionUpdate: "model_changed", model_id: "grok-4.5", reasoning_effort: "low" } });
          finish(msg.id, "");
          break;
        }
        if (["chunks", "fail-chunks", "hold-chunks"].includes(text)) {
          for (const chunk of ["Hello", " ", "world"]) textChunk(chunk);
          if (text === "hold-chunks") break;
          if (text === "fail-chunks") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              error: { code: -32603, message: "fixture turn failure" },
            }) + "\n");
            prompt = undefined;
          } else finish(msg.id, "");
          break;
        }
        const reply = /^reply-(\d+)$/.exec(text);
        if (reply) {
          for (let left = Number(reply[1]); left > 0; left -= 10_000)
            textChunk("x".repeat(Math.min(left, 10_000)));
          finish(msg.id, "");
          break;
        }
        if (text === "large-chunks") {
          textChunk("x".repeat(10 * 1024));
          textChunk("x".repeat(10 * 1024));
          finish(msg.id, "");
          break;
        }
        if (text === "ordered-chunks") {
          textChunk("Before");
          update({ sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" } });
          textChunk(" tool");
          update({ sessionUpdate: "tool_call_update",
            toolCallId: "ordered", status: "in_progress" });
          update({ sessionUpdate: "tool_call", toolCallId: "ordered", title: "probe",
            status: "in_progress", kind: "other" });
          textChunk("After");
          update({ sessionUpdate: "tool_call_update", toolCallId: "ordered", status: "completed" });
          update({ sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" } });
          textChunk(" tool");
          finish(msg.id, "");
          break;
        }
        if (text === "non-text-chunks") {
          update({ sessionUpdate: "agent_message_chunk", content: {
            type: "image", data: "", mimeType: "image/png" } });
          update({ sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" } });
          finish(msg.id, "");
          break;
        }
        if (text === "close-output") {
          if (process.env.KAOIRO_TEST_GROK_PID_FILE)
            writeFileSync(process.env.KAOIRO_TEST_GROK_PID_FILE,
              String(process.pid));
          process.stdout.end();
          setInterval(() => {}, 1000);
          break;
        }
        if (text === "fail-turn") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32603, message: "TURN_FAILURE_BODY_MARKER" },
          }) + "\n");
          prompt = undefined;
          break;
        }
        if (text === "large-tool") {
          update({
            sessionUpdate: "tool_call", toolCallId: "large",
            title: "large result", kind: "other", status: "in_progress",
          });
          update({
            sessionUpdate: "tool_call_update", toolCallId: "large",
            status: "completed", content: [{ type: "content", content: {
              type: "text",
              text: "LARGE_TOOL_BODY_MARKER" + "x".repeat(5 * 1024 * 1024),
            } }],
          });
          finish(msg.id, "large tool completed");
          break;
        }
        if (text === "exit") {
          process.exit(9);
        }
        if (text === "arm-foreign" || text === "arm-foreign-hold") {
          finish(msg.id, "armed");
          setTimeout(() => void (async () => {
            startForeign("task-completed-fixture");
            if (text === "arm-foreign-hold") { textChunk("FOREIGN_TEXT"); foreignHold = true; return; }
            await foreignBody(true);
            endForeign();
          })(), 20);
          break;
        }
        if (text === "foreign-during" || text === "foreign-interrupt") {
          ownQueued = promptIds.get(msg.id);
          startForeign("task-completed-fixture");
          if (text === "foreign-interrupt") { textChunk("FOREIGN_TEXT"); foreignHold = true; break; }
          await foreignBody(true);
          endForeign();
          update({ sessionUpdate: "tool_call", toolCallId: "own-tool", title: "own tool",
            status: "in_progress", kind: "edit" });
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "own-permission",
            method: "session/request_permission", params: { sessionId: sid,
              toolCall: { toolCallId: "own-tool", title: "own tool" },
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" },
                { optionId: "no", name: "Reject", kind: "reject_once" }] } }) + "\n");
          const answer = await awaitResponse("own-permission");
          record("own-permission-response", { outcome: answer.result?.outcome?.outcome });
          finish(msg.id, "OWN_TEXT");
          break;
        }
        if (text === "permission-update-only" || text === "permission-bare-tool-call") {
          // A preceding record that must not establish ownership: an update
          // other than tool_call, or a tool_call without a prompt id.
          if (text === "permission-update-only")
            update({ sessionUpdate: "tool_call_update", toolCallId: "weak-tool", status: "in_progress" });
          else
            notification("session/update", { sessionId: sid, update: { sessionUpdate: "tool_call",
              toolCallId: "weak-tool", title: "weak tool", status: "in_progress", kind: "edit" } });
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "weak-permission",
            method: "session/request_permission", params: { sessionId: sid,
              toolCall: { toolCallId: "weak-tool", title: "weak tool" },
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" },
                { optionId: "no", name: "Reject", kind: "reject_once" }] } }) + "\n");
          const answer = await awaitResponse("weak-permission");
          record("weak-permission-response", { outcome: answer.result?.outcome?.outcome });
          finish(msg.id, "WEAK_DONE");
          break;
        }
        if (text === "permission-unknown") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "unknown-permission",
            method: "session/request_permission", params: { sessionId: sid,
              toolCall: { toolCallId: "ghost-tool", title: "ghost tool" },
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" },
                { optionId: "no", name: "Reject", kind: "reject_once" }] } }) + "\n");
          const answer = await awaitResponse("unknown-permission");
          record("unknown-permission-response", { outcome: answer.result?.outcome?.outcome });
          finish(msg.id, "UNKNOWN_DONE");
          break;
        }
        if (text === "canary") {
          // A value the test planted, carried through the real paths: the
          // assistant text (an envelope) and a notification's prompt_id (a
          // metadata-tee record).
          const canary = process.env.KAOIRO_TEST_GROK_CANARY;
          notification("_x.ai/session_notification", {
            sessionId: sid,
            update: { sessionUpdate: "turn_completed", prompt_id: canary },
          });
          finish(msg.id, canary);
          break;
        }
        if (text === "sleep" || text === "stubborn") {
          const child = spawn(process.execPath, [
            "-e",
            "setInterval(() => {}, 1000)",
          ]);
          if (process.env.KAOIRO_TEST_GROK_PID_FILE) {
            writeFileSync(
              process.env.KAOIRO_TEST_GROK_PID_FILE,
              String(child.pid),
            );
          }
          update({
            sessionUpdate: "tool_call",
            toolCallId: "long",
            title: "sleep",
            status: "in_progress",
            kind: "execute",
          });
          break;
        }
        if (text === "permission") {
          notification("_x.ai/session_notification", {
            session_id: sid,
            notification: { type: "pending_interaction", kind: "permission" },
          });
          update({
            sessionUpdate: "tool_call",
            toolCallId: "permission-tool",
            title: "write fixture",
            status: "in_progress",
            kind: "edit",
          });
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "permission",
              method: "session/request_permission",
              params: {
                sessionId: sid,
                toolCall: {
                  toolCallId: "permission-tool",
                  title: "write fixture",
                },
                options: [
                  { optionId: "yes", name: "Allow", kind: "allow_once" },
                  { optionId: "no", name: "Reject", kind: "reject_once" },
                ],
              },
            }) + "\n",
          );
          const readyFile = process.env.KAOIRO_TEST_GROK_BROKER_READY_FILE;
          if (readyFile) {
            const ready = setInterval(() => {
              if (!existsSync(readyFile)) return;
              clearInterval(ready);
              textChunk("BROKER_WAIT_PROGRESS");
            }, 5);
          } else {
            setTimeout(
              () =>
                update({
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "BROKER_WAIT_PROGRESS" },
                }),
              25,
            );
          }
          break;
        }
        if (text === "permission-after-text") {
          notification("_x.ai/session_notification", {
            session_id: sid,
            notification: { type: "pending_interaction", kind: "permission" },
          });
          textChunk("Before");
          textChunk(" permission");
          update({
            sessionUpdate: "tool_call",
            toolCallId: "permission-tool",
            title: "write fixture",
            status: "in_progress",
            kind: "edit",
          });
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "permission",
              method: "session/request_permission",
              params: {
                sessionId: sid,
                toolCall: {
                  toolCallId: "permission-tool",
                  title: "write fixture",
                },
                options: [
                  { optionId: "yes", name: "Allow", kind: "allow_once" },
                  { optionId: "no", name: "Reject", kind: "reject_once" },
                ],
              },
            }) + "\n",
          );
          const readyFile = process.env.KAOIRO_TEST_GROK_BROKER_READY_FILE;
          if (readyFile) {
            const ready = setInterval(() => {
              if (!existsSync(readyFile)) return;
              clearInterval(ready);
              textChunk("BROKER_WAIT_PROGRESS");
            }, 5);
          } else {
            setTimeout(
              () =>
                update({
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "BROKER_WAIT_PROGRESS" },
                }),
              25,
            );
          }
          break;
        }
        if (text === "pending-only") {
          notification("_x.ai/session_notification", {
            session_id: sid,
            notification: { type: "pending_interaction", kind: "permission" },
          });
        }
        if (text === "parallel-hold") {
          for (const id of ["a", "b"])
            update({ sessionUpdate: "tool_call", toolCallId: id, title: id,
              kind: "other", status: "in_progress" });
          update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
          textChunk("B_STILL_PENDING");
          break;
        }
        if (text === "parallel") {
          for (const id of ["a", "b"])
            update({
              sessionUpdate: "tool_call",
              toolCallId: id,
              title: id,
              kind: "other",
              status: "in_progress",
            });
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
          });
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "B_STILL_PENDING" },
          });
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "b",
            status: "completed",
          });
          finish(msg.id, "finished");
          break;
        }
        if (text === "unknown") {
          process.stderr.write("UNKNOWN_BODY_MARKER\n");
          update({
            sessionUpdate: "future_variant",
            content: "UNKNOWN_BODY_MARKER",
          });
        }
        if (["tool", "error-tool", "hang-tool", "whoami", "list-agents"].includes(text)) {
          const name = text === "whoami" ? "whoami"
            : text === "list-agents" ? "list_agents" : "probe";
          update({
            sessionUpdate: "tool_call",
            toolCallId: "mcp",
            title: name,
            status: "in_progress",
            kind: "other",
          });
          await connecting;
          const result = await client.callTool({
            name,
            arguments: name === "probe" ? { value: 7 } : {},
          });
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "mcp",
            status: "completed",
          });
          finish(msg.id, JSON.stringify(result));
          break;
        }
        // reset:<mode>:<end> calls request_session_reset, then ends the turn
        // with end_turn, cancelled or a JSON-RPC error.
        const reset = /^reset:(new|clear):(end|cancel|fail)$/.exec(text);
        if (reset) {
          await connecting;
          const result = await client.callTool({
            name: "request_session_reset",
            arguments: { mode: reset[1], reason: "fixture reset" },
          });
          if (prompt !== msg.id) break;
          if (reset[2] === "fail") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              error: { code: -32603, message: "fixture turn failure" },
            }) + "\n");
            prompt = undefined;
          } else if (reset[2] === "cancel") {
            finish(msg.id, JSON.stringify(result), "cancelled", "MidTurnAbort");
          } else finish(msg.id, JSON.stringify(result));
          break;
        }
        // reset-late calls request_session_reset after its turn has ended.
        if (text === "reset-late") {
          finish(msg.id, "");
          await connecting;
          setTimeout(() => {
            void client.callTool({
              name: "request_session_reset",
              arguments: { mode: "new" },
            }).then((result) => record("late-reset", {
              isError: result.isError === true,
              text: result.content?.[0]?.text ?? "",
            }));
          }, 100);
          break;
        }
        if (text.startsWith("[Inter-agent message")) {
          if (process.env.KAOIRO_TEST_GROK_FAIL_PEER === "1") process.exit(9);
          const match = /conversation_id="([^"]+)"/.exec(text);
          await connecting;
          const result = await client.callTool({
            name: "send_to_agent",
            arguments: {
              to: "peer",
              conversation_id: match?.[1],
              kind: "response",
              body: "fixture reply",
              done: true,
              propose_next: "",
            },
          });
          finish(msg.id, JSON.stringify(result));
          break;
        }
        if (text.startsWith("remember ")) memory = text.slice(9);
        finish(
          msg.id,
          text === "recall" ? memory : text === "rules" ? rules : text,
        );
        break;
      }
      case "session/cancel":
        // Like Grok, a cancel stops only the running prompt.
        if (foreign !== undefined) {
          record("cancel", { target: "foreign" });
          endForeign("MidTurnAbort");
          break;
        }
        record("cancel", { target: prompt === undefined ? "none" : "own" });
        if (prompt !== undefined)
          finish(prompt, "", "cancelled", "MidTurnAbort");
        break;
      default:
        if (waiters.has(msg.id)) {
          const resolve = waiters.get(msg.id);
          waiters.delete(msg.id);
          resolve(msg);
          break;
        }
        if (msg.id === "replay-permission") record("replay-permission-response", { outcome: msg.result?.outcome?.outcome });
        if (msg.id === "permission" && msg.result && prompt !== undefined) {
          finish(prompt, "", "cancelled", "PermissionRejected");
        }
    }
  })().catch(() => process.exit(10));
});
