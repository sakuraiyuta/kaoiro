// A stand-in `agy` for composition tests: `models`, `-p /hooks` and `acp`.
// `acp` speaks ACP over stdio. A prompt's text picks what happens:
//   BLOCK            hold the prompt until session/cancel or a signal
//   EXIT             exit without answering
//   TOOL <name> <json>   a tool call that goes through the real PreToolUse
//                    hook command of the customization directory, then ends
//                    completed (allow) or failed (deny)
//   UNHOOKED <name> [ms] a tool call that completes without a hook (gate
//                    fault), after an optional delay
//   KAOIRO <tool> <json> a kaoiro tool call through the hook and the MCP host
//   HOLDSTOP         ask the Stop hook while a background task runs
//   HANGTOOL <name> <json> a hooked tool that never ends, with a message
//                    chunk every 100 ms until the prompt is cancelled
//   RELEASED         a hooked manage_task that ends at 100 ms; chunks every
//                    100 ms; the reply "finished after the deadline" at 1.6 s
//   SUBTREE          start FAKE_AGY_GRANDCHILD (a node script) as a child,
//                    publish its pid to FAKE_AGY_GRANDCHILD_PID_FILE, show a
//                    run_command that never ends, and stream chunks
//   ECHO <text>      reply with the text
// Anything else is answered with one message chunk and end_turn.
// Environment: FAKE_AGY_PID_FILE (write the pid), FAKE_AGY_IGNORE_TERM=1
// (ignore SIGTERM), FAKE_AGY_SESSION (the new session's ID),
// FAKE_AGY_PROMPT_LOG (append each prompt's blocks as one JSON line),
// FAKE_AGY_IGNORE_CANCEL=1 (leave session/cancel unanswered).
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

function addDirs() {
  const dirs = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === "--add-dir") dirs.push(args[i + 1]);
  return dirs;
}

function hooksOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8")).hooks ?? {};
  } catch {
    return undefined;
  }
}

function listHooks() {
  const groups = [];
  for (const dir of addDirs()) {
    const hooks = hooksOf(dir);
    if (hooks === undefined) continue;
    const actions = [];
    for (const entry of hooks.PreToolUse ?? []) {
      for (const hook of entry.hooks ?? []) {
        actions.push({ event: "PreToolUse", matcher: entry.matcher, type: "command", command: hook.command, timeout_seconds: hook.timeout });
      }
    }
    for (const hook of hooks.Stop ?? []) actions.push({ event: "Stop", type: "command", command: hook.command, timeout_seconds: hook.timeout });
    groups.push({ name: "hooks", enabled: true, source: join(dir, ".agents", "hooks.json"), actions });
  }
  process.stdout.write(JSON.stringify({ conversation_id: "", status: "SUCCESS", command: { name: "hooks", data: { hooks: groups } } }));
}

function runHook(event, payload) {
  const dir = addDirs().find((candidate) => hooksOf(candidate) !== undefined);
  const hooks = dir === undefined ? undefined : hooksOf(dir);
  const command = event === "Stop" ? hooks?.Stop?.[0]?.command : hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (command === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => {
      try { resolve(JSON.parse(out)); } catch { resolve(undefined); }
    });
    child.stdin.end(JSON.stringify({ hookEventName: event, ...payload }));
  });
}

/** Writes a pid marker atomically, so a reader never sees half of it. */
function publishPid(path, pid) {
  writeFileSync(`${path}.tmp-${pid}`, String(pid));
  renameSync(`${path}.tmp-${pid}`, path);
}

function acp() {
  if (process.env.FAKE_AGY_PID_FILE) publishPid(process.env.FAKE_AGY_PID_FILE, process.pid);
  if (process.env.FAKE_AGY_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  let sessionId = process.env.FAKE_AGY_SESSION ?? "fake-session";
  let mcp;
  let prompt;
  let calls = 0;
  const cancelled = [];
  const current = { model: "fixture-model", thought_level: "medium" };
  const offered = { model: ["fixture-model"], thought_level: ["low", "medium", "high"] };
  const options = () => Object.entries(offered).map(([id, values]) => ({
    id, name: id, category: id, type: "select", currentValue: current[id], options: values.map((value) => ({ value, name: value })),
  }));
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
  const answer = (stopReason) => {
    if (prompt === undefined) return;
    const id = prompt;
    prompt = undefined;
    send({ id, result: { stopReason } });
  };
  const listTools = () => fetch(mcp.url, {
    method: "POST",
    headers: { ...mcp.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }).catch(() => undefined);
  const callTool = (name, input) => fetch(mcp.url, {
    method: "POST",
    headers: { ...mcp.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: input } }),
  }).then((response) => response.text()).catch(() => "");
  const tool = async (name, input, viaMcp) => {
    calls += 1;
    const callId = `call-${calls}`;
    const fullName = viaMcp ? `mcp_kaoiro_${name}` : name;
    update({ sessionUpdate: "tool_call", toolCallId: callId, name: fullName, title: fullName, kind: "other", status: "in_progress", rawInput: input });
    const decision = await runHook("PreToolUse", { conversationId: sessionId, stepIdx: calls, toolCall: { id: callId, name: fullName, args: input } });
    // The output names the hook's decision, so a test can tell them apart.
    let output = decision?.decision === "allow" ? "allowed" : decision?.reason ?? "denied";
    if (decision?.decision === "allow" && viaMcp) output = await callTool(name, input);
    update({ sessionUpdate: "tool_call_update", toolCallId: callId, name: fullName, status: decision?.decision === "allow" ? "completed" : "failed", rawInput: input, rawOutput: { output } });
  };
  const run = async (text) => {
    // An inter-agent batch wraps the body in a header, so the first marker
    // word anywhere decides, up to the end of its line.
    const line = /\b(?:BLOCK|EXIT|TOOL|KAOIRO|UNHOOKED|HOLDSTOP|HANGTOOL|RELEASED|SUBTREE|ECHO)\b[^\n]*/.exec(text)?.[0].trim() ?? "";
    const [, word, first, rest] = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(line) ?? [];
    if (word === "BLOCK") return;
    if (word === "SUBTREE") {
      const grandchild = spawn(process.execPath, [process.env.FAKE_AGY_GRANDCHILD], { stdio: "ignore" });
      publishPid(process.env.FAKE_AGY_GRANDCHILD_PID_FILE, grandchild.pid);
      update({ sessionUpdate: "tool_call", toolCallId: "background", name: "run_command", title: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 1000" } });
      setInterval(() => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } }), 50);
      return;
    }
    if (word === "HANGTOOL" || word === "RELEASED") {
      const name = word === "RELEASED" ? "manage_task" : first;
      const input = word === "RELEASED" ? { Action: "status" } : JSON.parse(rest ?? "{}");
      calls += 1;
      const callId = `call-${calls}`;
      update({ sessionUpdate: "tool_call", toolCallId: callId, name, title: name, kind: "other", status: "in_progress", rawInput: input });
      await runHook("PreToolUse", { conversationId: sessionId, stepIdx: calls, toolCall: { id: callId, name, args: input } });
      const ticker = setInterval(() => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } }), 100);
      cancelled.push(() => clearInterval(ticker));
      if (word === "RELEASED") {
        setTimeout(() => update({ sessionUpdate: "tool_call_update", toolCallId: callId, name, status: "completed", rawInput: input }), 100);
        setTimeout(() => {
          clearInterval(ticker);
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "finished after the deadline" } });
          answer("end_turn");
        }, 1_600);
      }
      return;
    }
    if (word === "EXIT") { process.exit(3); }
    if (word === "TOOL") await tool(first, JSON.parse(rest ?? "{}"), false);
    else if (word === "KAOIRO") await tool(first, JSON.parse(rest ?? "{}"), true);
    else if (word === "UNHOOKED") {
      if (rest !== undefined) await new Promise((resolve) => setTimeout(resolve, Number(rest)));
      update({ sessionUpdate: "tool_call", toolCallId: "unhooked", name: first, title: first, kind: "other", status: "in_progress", rawInput: {} });
      update({ sessionUpdate: "tool_call_update", toolCallId: "unhooked", name: first, status: "completed", rawInput: {} });
    } else if (word === "HOLDSTOP") {
      const stop = await runHook("Stop", { conversationId: sessionId, terminationReason: "NO_TOOL_CALL", fullyIdle: false, executionNum: 1, continuationActive: false });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: stop?.decision === "continue" ? "held" : "released" } });
    } else if (word === "ECHO") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: [first, rest].filter(Boolean).join(" ") } });
    } else {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
    }
    answer("end_turn");
  };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const params = message.params ?? {};
      switch (message.method) {
        case "initialize":
          send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          break;
        case "session/new":
        case "session/resume": {
          const server = params.mcpServers?.[0];
          if (server !== undefined) mcp = { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
          if (message.method === "session/resume") sessionId = params.sessionId;
          send({ id: message.id, result: { sessionId, configOptions: options() } });
          void listTools();
          break;
        }
        case "session/set_config_option":
          if (offered[params.configId]?.includes(params.value)) {
            current[params.configId] = params.value;
            send({ id: message.id, result: { configOptions: options() } });
          } else {
            send({ id: message.id, error: { code: -32602, message: "Invalid params" } });
          }
          break;
        case "session/prompt":
          prompt = message.id;
          if (process.env.FAKE_AGY_PROMPT_LOG) appendFileSync(process.env.FAKE_AGY_PROMPT_LOG, `${JSON.stringify(params.prompt)}\n`);
          void run((params.prompt ?? []).map((block) => block.text ?? "").join(""));
          break;
        case "session/cancel":
          if (process.env.FAKE_AGY_IGNORE_CANCEL === "1") break;
          for (const stop of cancelled.splice(0)) stop();
          answer("cancelled");
          break;
        default:
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (args[0] === "models") process.stdout.write("fixture-model\tFixture Model\n");
else if (args[0] === "-p" && args[1] === "/hooks") listHooks();
else if (args[0] === "acp") acp();
else process.exitCode = 2;
