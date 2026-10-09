import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

// Only external Phoenix/provider endpoints are fixtures. The built CLI creates
// its own ServerLink, controller, Host and pinned SDK/CLI without replacements.
it.each(["operator", "peer"] as const)("fences %s delivery through the built CLI and native SDK on loopback", async source => {
  const root = await mkdtemp(join(tmpdir(), "fuji560-claude-native-"));
  const trace: Array<{ event: string; revision?: number; text?: string }> = [];
  const requests: any[] = [];
  let held: ServerResponse | undefined;
  let toolsIssued = 0;
  const provider = createServer(async (request, response) => {
    if (request.url === "/barrier") { held = response; trace.push({ event: "native_tool_wait" }); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url?.includes("count_tokens") ? '{"input_tokens":10}' : "{}"); return;
    }
    const payload = JSON.parse(raw); requests.push(payload);
    trace.push({ event: "native_provider", text: ["BASE-NATIVE", "ON-NATIVE", "OFF-NATIVE"]
      .filter(nonce => JSON.stringify(payload.messages).includes(nonce)).join(",") });
    const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    emit("message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant",
      model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    const issueTool = toolsIssued < 2;
    if (issueTool) {
      toolsIssued++;
      const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port");
      const script = `require('http').get('http://127.0.0.1:${address.port}/barrier',r=>r.resume())`;
      emit("content_block_start", { type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: `tool_barrier_${toolsIssued}`, name: "Bash", input: {} } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta",
        partial_json: JSON.stringify({ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, description: "Owned loopback barrier" }) } });
    } else {
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } });
    }
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", { type: "message_delta", delta: { stop_reason: issueTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    emit("message_stop", { type: "message_stop" }); response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port");
  let claimCalls = 0;
  const wire = await phoenixLoopback(() => ({ delivery_policy: "v1", inter_agent_delivery_modes: "v1",
    inter_agent_reply_basis: "v1", inter_agent_delivery_incarnation: "i", work_control: "v1" }), (event, payload) => {
    if (event === "yield_claim") { claimCalls++; wire.push("delivery_policy", { version: "0", revision: 2, policy: "off" }); return { granted: true }; }
    if (event === "delivery_policy_applied") trace.push({ event: "policy_ack", revision: payload.revision as number });
    return {};
  });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ agent_id: "fuji560.native.claude", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P", server_url: wire.url, model: "claude-haiku-4-5-20251001", phase2_delivery: true,
    allowed_tools: ["Bash"], permission_mode: "default" }));
  const env = { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"),
    ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", LANG: "C.UTF-8" };
  const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
  const child = spawn(process.execPath, [cli, configPath], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exit = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  const check = async (assertion: () => void) => vi.waitFor(() => {
    expect(child.exitCode, output).toBeNull(); assertion();
  }, { timeout: 25_000, interval: 20 });
  const accepted = () => output.split("\n").filter(line => line.includes('"event":"claude_live_input_accepted"'));
  const ack = async (revision: number) => {
    wire.push("delivery_policy", { version: "0", revision, policy: revision === 2 ? "off" : "on" });
    await check(() => expect(trace.some(item => item.event === "policy_ack" && item.revision === revision)).toBe(true));
  };
  const input = (seq: number, text: string, grant: "normal" | "early" | "yield") => {
    if (source === "operator") wire.push("instruction", { version: "0", text, delivery_intent: grant });
    else wire.push("envelope", { version: "0", agent_id: `peer-${seq}`, persona: { id: "peer", name: "Peer", sprite_set: "peer" },
      ts: "T", type: "inter_agent_message", state: "thinking", delivery_seq: seq, payload: { to: "fuji560.native.claude",
        conversation_id: `native-cid-${seq}`, turn_number: 1, kind: "inform", body: text, work: { work_id: "W" },
        delivery_authority: { requested: grant, granted: grant,
          ...(grant === "yield" ? { yield_token: "claim", work_id: "W", authority_epoch: 1 } : {}) } } });
  };
  try {
    await check(() => expect(wire.joins).toBe(1));
    expect(wire.received.find(item => item.event === "phx_join")?.payload.delivery_policy).toBe("v1");
    await ack(1); wire.push("persona_prompt", { version: "0", prompt: "Native policy verification." });
    await check(() => expect(wire.received.some(item => item.event === "envelope" && item.payload.type === "state_change")).toBe(true));
    input(1, "BASE-NATIVE", "normal");
    await check(() => expect(held).toBeDefined());
    input(2, "ON-NATIVE", "early");
    await check(() => expect(accepted()).toHaveLength(1));
    expect(accepted()[0]).toContain('"policy_revision":1');
    held!.writeHead(200); held!.end("first released"); held = undefined;
    await check(() => expect(toolsIssued === 2 && held !== undefined).toBe(true));
    expect(requests.some(item => JSON.stringify(item.messages).includes("ON-NATIVE"))).toBe(true);
    if (source === "operator") { await ack(2); input(3, "OFF-NATIVE", "early");
      await check(() => expect(output).toContain("instruction: OFF-NATIVE"));
    } else {
      await check(() => expect(wire.received.some(item => item.event === "delivery_stage" && item.payload.delivery_seq === 2 && item.payload.handoff === "fold_hook")).toBe(true));
      input(3, "OFF-NATIVE", "yield");
      await check(() => expect(claimCalls).toBe(1));
      await check(() => expect(wire.received.some(item => item.event === "delivery_stage" && item.payload.delivery_seq === 3 && item.payload.reason === "local_policy_disabled")).toBe(true));
      await ack(3);
    }
    held!.writeHead(200); held!.end("released"); held = undefined;
    await check(() => expect(requests.some(item => JSON.stringify(item.messages).includes("OFF-NATIVE"))).toBe(true));
    expect(accepted()).toHaveLength(1);
    const offInputs = requests.flatMap(item => item.messages.filter((message: any) => message.role === "user" && JSON.stringify(message.content).includes("OFF-NATIVE")));
    expect(offInputs.length).toBeGreaterThan(0);
    expect(offInputs.every((message: any) => !JSON.stringify(message.content).includes("fold_id:"))).toBe(true);
    expect(requests.some(item => JSON.stringify(item.messages).includes("ON-NATIVE"))).toBe(true);
    await check(() => expect(wire.received.filter(item => item.event === "envelope" && item.payload.type === "result")).toHaveLength(2));
    expect(output).not.toContain("gate_broken");
    if (source === "peer") {
      const stages = wire.received.filter(item => item.event === "delivery_stage" && item.payload.delivery_seq === 3);
      expect(stages.filter(item => item.payload.stage === "submitted")).toHaveLength(1);
      expect(stages.find(item => item.payload.stage === "submitted")?.payload).toMatchObject({ mode: "normal", handoff: "prompt_hook" });
      expect(stages.filter(item => item.payload.yield_disposition)).toHaveLength(1);
    }
    console.log(JSON.stringify({ native_policy: { engine: "claude", source, credentialed_turns: 0, trace, accepted: accepted() } }));
  } finally {
    held?.end("cleanup");
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit; await wire.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
}, 45_000);
