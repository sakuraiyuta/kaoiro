import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import type { AppServerProjection } from "../src/app_server_projection.js";
import { materializeLocalImages, cleanupLocalImages } from "../src/upload.js";

// Real CLI startup inherits outward traffic, including update checks. Analytics
// is off; the provider/auth are local, but offline runners may start more slowly.
it("uses the default session and real MCP bridge for images and instructions across resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-session-"));
  const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
  const diagnostics: string[] = [];
  let toolCalls = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length;
    const item = n % 2 === 1 ? {
      type: "custom_tool_call", id: `fc_${n}`, call_id: `call_${n}`, name: "exec",
      input: 'const result = await tools.mcp__kaoiro__probe({text: "PING"}); text(result);', status: "completed",
    } : {
      type: "message", id: `msg_${n}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "DONE", annotations: [] }], phase: "final_answer",
    };
    const output = n % 2 === 1 ? [item] : [
      { ...item, id: `msg_${n}_first`, content: [{ type: "output_text", text: "FIRST", annotations: [] }] }, item,
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `r${n}`, object: "response", status: "in_progress", output: [] } },
      ...output.flatMap((value, output_index) => [
        { type: "response.output_item.added", output_index, item: { ...value, status: "in_progress" } },
        { type: "response.output_item.done", output_index, item: value },
      ]),
      { type: "response.completed", response: { id: `r${n}`, object: "response", status: "completed", output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  const config = `approvals_reviewer = "auto_review"
model = "gpt-6-astra"
model_provider = "local"
[model_providers.local]
name = "Local integration test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
[analytics]
enabled = false
`;
  let session: AppServerSession | undefined;
  let materialized: Awaited<ReturnType<typeof materializeLocalImages>> | undefined;
  try {
    await writeFile(join(home, "config.toml"), config);
    // A complete 64x64 PNG: decoding is performed by the real CLI.
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC", "base64");
    materialized = await materializeLocalImages("fuji-348-session-test", [{
      meta: { upload_id: "image", filename: "image.png", mime: "image/png", size: imageBytes.length, chunks: 1 },
      chunks: new Map([[0, imageBytes]]), sealed: true, accumulatedBytes: imageBytes.length, addedAt: Date.now(),
    }]);
    const image = materialized.paths[0]!;
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    let threadId: string | undefined;
    for (let index = 1; index <= 2; index += 1) {
      const controller = new AbortController();
      session = await AppServerSession.create({
        thread: { cwd: home, sandbox: "read-only", developerInstructions: "PERSONA_348_ONCE" },
        internalSubagents: index === 1,
        turnSignal: () => controller.signal,
        tools: [{ name: "probe", description: "A probe.",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          handler: async (input, context) => {
            expect(context?.signal?.aborted).toBe(false);
            expect(input).toEqual({ text: "PING" });
            toolCalls += 1;
            return { content: [{ type: "text", text: `BRIDGE_OK_${index}` }] };
          } }],
        transport: { onDiagnostic: message => diagnostics.push(message) },
      });
      threadId = threadId === undefined ? await session.startThread() : await session.resumeThread(threadId);
      const turn = await session.startProjectedTurn({ threadId, hostTurnToken: `host-${index}`, clientUserMessageId: `user-${index}`, input: [
        { type: "text", text: `USER_${index}` }, { type: "local_image", path: image }, { type: "text", text: `AFTER_${index}` },
      ] });
      const events: AppServerProjection[] = [];
      for await (const event of turn.events) events.push(event);
      expect(events.filter(event => event.kind === "result")).toEqual([
        { kind: "result", status: "completed", payload: { text: "DONE", is_error: false } },
      ]);
      expect(events.filter(event => event.kind === "log" && event.payload.kind === "assistant")).toEqual([
        { kind: "log", payload: { kind: "assistant", text: "FIRST" } },
        { kind: "log", payload: { kind: "assistant", text: "DONE" } },
      ]);
      expect(events.some(event => event.kind === "adapter" && event.event.kind === "assistant")).toBe(true);
      // A completed model turn can hide a failed MCP call. Keep both sides of
      // the bridge visible when the CLI behaves differently on a CI runner.
      const toolDiagnostic = JSON.stringify({
        index, toolCalls, events, diagnostics, node: process.version,
        stderrTail: session.stderrTail,
        toolOutputs: requests[index * 2 - 1]?.input.filter(item =>
          item.type === "custom_tool_call_output" || item.type === "function_call_output"),
      }, null, 2);
      expect(events.some(event => event.kind === "log" && event.payload.kind === "tool_use" && event.payload.tool_name === "mcp__kaoiro__probe"), toolDiagnostic).toBe(true);
      expect(events.some(event => event.kind === "log" && event.payload.kind === "tool_result" && event.payload.output?.includes(`BRIDGE_OK_${index}`)), toolDiagnostic).toBe(true);
      expect(turn.identity).toMatchObject({ threadId, hostTurnToken: `host-${index}`, clientUserMessageId: `user-${index}` });
      expect(typeof turn.identity.requestId).toBe("number");
      expect(typeof turn.identity.turnId).toBe("string");
      expect(toolCalls).toBe(index);
      expect(requests).toHaveLength(index * 2);
      const beforeTool = requests[index * 2 - 2]!;
      const developer = JSON.stringify(beforeTool.input.filter(item => item.role === "developer"));
      expect(developer.match(/PERSONA_348_ONCE/g)).toHaveLength(1);
      const user = beforeTool.input.filter(item => item.role === "user").at(-1)!;
      const serializedUser = JSON.stringify(user);
      expect(serializedUser).toContain(`USER_${index}`);
      const content = user.content as Array<{ type: string; image_url?: string }>;
      const images = content.filter(item => item.type === "input_image");
      expect(images).toHaveLength(1);
      const encodedImage = images[0]!.image_url!.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      expect(encodedImage).not.toBeNull();
      expect(Buffer.from(encodedImage![1]!, "base64")).toEqual(imageBytes);
      expect(serializedUser.indexOf(`USER_${index}`)).toBeLessThan(serializedUser.indexOf("data:image/"));
      expect(serializedUser.indexOf("data:image/")).toBeLessThan(serializedUser.indexOf(`AFTER_${index}`));
      expect(JSON.stringify(requests[index * 2 - 1])).toContain(`BRIDGE_OK_${index}`);
      expect(session.stderrTail).not.toMatch(/unknown.config/i);
      await session.close();
      await expect(access(image)).resolves.toBeUndefined();
    }
    expect(diagnostics).toEqual([]);
    const contexts: Record<string, unknown>[] = [];
    const sessions = join(home, "sessions");
    for (const path of (await readdir(sessions, { recursive: true })).filter(p => p.endsWith(".jsonl"))) {
      for (const line of (await readFile(join(sessions, path), "utf8")).trim().split("\n")) {
        const record = JSON.parse(line);
        if (record.type === "turn_context") contexts.push(record.payload);
      }
    }
    expect(contexts).toHaveLength(2);
    for (const context of contexts) expect(context).toMatchObject({ approval_policy: "never", approvals_reviewer: "user" });
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
    expect(await readdir(home)).not.toContain("auth.json");
  } finally {
    await session?.close();
    if (materialized) await cleanupLocalImages(materialized.dir, message => { throw new Error(message); });
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
