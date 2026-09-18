import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, it, vi } from "vitest";
import { ServerLink } from "@kaoiro/wrapper-core";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";
import { materializeLocalImages } from "../src/upload.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

type Request = { model: string; reasoning: { effort: string }; input: Array<{ type?: string; role?: string; content?: Array<Record<string, unknown>> }> };
// Real CLI startup can make outward update requests. Analytics/plugins are off;
// model/auth use loopback, and the Phoenix peer is a test wire fixture, not Phoenix.
it.each([null, "low"])("runs the default app backend through real ServerLink sync/rejoin, queued turns, policy, images, rollback and MCP interrupt (initial override=%s)", async initialOverride => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-host-live-")), codexHome = join(home, ".codex");await mkdir(codexHome);
  // Image sweeping is keyed by agent ID across processes, not isolated HOME.
  const agentId = `live-host-${randomUUID()}`;
  const wire = await phoenixLoopback(), requests: Request[] = [];
  let held: ServerResponse | undefined, rejectModel = false, toolSignal: AbortSignal | undefined;
  const respond = (response: ServerResponse, tool = false) => {
    const id = `response-${requests.length}`;
    const output = tool ? [{ type: "custom_tool_call", id, call_id: id, name: "exec", status: "completed",
      input: 'const result = await tools.mcp__kaoiro__probe({}); text(result);' }] : [{ type: "message", id, role: "assistant", phase: "final_answer", status: "completed",
      content: [{ type: "output_text", text: "DONE", annotations: [] }] }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((item, output_index) => [{ type: "response.output_item.added", output_index, item }, { type: "response.output_item.done", output_index, item }]),
      { type: "response.completed", response: { id, object: "response", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const provider = createServer(async (request, response) => {
    let body = "";for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as Request;requests.push(parsed);
    const text = parsed.input.filter(i => i.role === "user").at(-1)?.content?.find(c => c.type === "input_text")?.text;
    if (text === "A") { held = response;return; }
    if (rejectModel) { response.writeHead(400, { "content-type": "application/json" });response.end(JSON.stringify({ error: { message: "Rejected model", type: "invalid_request_error" } }));return; }
    respond(response, text === "TOOL_WAIT");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();if (!address || typeof address === "string") throw new Error("No provider port");
  let instructionChain = Promise.resolve(), relays = 0;
  const sync = (revision: number, network_access: boolean) => {
    const next = { revision, requested: { sandbox: "workspace-write", network_access } };
    return { version: "0", next, control: { ...next, status: "pending", constraints: { approval: "never", enforcement: "os" } } };
  };
  let host: CodexHost | undefined, running: Promise<void> | undefined, link: ServerLink | undefined;
  const ends: Array<Parameters<NonNullable<ConstructorParameters<typeof CodexHost>[1]["onTurnEnd"]>>[0]> = [];
  const permissionWaits: Array<{ ready: boolean }> = [];
  const starts: string[] = [], logs: Envelope[] = [], policies: unknown[] = [], imagePaths: string[] = [];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC", "base64");
  try {
    await writeFile(join(codexHome, "config.toml"), `model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
model_provider = "local"
approvals_reviewer = "auto_review"
[model_providers.local]
name = "Loopback"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
    vi.stubEnv("HOME", home);vi.stubEnv("CODEX_HOME", codexHome);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(key, undefined);
    link = new ServerLink(wire.url, agentId, { personaId: "p", permissionSync: { engine: "codex", onSync: message => host!.applyPermissionSync(message) },
      onSetPermission: selection => { void host!.setPermission(selection).then(() => { relays += 1; }); },
      onInstruction: (text, ids) => { instructionChain = instructionChain.then(() => host!.send(text, ids, [], text)); } });
    expect(await link.waitForPermissionSyncNegotiation()).toBe(true);
    const config: WrapperConfig = { agent_id: agentId, persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: wire.url,
      model: "gpt-5.6-sol", effort: "high", sandbox: "workspace-write", network_access: false, codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus" };
    host = new CodexHost(config, { backend: "app-server", appendSystemPrompt: "HOST_PERSONA", permissionSyncSupported: true,
      waitForPermissionSync: () => {
        const wait = { ready: false };permissionWaits.push(wait);
        return link!.waitForPermissionSync().then(() => { wait.ready = true; });
      },
      onState: e => link!.send(e), onLog: e => { logs.push(e);link!.send(e); }, onSessionId: id => link!.setSessionId(id),
      onTurnStart: ({ turnToken }) => { starts.push(turnToken);link!.acknowledgeInterAgentDelivery(starts.length); },
      onTurnEnd: info => ends.push(info), onPermissionLifecycle: event => { if (event.kind === "permission_applied") policies.push(event.details); },
      materializeImages: async (...args) => { const result = await materializeLocalImages(...args);imagePaths.push(...result.paths);return result; },
      toolDescriptors: [{ name: "probe", description: "Hold until scope abort", inputSchema: { type: "object", properties: {} }, handler: async (_input, context) => {
        toolSignal = context?.signal;
        await new Promise<void>(resolve => { if (toolSignal?.aborted) resolve();else toolSignal?.addEventListener("abort", () => resolve(), { once: true }); });
        return { content: [{ type: "text", text: "ABORTED" }] };
      } }],
    });
    host.attachOpen({ upload_id: "image", filename: "image.png", mime: "image/png", size: png.length, chunks: 1 });
    const chunk = Buffer.alloc(4 + 5 + 4 + png.length);chunk.writeUInt32BE(5, 0);chunk.write("image", 4);chunk.writeUInt32BE(0, 9);png.copy(chunk, 13);
    host.attachChunk(chunk);host.attachClose("image");
    if (initialOverride !== null) await host.setEffort(initialOverride);
    running = host.run();
    wire.push("instruction", { version: "0", text: "A", attachment_ids: ["image"] });
    wire.push("instruction", { version: "0", text: "B" });wire.push("instruction", { version: "0", text: "C" });
    wire.push("permission_sync", { version: "0", control: null, next: {} });
    await vi.waitFor(() => expect(permissionWaits.length > 0 || starts.length > 0).toBe(true), { timeout: 25_000 });
    expect(requests).toHaveLength(0);expect(starts).toHaveLength(0);
    expect(permissionWaits.at(-1)?.ready).toBe(false);
    expect(wire.received.filter(r => r.event === "delivery_ack")).toHaveLength(0);
    wire.push("permission_sync", sync(1, false));
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 25_000 });
    expect(requests[0]?.reasoning.effort).toBe(initialOverride ?? "high");expect(starts).toEqual(["A"]);
    const url = requests[0]?.input.filter(i => i.role === "user").at(-1)?.content?.find(c => c.type === "input_image")?.image_url;
    try {
      expect(typeof url).toBe("string");expect(Buffer.from(String(url).split(",")[1]!, "base64")).toEqual(png);
    } catch (error) {
      const paths = await Promise.all(imagePaths.map(async path => ({ path, exists: await access(path).then(() => true, () => false) })));
      throw new Error(JSON.stringify({ agentId, userContent: requests[0]?.input.filter(i => i.role === "user").at(-1)?.content, paths }), { cause: error });
    }
    expect(imagePaths).toHaveLength(1);expect(imagePaths.every(isAbsolute)).toBe(true);
    await host.setEffort("low");wire.push("set_permission", { version: "0", revision: 2, sandbox: "workspace-write", network_access: true });
    await vi.waitFor(() => expect(relays).toBe(1));
    wire.drop();await vi.waitFor(() => expect(wire.joins).toBe(2), { timeout: 10_000 });
    const waitsBeforeNextTurn = permissionWaits.length;
    respond(held!);await vi.waitFor(() => expect(ends).toHaveLength(1));
    await vi.waitFor(() => expect(permissionWaits.length > waitsBeforeNextTurn || starts.length > 1).toBe(true), { timeout: 25_000 });
    expect(requests).toHaveLength(1);expect(starts).toEqual(["A"]);
    expect(permissionWaits.at(-1)?.ready).toBe(false);
    wire.push("permission_sync", sync(2, true));
    await vi.waitFor(() => expect(ends).toHaveLength(3), { timeout: 10_000 });expect(starts).toEqual(["A", "B", "C"]);
    expect(ends.every(e => e.terminal === "turn.completed")).toBe(true);
    expect(requests[1]?.reasoning.effort).toBe("low");
    expect(policies).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, network_access: false }), expect.objectContaining({ revision: 2, network_access: true })]));
    await expect(access(imagePaths[0]!)).rejects.toThrow();
    rejectModel = true;await host.setModel("gpt-6-astra");await host.send("FAIL");await vi.waitFor(() => expect(ends).toHaveLength(4), { timeout: 10_000 });
    expect(ends[3]?.terminal).toBe("turn.failed");rejectModel = false;
    await host.send("RESTORE");await vi.waitFor(() => expect(ends).toHaveLength(5), { timeout: 10_000 });
    expect(requests.at(-1)).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "low" } });
    await host.send("TOOL_WAIT", undefined, [], "tool");await host.send("AFTER", undefined, [], "after");
    await vi.waitFor(() => expect(toolSignal).toBeDefined(), { timeout: 25_000 });expect(toolSignal?.aborted).toBe(false);
    expect(host.requestInterruptForTurn("wrong")).toBe(false);expect(host.requestInterruptForTurn("tool")).toBe(true);
    expect(toolSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(ends).toHaveLength(7), { timeout: 10_000 });
    expect(ends[5]).toMatchObject({ error: { reason: "interrupted" } });expect(ends[5]).not.toHaveProperty("terminal");
    expect(ends[6]?.terminal).toBe("turn.completed");expect(logs.filter(e => e.type === "result")).toHaveLength(7);
  } finally {
    host?.close();await running;link?.close();await wire.close();provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));vi.unstubAllEnvs();await rm(home, { recursive: true, force: true });
  }
}, 90_000);
