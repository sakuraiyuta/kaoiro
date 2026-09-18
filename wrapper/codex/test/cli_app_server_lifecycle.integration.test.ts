import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCodexCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";
import { watchdogClock } from "./fixtures/cli_app_server.js";

type Input = { type?: string; role?: string; output?: unknown; content?: { text?: string }[] };
// The provider and Phoenix wire peer are fixtures. CLI, Host, Session, ToolHost,
// IA coordinator/lease/ack, and watchdog clock all use their production defaults.
// The pinned CLI can contact update services; model/auth stay on loopback.
it.each([false, true])("runs CLI components through MCP IA wait, mid-turn batching and dispatch-only acknowledgement (watchdog interrupt=%s)", async interrupt => {
  const clock = watchdogClock();
  const home = await mkdtemp(join(tmpdir(), "fuji-348-cli-ia-"));
  const agentId = `cli-${randomUUID()}`, peer = "peer.agent";
  const wire = await phoenixLoopback(() => ({}), (event) => event === "directory_request"
    ? { agents: [{ agent_id: peer, persona: { id: "p", name: "Peer", sprite_set: "p" }, state: "waiting_input" }], users: [] }
    : { ingress_stamp: [1, 1] });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const requests: Input[][] = [], toolOutputs: unknown[] = [], userTurns: string[] = [];
  let toolIssued = false, held = false;
  const respond = (response: ServerResponse, script?: string) => {
    const id = `response-${requests.length}`;
    const output = script === undefined
      ? [{ type: "message", id, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "DONE", annotations: [] }] }]
      : [{ type: "custom_tool_call", id, call_id: id, name: "exec", status: "completed", input: script }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item }]),
      { type: "response.completed", response: { id, object: "response", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const provider = createServer(async (request, response) => {
    let body = "";for await (const chunk of request) body += chunk;
    const input = (JSON.parse(body) as { input: Input[] }).input;requests.push(input);
    const text = input.filter(i => i.role === "user").at(-1)?.content?.map(c => c.text ?? "").join("\n") ?? "";
    if (input.at(-1)?.role === "user") userTurns.push(text);
    toolOutputs.push(...input.filter(i => i.type === "custom_tool_call_output").map(i => i.output));
    if (!toolIssued) {
      toolIssued = true;
      respond(response, `text(await tools.mcp__kaoiro__list_agents({})); text(await tools.mcp__kaoiro__send_to_agent({to:"${peer}",conversation_id:"c1",kind:"response",body:"WAITING",wait_for_response:true,timeout_ms:10000}));`);
    } else {
      if (text.includes("FIRST")) { held = true;await blocked; }
      respond(response);
    }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();if (!address || typeof address === "string") throw new Error("Missing local port");
  const signals = process.listeners("SIGINT");
  let running: Promise<void> | undefined;
  const outbound = () => wire.received.filter(e => e.event === "envelope" && e.payload.type === "inter_agent_message");
  const results = () => wire.received.filter(e => e.event === "envelope" && e.payload.type === "result");
  const acks = () => wire.received.filter(e => e.event === "delivery_ack").map(e => e.payload.delivery_seq);
  const inbound = (seq: number, cid: string, body: string, from = peer, turn = 1) => wire.push("envelope", {
    version: "0", agent_id: from, persona: { id: "p", name: "Peer", sprite_set: "p" }, display_name: "Peer",
    ts: new Date().toISOString(), type: "inter_agent_message", state: "tool_running", delivery_seq: seq,
    ingress_stamp: [1, seq], payload: { to: agentId, conversation_id: cid, turn_number: turn, kind: "inform", body },
  });
  try {
    await writeFile(join(home, "config.toml"), `model = "gpt-5.6-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Lifecycle test"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\n[features]\nshell_snapshot = false\nplugins = false\n[analytics]\nenabled = false\n`);
    vi.stubEnv("HOME", home);vi.stubEnv("CODEX_HOME", home);
    if (interrupt) vi.stubEnv("KAOIRO_CODEX_TURN_WATCHDOG_INACTIVITY_MS", "60000");
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(key, undefined);
    running = runCodexCli({ ...(interrupt ? { watchdogClock: clock } : {}),
      parseCliArgs: () => ({ configPath: "fixture", prompt: undefined, resume: undefined }),
      loadConfig: () => ({ agent_id: agentId, persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: wire.url, model: "gpt-5.6-sol", codex_backend: "app-server" }),
    });
    await vi.waitFor(() => expect(wire.joins).toBe(1));wire.push("persona_prompt", { prompt: "Lifecycle test" });
    await vi.waitFor(() => expect(wire.received.some(e => e.event === "envelope" && e.payload.type === "state_change")).toBe(true));
    inbound(1, "c1", "FIRST");
    await vi.waitFor(() => expect(outbound().some(e => (e.payload.payload as { body?: string }).body === "WAITING")).toBe(true), { timeout: 35_000 });
    expect(acks()).toEqual([1]);expect(wire.received.some(e => e.event === "directory_request")).toBe(true);
    inbound(2, "c2", "SECOND");inbound(3, "c3", "THIRD");inbound(4, "c4", "OTHER", "other.peer");
    await new Promise(resolve => setTimeout(resolve, 100));expect(acks()).toEqual([1]);expect(userTurns).toHaveLength(1);
    // The live waiter consumes this reply; it must not create another Host turn.
    if (interrupt) {
      clock.advance(60000);
      await vi.waitFor(() => expect(results().length).toBeGreaterThan(0), { timeout: 15_000 });
    } else {
      inbound(5, "c1", "REPLY", peer, 3);
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 15_000 });
      expect(toolOutputs.some(value => JSON.stringify(value).includes("REPLY")), JSON.stringify(toolOutputs)).toBe(true);
      expect(userTurns).toHaveLength(1);expect(results()).toHaveLength(0);
    }
    release();await vi.waitFor(() => expect(results()).toHaveLength(3), { timeout: 25_000 });
    expect(userTurns).toHaveLength(3);
    expect(userTurns[0]).toContain("FIRST");expect(userTurns[1]).toContain("OTHER");
    expect(userTurns[2]).toContain("SECOND");expect(userTurns[2]).toContain("THIRD");
    expect(userTurns[2]!.indexOf("SECOND")).toBeLessThan(userTurns[2]!.indexOf("THIRD"));
    expect(userTurns.filter(text => text.includes("REPLY"))).toHaveLength(0);
    expect(acks().at(-1)).toBe(interrupt ? 4 : 5);
    if (!interrupt) expect(outbound().filter(e => (e.payload.payload as { meta?: { peer_error?: unknown } }).meta?.peer_error)).toHaveLength(0);
  } finally {
    release();
    // Invoke only the handler installed by this CLI lifetime, never unrelated listeners.
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) { listener("SIGINT");process.removeListener("SIGINT", listener); }
    await running;await wire.close();provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));vi.unstubAllEnvs();await rm(home, { recursive: true, force: true });
  }
}, 90_000);
