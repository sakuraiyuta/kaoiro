import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_LOG_BYTES, makeResult } from "@kaoiro/agent-common";
import { projectAppServerTurn, type AppServerProjection } from "../src/app_server_projection.js";
import { AppServerConnectionError, type AppServerNotification, type RpcObject } from "../src/app_server_rpc.js";

const identity = { threadId: "thread", turnId: "turn", hostTurnToken: "host", requestId: 73, clientUserMessageId: "client" };
const event = (method: string, params: RpcObject = {}): AppServerNotification => ({
  method, params: { threadId: identity.threadId, turnId: identity.turnId, ...params },
});
const item = (type: string, id: string, fields: RpcObject = {}) => ({ type, id, ...fields });
const started = (value: RpcObject) => event("item/started", { item: value });
const completed = (value: RpcObject) => event("item/completed", { item: value });
const terminal = (status = "completed", fields: RpcObject = {}) => event("turn/completed", {
  turn: { id: identity.turnId, status, items: [], itemsView: "summary", ...fields },
});
const answer = (id: string, text: string, phase: unknown = "final_answer") => completed(item("agentMessage", id, { text, phase }));
function project(events: AppServerNotification[]) {
  return projectAppServerTurn({ identity, events: (async function* () { yield* events; })() });
}
async function collect(events: AsyncIterable<AppServerProjection>) {
  const result: AppServerProjection[] = [];
  for await (const e of events) result.push(e);
  return result;
}
const logs = (events: AppServerProjection[]) => events.flatMap(e => e.kind === "log" ? [e.payload] : []);
const results = (events: AppServerProjection[]) => events.filter(e => e.kind === "result");
const adapters = (events: AppServerProjection[]) => events.flatMap(e => e.kind === "adapter" ? [e.event] : []);

describe("app-server result and progress projection", () => {
  it("projects the captured pinned-CLI compaction without requiring thread/compacted", async () => {
    const capture = JSON.parse(readFileSync(new URL("./fixtures/app_server_compaction.json", import.meta.url), "utf8")) as {
      binarySha256: string; events: AppServerNotification[];
    };
    expect(capture.binarySha256).toBe("56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da");
    const start = capture.events.find(e => e.method === "item/started")!;
    const params = start.params;
    const actualIdentity = { ...identity, threadId: params.threadId as string, turnId: params.turnId as string };
    const projected = projectAppServerTurn({ identity: actualIdentity, events: (async function* () { yield* capture.events; })() });
    const out = await collect(projected.events);
    const itemId = (params.item as RpcObject).id;
    expect(out.filter(e => e.kind === "compaction")).toEqual([
      { kind: "compaction", phase: "started", itemId }, { kind: "compaction", phase: "completed", itemId },
    ]);
    expect(results(out)).toEqual([{ kind: "result", status: "completed", payload: { is_error: false } }]);
  });
  it("keeps native usage snapshots across terminal completion and isolates consumers", async () => {
    const counts = { inputTokens: 2000, cachedInputTokens: 30, outputTokens: 70, reasoningOutputTokens: 2, totalTokens: 2070 };
    const usage = { last: counts, total: { ...counts, totalTokens: 4000 }, modelContextWindow: 1000 };
    const turn = project([event("thread/tokenUsage/updated", { tokenUsage: usage }),
      event("thread/tokenUsage/updated", { turnId: "foreign", tokenUsage: { ...usage, modelContextWindow: 9999 } }),
      event("thread/tokenUsage/updated", { tokenUsage: {} }), terminal()]);
    expect(turn.usage).toBeNull();
    const first = await turn.events.next();
    expect(first.value).toMatchObject({ kind: "usage", snapshot: { last: { inputTokens: 2000 }, total: { totalTokens: 4000 }, modelContextWindow: 1000 } });
    if (first.value?.kind === "usage") first.value.snapshot.last.inputTokens = 99;
    await collect(turn.events);
    expect(turn.usage).toEqual({ last: { ...counts, cacheWriteInputTokens: 0 }, total: { ...counts, totalTokens: 4000, cacheWriteInputTokens: 0 }, modelContextWindow: 1000 });
    const copy = turn.usage!; copy.last.inputTokens = 0;
    expect(turn.usage!.last.inputTokens).toBe(2000);
  });

  it.each([false, true])("confirms one compaction item pair at terminal success with legacy companion=%s", async legacy => {
    const compact = item("contextCompaction", "compact");
    const extra = legacy ? [event("thread/compacted")] : [];
    const turn = project([started(compact), started(compact), ...extra, completed(compact), completed(compact), ...extra, terminal()]);
    expect((await turn.events.next()).value).toEqual({ kind: "compaction", phase: "started", itemId: "compact" });
    const rest = await collect(turn.events);
    expect(rest.filter(e => e.kind === "compaction")).toEqual([{ kind: "compaction", phase: "completed", itemId: "compact" }]);
    expect(results(rest)).toHaveLength(1);
  });

  it("does not invent compaction completion from legacy-only, incomplete, failed, or foreign evidence", async () => {
    const compact = item("contextCompaction", "compact");
    for (const raw of [
      [event("thread/compacted"), terminal()], [started(compact), event("thread/compacted"), terminal()],
      [completed(compact), terminal()], [started(compact), completed(compact), terminal("failed")],
      [started(compact), completed(compact), terminal("interrupted")],
      [started(compact), event("item/completed", { turnId: "foreign", item: compact }), terminal()],
    ]) expect((await collect(project(raw).events)).filter(e => e.kind === "compaction" && e.phase === "completed")).toEqual([]);
    await expect(collect(project([started(compact), completed(compact)]).events)).rejects.toThrow("without a terminal");
  });
  it("retains two final answers and waits for the sole terminal instead of replacing history with its summary", async () => {
    const raw = [answer("a", "FIRST"), completed(item("functionCallOutput", "external", { name: "external", output: "JOINED" })),
      answer("b", "SECOND"), terminal("completed", { items: [item("agentMessage", "b", { text: "SECOND" })] }), terminal()];
    const turn = project(raw);
    expect(turn.identity).toBe(identity);
    const first = await turn.events.next();
    expect(first.value).toEqual({ kind: "log", payload: { kind: "assistant", text: "FIRST" } });
    const rest = await collect(turn.events);
    expect(logs(rest)).toEqual([{ kind: "tool_result", tool_use_id: "external", output: "JOINED" }, { kind: "assistant", text: "SECOND" }]);
    expect(results(rest)).toEqual([{ kind: "result", status: "completed", payload: { text: "SECOND", is_error: false } }]);
    expect(adapters(rest)).toEqual([{ kind: "result", subtype: "success" }]);
  });

  it("requires both thread and turn identity before admitting items or terminals", async () => {
    const raw = [
      event("item/completed", { threadId: "child", item: item("agentMessage", "a", { text: "CHILD" }) }),
      event("item/completed", { turnId: "old", item: item("agentMessage", "b", { text: "OLD" }) }),
      event("turn/completed", { threadId: "child", turn: { id: "turn", status: "failed" } }),
      event("turn/completed", { turnId: "old", turn: { id: "old", status: "failed" } }),
      answer("a", "OWN"), terminal(),
    ];
    const out = await collect(project(raw).events);
    expect(logs(out)).toEqual([{ kind: "assistant", text: "OWN" }]);
    expect(results(out)).toEqual([{ kind: "result", status: "completed", payload: { text: "OWN", is_error: false } }]);
  });

  it("deduplicates starts and completions per item and per turn, including late deltas", async () => {
    const command = item("commandExecution", "cmd", { command: "pwd", status: "inProgress" });
    const finish = { ...command, status: "completed", exitCode: 0, aggregatedOutput: "/work" };
    const raw = [event("turn/started", { turn: { id: "turn" } }), event("turn/started", { turn: { id: "turn" } }),
      started(command), started(command), completed(finish), completed(finish), started(command),
      answer("a", "ONCE"), answer("a", "CHANGED"), event("item/agentMessage/delta", { itemId: "a", delta: "late" }), terminal()];
    for (let i = 0; i < 2; i += 1) {
      const out = await collect(project(raw).events);
      expect(logs(out)).toEqual([
        { kind: "tool_use", tool_use_id: "cmd", tool_name: "shell", input: { command: "pwd" } },
        { kind: "tool_result", tool_use_id: "cmd", tool_name: "shell", output: "/work" },
        { kind: "assistant", text: "ONCE" },
      ]);
      expect(adapters(out)).toEqual([
        { kind: "assistant", blocks: ["thinking"] }, { kind: "assistant", blocks: ["tool_use"], toolUseIds: ["cmd"] },
        { kind: "tool_result", toolUseIds: ["cmd"] }, { kind: "result", subtype: "success" },
      ]);
    }
  });

  it("uses phase-aware final text while retaining commentary in the transcript", async () => {
    const out = await collect(project([answer("a", "FINAL"), answer("b", "COMMENT", "commentary"), answer("c", "UNKNOWN", null), terminal()]).events);
    expect(logs(out).map(l => l.text)).toEqual(["FINAL", "COMMENT", "UNKNOWN"]);
    expect(results(out)[0]?.payload.text).toBe("FINAL");
    expect(results(await collect(project([answer("a", "ONE", null), answer("b", "TWO", null), terminal()]).events))[0]?.payload.text).toBe("TWO");
    expect(results(await collect(project([answer("a", "ONLY COMMENT", "commentary"), terminal()]).events))[0]?.payload).not.toHaveProperty("text");
  });

  it.each(["completed", "failed", "interrupted"] as const)("preserves terminal status %s and ignores retryable error notifications", async status => {
    const out = await collect(project([event("error", { willRetry: true, error: { message: "retry" } }),
      answer("a", "partial"), terminal(status, status === "failed" ? { error: { message: "failure" } } : {})]).events);
    expect(results(out)).toEqual([{ kind: "result", status, payload: {
      text: "partial", is_error: status !== "completed",
      ...(status === "completed" ? {} : { error_subtype: status === "failed" ? "error_during_execution" : "interrupted",
        error_detail: status === "failed" ? "failure" : "App-server turn interrupted" }),
    } }]);
  });

  it("never infers success from an EOF, a retry error, or an invalid terminal status", async () => {
    for (const raw of [[], [answer("a", "FINAL")], [event("error", { willRetry: false, error: { message: "fatal" } })], [terminal("inProgress")]]) {
      await expect(collect(project(raw).events)).rejects.toBeInstanceOf(AppServerConnectionError);
    }
    const broken = projectAppServerTurn({ identity, events: (async function* () { yield answer("a", "partial"); throw new Error("transport EOF"); })() });
    await expect(collect(broken.events)).rejects.toThrow("transport EOF");
  });

  it("emits progress for deltas without turning chunks into duplicate logs", async () => {
    const out = await collect(project([
      started(item("reasoning", "r")), event("item/reasoning/summaryTextDelta", { itemId: "r", delta: "think" }),
      event("item/reasoning/textDelta", { itemId: "r", delta: "more" }), completed(item("reasoning", "r")),
      started(item("agentMessage", "a", { text: "" })), event("item/agentMessage/delta", { itemId: "a", delta: "A" }),
      event("item/agentMessage/delta", { itemId: "a", delta: "B" }), answer("a", "AB"), terminal(),
    ]).events);
    expect(logs(out)).toEqual([{ kind: "assistant", text: "AB" }]);
    expect(adapters(out).filter(e => e.kind === "assistant")).toHaveLength(6);
  });

  it("reuses exec tool projections while handling app-server file start and declined statuses", async () => {
    const file = item("fileChange", "f", { status: "inProgress", changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "private diff" }] });
    const mcp = item("mcpToolCall", "m", { server: "kaoiro", tool: "probe", status: "inProgress", arguments: { text: "PING" } });
    const search = item("webSearch", "s", { query: "test" });
    const command = item("commandExecution", "c", { command: "false", status: "inProgress" });
    const out = await collect(project([started(file), completed({ ...file, status: "declined" }),
      started(mcp), completed({ ...mcp, status: "completed", result: { content: [{ type: "text", text: "OK" }, { type: "image", data: "IGNORED" }, null] } }),
      started(search), completed(search), started(command), completed({ ...command, status: "failed", aggregatedOutput: "bad", exitCode: 1 }),
      completed({ ...mcp, id: "error", status: "failed", error: { message: "MCP ERROR" } }), terminal()]).events);
    expect(logs(out)).toEqual([
      { kind: "tool_use", tool_use_id: "f", tool_name: "edit", input: { changes: [{ path: "a.ts", kind: "update" }] } },
      { kind: "tool_result", tool_use_id: "f", tool_name: "edit", output: "failed: update a.ts" },
      { kind: "tool_use", tool_use_id: "m", tool_name: "mcp__kaoiro__probe", input: { text: "PING" } },
      { kind: "tool_result", tool_use_id: "m", tool_name: "mcp__kaoiro__probe", output: "OK" },
      { kind: "tool_use", tool_use_id: "s", tool_name: "web_search", input: { query: "test" } },
      { kind: "tool_result", tool_use_id: "s", tool_name: "web_search", output: "" },
      { kind: "tool_use", tool_use_id: "c", tool_name: "shell", input: { command: "false" } },
      { kind: "tool_result", tool_use_id: "c", tool_name: "shell", output: "(exit 1)\nbad" },
      { kind: "tool_result", tool_use_id: "error", output: "MCP ERROR" },
    ]);
    expect(adapters(out).filter(e => e.kind === "tool_result")).toHaveLength(5);
  });

  it.each(["item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/mcpToolCall/progress"])("projects %s as tool progress without duplicate transcript rows", async method => {
    const progress = event(method, { itemId: "t", delta: "chunk", message: "progress" });
    const out = await collect(project([progress,
      completed(item("mcpToolCall", "t", { server: "s", tool: "t", arguments: {}, status: "completed", result: { content: [{ type: "text", text: "COMPLETE" }] } })),
      progress, terminal(),
    ]).events);
    expect(logs(out)).toEqual([{ kind: "tool_result", tool_use_id: "t", output: "COMPLETE" }]);
    expect(adapters(out)).toEqual([
      { kind: "assistant", blocks: ["tool_use"], toolUseIds: ["t"] }, { kind: "tool_result", toolUseIds: ["t"] },
      { kind: "result", subtype: "success" },
    ]);
  });

  it("ignores unknown or malformed items without fabricating tools", async () => {
    const invalid = [item("future", "u"), item("collabAgentToolCall", "child"), item("agentMessage", "a", { text: 42 }),
      item("fileChange", "f", { status: "completed", changes: [{ path: "x", kind: "update" }] }),
      item("commandExecution", "c", { command: "x", status: "future" }), item("mcpToolCall", "m", { status: "completed" }),
      { type: "agentMessage", text: "NO ID" }, null];
    const out = await collect(project([...invalid.flatMap(value => [event("item/started", { item: value }), event("item/completed", { item: value })]), terminal()]).events);
    expect(logs(out)).toEqual([]);
    expect(adapters(out)).toEqual([{ kind: "result", subtype: "success" }]);
  });

  it("retains only textual function outputs and normalizes bounded plan snapshots", async () => {
    const out = await collect(project([completed(item("functionCallOutput", "f", { name: "external", output: [
      { type: "input_text", text: "ONE" }, { type: "input_image", image_url: "SECRET" }, { type: "input_text", text: "TWO" },
    ] })), event("turn/plan/updated", { plan: Array.from({ length: 52 }, (_, i) => ({ step: "x".repeat(400), status: i === 0 ? "inProgress" : "completed" })) }),
    event("turn/plan/updated", { plan: [{ step: "BAD", status: "future" }] }), terminal()]).events);
    expect(logs(out)).toEqual([{ kind: "tool_result", tool_use_id: "f", output: "ONE\nTWO" }]);
    expect(out.filter(e => e.kind === "tasklist")).toEqual([{ kind: "tasklist", snapshot: {
      items: Array.from({ length: 50 }, (_, i) => ({ text: "x".repeat(256), status: i === 0 ? "in_progress" : "completed" })),
      omitted: { count: 2, completed: 2 },
    } }]);
  });

  it("shares log/result bounds and makeResult error redaction without changing exec", async () => {
    const out = await collect(project([answer("a", "x".repeat(MAX_LOG_BYTES * 2)), terminal("failed", { error: { message: "Authorization: Bearer secret_token\n" + "e".repeat(MAX_LOG_BYTES * 2) } })]).events);
    expect(logs(out)[0]).toMatchObject({ kind: "assistant", truncated: true });
    const result = results(out)[0]!;
    expect(Buffer.byteLength(result.payload.text!)).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(result.payload.error_detail).not.toContain("secret_token");
    const envelope = makeResult({ agent_id: "agent", persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" }, display_name: "Fuji", server_url: "ws://localhost" }, "2026-09-18T00:00:00Z", result.payload);
    expect(envelope.payload.text).toBe(result.payload.text);
    expect(envelope.payload.error_detail).not.toContain("secret_token");
    expect(envelope.state).toBe("error");
  });
});
