import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

// The built CLI and pinned app-server use their default constructors. The
// external provider/wire are scripted; the RPC observer forwards unchanged.
it.each(["operator", "peer"] as const)("enforces policy for %s at native CLI composition", async source => {
  const root = await mkdtemp(join(tmpdir(), "fuji560-codex-native-"));
  const requests: any[] = [];
  const trace: Array<{ event: string; revision?: number; text?: string }> = [];
  let held: ServerResponse | undefined;
  const provider = createServer(async (request, response) => {
    if (request.url === "/barrier") { held = response; trace.push({ event: "native_tool_wait" }); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw); requests.push(payload);
    trace.push({ event: "provider", text: ["BASE-NATIVE", "ON-NATIVE", "OFF-NATIVE"].filter(nonce => raw.includes(nonce)).join(",") });
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port");
    const script = `require('http').get('http://127.0.0.1:${address.port}/barrier',r=>r.resume())`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const id = `response-${requests.length}`;
    const output = requests.length === 1
      ? [{ type: "custom_tool_call", id, call_id: id, name: "exec", status: "completed",
        input: `text(await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10000 })}));` }]
      : [{ type: "message", id, role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: "DONE", annotations: [] }] }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item }]),
      { type: "response.completed", response: { id, object: "response", status: "completed", output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port");
  const wire = await phoenixLoopback(() => ({ delivery_policy: "v1", inter_agent_delivery_modes: "v1", inter_agent_reply_basis: "v1",
    notice_attribution: "v1", inter_agent_delivery_incarnation: "i", operator_input_modes: "v1", permission_sync: true }), (event, payload) => {
    if (event === "delivery_policy_applied") trace.push({ event: "policy_ack", revision: payload.revision as number });
    return {};
  });
  await writeFile(join(root, "config.toml"), `model = "gpt-6-luna"\nmodel_provider = "local"\n[model_providers.local]\nname = "Native delivery policy"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\n[features]\nshell_snapshot = false\nplugins = false\n[analytics]\nenabled = false\n`);
  const configPath = join(root, "kaoiro.json");
  await writeFile(configPath, JSON.stringify({ agent_id: "fuji560.native.codex", persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P", server_url: wire.url, model: "gpt-6-luna", operator_steer: true, codex_backend: "app-server",
    sandbox: "danger-full-access", network_access: true, approval: "never" }));
  const cli = join(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
  const rpcModule = join(dirname(fileURLToPath(import.meta.url)), "../dist/app_server_rpc.js");
  const observer = join(root, "observer.mjs");
  await writeFile(observer, `import {AppServerRpc} from ${JSON.stringify(rpcModule)};\nconst original=AppServerRpc.prototype.request;\nAppServerRpc.prototype.request=function(method,params,timeout){if(method==="turn/start"||method==="turn/steer")process.stderr.write("NATIVE_RPC "+JSON.stringify({method,params})+"\\n");return original.call(this,method,params,timeout);};\n`);
  const child = spawn(process.execPath, ["--import", observer, cli, configPath], {
    cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, CODEX_HOME: root, TMPDIR: root, LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exit = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  const check = async (assertion: () => void) => vi.waitFor(() => { expect(child.exitCode, output).toBeNull(); assertion(); }, { timeout: 25_000, interval: 20 });
  const rpcs = () => output.split("\n").filter(line => line.startsWith("NATIVE_RPC ")).map(line => JSON.parse(line.slice(11)));
  const policy = async (revision: number, value: "on" | "off") => {
    wire.push("delivery_policy", { version: "0", revision, policy: value });
    await check(() => expect(trace.some(item => item.event === "policy_ack" && item.revision === revision)).toBe(true));
  };
  const input = (seq: number, text: string, grant: "normal" | "early") => {
    if (source === "operator") wire.push("instruction", { version: "0", text, delivery_intent: grant });
    else wire.push("envelope", { version: "0", agent_id: "peer", persona: { id: "peer", name: "Peer", sprite_set: "peer" },
      ts: "T", type: "inter_agent_message", state: "thinking", delivery_seq: seq, payload: { to: "fuji560.native.codex",
        conversation_id: `native-cid-${seq}`, turn_number: 1, kind: "inform", body: text,
        delivery_authority: { requested: grant, granted: grant } } });
  };
  try {
    await check(() => expect(wire.joins).toBe(1));
    expect(wire.received.find(item => item.event === "phx_join")?.payload.delivery_policy).toBe("v1");
    await policy(1, "on"); wire.push("permission_sync", { version: "0", control: null, next: null });
    wire.push("persona_prompt", { version: "0", prompt: "Native policy test." });
    await check(() => expect(wire.received.some(item => item.event === "envelope" && item.payload.type === "state_change")).toBe(true));
    input(1, "BASE-NATIVE", "normal"); await check(() => expect(held).toBeDefined());
    input(2, "ON-NATIVE", "early"); await check(() => expect(rpcs().filter(item => item.method === "turn/steer")).toHaveLength(1));
    if (source === "peer") await check(() => expect(wire.received.some(item => item.event === "delivery_ack" && item.payload.delivery_seq === 2)).toBe(true));
    await policy(2, "off"); input(3, "OFF-NATIVE", "early");
    await check(() => expect(output).toContain(source === "operator" ? "instruction: OFF-NATIVE" : "inter_agent_message: peer"));
    held!.writeHead(200); held!.end("released"); held = undefined;
    await check(() => expect(rpcs().filter(item => item.method === "turn/start")).toHaveLength(2));
    await check(() => expect(wire.received.filter(item => item.event === "envelope" && item.payload.type === "result")).toHaveLength(2));
    expect(rpcs().filter(item => item.method === "turn/steer")).toHaveLength(1);
    expect(JSON.stringify(rpcs().filter(item => item.method === "turn/start")[1]!.params)).toContain("OFF-NATIVE");
    expect(requests.some(item => JSON.stringify(item.input).includes("ON-NATIVE"))).toBe(true);
    if (source === "peer") expect(wire.received.filter(item => item.event === "delivery_stage" && item.payload.delivery_seq === 3 && item.payload.reason === "local_policy_disabled")).toHaveLength(1);
    console.log(JSON.stringify({ native_policy: { engine: "codex", source, credentialed_turns: 0, trace, methods: rpcs().map(item => item.method) } }));
  } finally {
    held?.end("cleanup"); if (child.exitCode === null) child.kill("SIGTERM"); await exit;
    await wire.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
