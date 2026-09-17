import { describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { readAppServerHistory } from "../src/app_server_history.js";
import { AppServerConnectionError, AppServerRpcError, type RpcObject } from "../src/app_server_rpc.js";
import { MAX_HISTORY } from "../src/history.js";

const config: WrapperConfig = { agent_id: "history", persona: { id: "fuji", name: "Fuji", sprite_set: "fuji" },
  display_name: "Fuji", server_url: "ws://localhost/wrapper" };
const now = () => "2026-09-18T00:00:00Z";
const assistant = (id: string, text = id) => ({ type: "agentMessage", id, text, phase: "final_answer" });
const user = (text: string) => ({ type: "userMessage", id: text, content: [{ type: "text", text }] });
const turn = (items: unknown[], itemsView?: unknown, id = "turn") => ({ id, items, ...(itemsView === undefined ? {} : { itemsView }) });
const thread = (turns: unknown[] = [], historyMode?: unknown) => ({ thread: { id: "thread", sessionId: "family", turns,
  ...(historyMode === undefined ? {} : { historyMode }) } });
const page = (items: unknown[], nextCursor: unknown = null, turnId = "turn") => ({ data: items.map(item => ({ turnId, item })), nextCursor });
function fixture(responses: unknown[]) {
  const request = vi.fn(async (_method: string, _params: RpcObject): Promise<unknown> => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  });
  return { request, read: () => readAppServerHistory(request, "thread", config, now) };
}
const texts = (result: Awaited<ReturnType<typeof readAppServerHistory>>) => result.logs.map(log => (log.payload as { text?: string }).text).filter(Boolean);

describe("app-server history", () => {
  it("reads metadata before full legacy items, defaults absent views, and retains both final answers", async () => {
    const f = fixture([thread(), thread([turn([user("hello"), assistant("first"), assistant("last")])])]);
    const result = await f.read();
    expect(f.request.mock.calls).toEqual([
      ["thread/read", { threadId: "thread", includeTurns: false }],
      ["thread/read", { threadId: "thread", includeTurns: true }],
    ]);
    expect(result.coverage).toBe("full");
    expect(texts(result)).toEqual(["hello", "first", "last"]);
    expect(result.logs.every(log => log.type === "log" && log.session_id === "thread" && log.ts === now() && log.state === "idle")).toBe(true);
  });

  it.each(["summary", "notLoaded"])("discards %s and full siblings rather than mixing snapshots with pages", async view => {
    const f = fixture([thread([], "legacy"), thread([turn([assistant("obsolete")], "full"), turn([assistant("summary")], view, "other")]),
      page([assistant("newer")], "next"), page([assistant("older")])]);
    const result = await f.read();
    expect(texts(result)).toEqual(["older", "newer"]);
    expect(result.coverage).toBe("full");
    expect(f.request.mock.calls.slice(2)).toEqual([
      ["thread/items/list", { threadId: "thread", sortDirection: "desc", limit: MAX_HISTORY }],
      ["thread/items/list", { threadId: "thread", sortDirection: "desc", limit: MAX_HISTORY, cursor: "next" }],
    ]);
  });

  it("uses pages directly for paginated metadata and ignores embedded summaries", async () => {
    const f = fixture([thread([turn([assistant("summary")])], "paginated"), page([assistant("last")], "c"), page([assistant("first")])]);
    expect(texts(await f.read())).toEqual(["first", "last"]);
    expect(f.request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(1);
  });

  it("switches entirely to pages when history mode changes between metadata and full read", async () => {
    const f = fixture([thread(), thread([turn([assistant("old")])], "paginated"), page([assistant("current")])]);
    expect(texts(await f.read())).toEqual(["current"]);
  });

  it("deduplicates overlapping page identities without merging equal item IDs from different turns", async () => {
    const shared = assistant("same");
    const f = fixture([thread([], "paginated"), page([shared], "next", "new"),
      { data: [{ turnId: "new", item: shared }, { turnId: "old", item: shared }], nextCursor: null }]);
    expect(texts(await f.read())).toEqual(["same", "same"]);
  });

  it("deduplicates full items by turn and item identity", async () => {
    const f = fixture([thread(), thread([turn([assistant("same"), assistant("same")]), turn([assistant("same")], "full", "other")])]);
    expect(texts(await f.read())).toEqual(["same", "same"]);
  });

  it("replays only display logs and excludes both IA framing prefixes", async () => {
    const f = fixture([thread(), thread([turn([
      user('[Inter-agent message — to reply, call send_to_agent with conversation_id="id".]\nsecret'),
      user('[Inter-agent message — conversation_id="id": closed]'), user("  "),
      user("ordinary message"), { type: "contextCompaction", id: "compact" }, { type: "reasoning", id: "reason" },
      { type: "hookPrompt", id: "hook" }, { type: "futureTool", id: "future" }, { type: "plan", id: "plan" },
      { type: "result", id: "result", text: "not a log" }, { type: "delivery_ack", id: "ack" },
      { type: "mcpToolCall", id: "mcp", server: "kaoiro", tool: "probe", arguments: {}, status: "completed", result: { content: [{ type: "text", text: "OK" }] } },
      { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/", commandActions: [], status: "inProgress" },
      { type: "fileChange", id: "edit", status: "inProgress", changes: [{ path: "/file", diff: "", kind: { type: "add" } }] },
      { type: "functionCallOutput", id: "output", name: "exec", output: [{ type: "input_text", text: "external" }] },
      assistant("final"),
    ])])]);
    const result = await f.read();
    expect(result.logs.map(log => (log.payload as { kind: string }).kind)).toEqual([
      "user", "tool_use", "tool_result", "tool_use", "tool_use", "tool_result", "assistant",
    ]);
    expect(texts(result)).toEqual(["ordinary message", "final"]);
    expect(result.logs.every(log => log.type === "log")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.logs[2]!.payload).toMatchObject({ output: "OK", tool_name: "mcp__kaoiro__probe" });
  });

  it("caps full history by display rows after filtering, including two rows per completed tool", async () => {
    const items: unknown[] = Array.from({ length: 205 }, (_, n) => assistant(String(n)));
    items.push({ type: "contextCompaction", id: "compact" });
    const f = fixture([thread(), thread([turn(items)])]);
    const result = await f.read();
    expect(result.coverage).toBe("tail");
    expect(texts(result)).toEqual(Array.from({ length: MAX_HISTORY }, (_, n) => String(n + 5)));
    const tools = Array.from({ length: 101 }, (_, n) => ({ type: "commandExecution", id: String(n), command: `echo ${n}`, cwd: "/", commandActions: [], status: "completed", aggregatedOutput: String(n) }));
    const g = fixture([thread(), thread([turn(tools)])]);
    const toolResult = await g.read();
    expect(toolResult.logs).toHaveLength(MAX_HISTORY);
    expect(toolResult.logs[0]!.payload).toMatchObject({ kind: "tool_use", tool_use_id: "1" });
  });

  it("continues past non-display pages and stops at the latest 200 display rows", async () => {
    const items = Array.from({ length: 201 }, (_, n) => assistant(String(200 - n)));
    const f = fixture([thread([], "paginated"), page([{ type: "contextCompaction", id: "compact" }], "a"),
      page(items, "b"), new Error("must not request older pages")]);
    const result = await f.read();
    expect(result.coverage).toBe("tail");
    expect(texts(result)).toEqual(Array.from({ length: MAX_HISTORY }, (_, n) => String(n + 1)));
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it.each([
    [page([assistant("new")], "a"), page([assistant("old")], "a")],
    [page([assistant("new")], "a"), page([], "b")],
    [page([assistant("same")], "a"), page([assistant("same")], "b")],
    [page([assistant("a")], "a"), page([assistant("b")], "b"), page([assistant("c")], "a")],
  ])("stops cursor or identity non-progress with incomplete coverage", async (...pages) => {
    const f = fixture([thread([], "paginated"), ...pages, new Error("unbounded read")]);
    expect(await f.read()).toMatchObject({ coverage: "incomplete", reason: "cursor_stalled" });
    expect(f.request).toHaveBeenCalledTimes(pages.length + 1);
  });

  it("bounds constantly changing cursors independently of display rows", async () => {
    const f = fixture([thread([], "paginated"), ...Array.from({ length: 100 }, (_, n) => page([{ type: "reasoning", id: String(n) }], String(n))), new Error("page budget exceeded")]);
    expect(await f.read()).toEqual({ coverage: "incomplete", reason: "page_limit", logs: [] });
    expect(f.request).toHaveBeenCalledTimes(101);
  });

  it.each([
    [null], [thread([], "future")], [thread([], null)], [{ thread: { id: "other", turns: [] } }],
    [thread(), { thread: { id: "other", turns: [] } }], [thread(), thread([], "future")],
    [thread(), thread([turn([], "future")])], [thread(), thread([turn([], ["full"])])],
    [thread(), thread([turn([{ type: "agentMessage" }])])],
    [thread([], "paginated"), { data: null }], [thread([], "paginated"), page([], 1)],
    [thread([], "paginated"), page([], "")], [thread([], "paginated"), { data: [{ item: assistant("no-turn") }] }],
  ])("does not label malformed or foreign history full: %j", async (...responses) => {
    expect(await fixture(responses).read()).toEqual({ logs: [], coverage: "incomplete", reason: "invalid_response" });
  });

  it("retains only acquired page logs on RPC rejection and keeps disconnect distinct", async () => {
    const rejection = new AppServerRpcError(-32600, "not available");
    expect(await fixture([rejection]).read()).toEqual({ logs: [], coverage: "incomplete", reason: "rpc_rejected" });
    const f = fixture([thread([], "paginated"), page([assistant("known")], "next"), rejection]);
    const result = await f.read();
    expect(result).toMatchObject({ coverage: "incomplete", reason: "rpc_rejected" });
    expect(texts(result)).toEqual(["known"]);
    await expect(fixture([new AppServerConnectionError("EOF")]).read()).rejects.toThrow("EOF");
  });
});

// Required display fields come from pinned stable v2 ThreadItem, UserInput,
// FileUpdateChange and FunctionCallOutputBody, not from converter fallbacks.
const displayItems: Array<{ item: RpcObject; required: string[] }> = [
  { item: { type: "agentMessage", id: "agent", text: "answer" }, required: ["text"] },
  { item: user("question"), required: ["content"] },
  { item: { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/", commandActions: [], status: "completed", aggregatedOutput: "/" }, required: ["command", "cwd", "commandActions", "status"] },
  { item: { type: "fileChange", id: "edit", changes: [{ path: "/file", diff: "", kind: { type: "add" } }], status: "completed" }, required: ["changes", "status"] },
  { item: { type: "mcpToolCall", id: "mcp", server: "kaoiro", tool: "probe", arguments: null, status: "completed", result: { content: [{ type: "text", text: "ok" }] } }, required: ["server", "tool", "arguments", "status"] },
  { item: { type: "webSearch", id: "web", query: "query" }, required: ["query"] },
  { item: { type: "functionCallOutput", id: "output", name: "exec", output: "output" }, required: ["name", "output"] },
];
const invalidDisplayItems: Array<[string, RpcObject]> = displayItems.flatMap(({ item, required }) => required.map(key => {
  const incomplete = { ...item }; delete incomplete[key];
  return [`${item.type} missing ${key}`, incomplete] as [string, RpcObject];
}));
for (const [index, changes] of [
  [0, { text: null }], [1, { content: "not an array" }], [1, { content: [{ type: "text" }] }],
  [1, { content: [{ type: "text", text: 12 }] }], [1, { content: [null] }],
  [1, { content: [{ type: "localImage", path: 1 }] }],
  [2, { command: 1 }], [2, { status: "future" }], [2, { commandActions: null }],
  [2, { aggregatedOutput: {} }], [2, { exitCode: "0" }],
  [3, { changes: {} }], [3, { changes: [{ path: 1, diff: "", kind: { type: "add" } }] }],
  [3, { changes: [{ path: "/f", kind: { type: "add" } }] }],
  [3, { changes: [{ path: "/f", diff: "", kind: { type: "future" } }] }],
  [4, { result: { content: "bad" } }], [4, { error: {} }], [4, { status: "declined" }],
  [5, { query: null }], [6, { output: {} }], [6, { output: [{ type: "input_text" }] }],
  [6, { output: [{ type: "input_text", text: 5 }] }], [6, { output: [null] }],
] as Array<[number, RpcObject]>) {
  invalidDisplayItems.push([`${displayItems[index]!.item.type} ${JSON.stringify(changes)}`, { ...displayItems[index]!.item, ...changes }]);
}

describe.each(["legacy", "page"] as const)("%s known display item decoding", route => {
  const response = (items: unknown[]) => route === "legacy"
    ? [thread(), thread([turn(items)])] : [thread([], "paginated"), page(items)];

  it.each(invalidDisplayItems)("reports incomplete for %s", async (_name, item) => {
    expect(await fixture(response([item])).read()).toEqual({ logs: [], coverage: "incomplete", reason: "invalid_response" });
  });

  it("converts every valid known display family", async () => {
    const items = displayItems.map(value => value.item);
    const f = fixture(response(route === "page" ? [...items].reverse() : items));
    const result = await f.read();
    expect(result.coverage).toBe("full");
    expect(result.logs.map(log => (log.payload as { kind: string }).kind)).toEqual([
      "assistant", "user", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result", "tool_result",
    ]);
  });

  it("ignores future and non-display types without reducing coverage", async () => {
    const result = await fixture(response([
      { id: "future", type: "futureDisplayType", text: null },
      { id: "reason", type: "reasoning", summary: [], content: [] },
      { id: "compact", type: "contextCompaction" },
      { id: "media", type: "userMessage", content: [{ type: "image", url: "image" }, { type: "futureBlock" }, { type: "constructor" }] },
    ])).read();
    expect(result).toEqual({ logs: [], coverage: "full" });
  });
});

it("retains earlier page logs as incomplete when a later page contains an invalid known item", async () => {
  const result = await fixture([thread([], "paginated"), page([assistant("kept")], "next"), page([{ type: "agentMessage", id: "broken" }])]).read();
  expect(result).toMatchObject({ coverage: "incomplete", reason: "invalid_response" });
  expect(texts(result)).toEqual(["kept"]);
});

it("counts ignored page identities as progress and does not mistake valid empty text for corruption", async () => {
  const result = await fixture([thread([], "paginated"), page([{ id: "future", type: "future" }], "next"), page([assistant("empty", "")])]).read();
  expect(result.coverage).toBe("full");
  expect(result.logs).toHaveLength(1);
});


it("does not interpret undeclared status extensions as missing completion on messages", async () => {
  const result = await fixture([thread(), thread([turn([{ ...assistant("answer"), status: "inProgress" }])])]).read();
  expect(result.coverage).toBe("full");
  expect(texts(result)).toEqual(["answer"]);
});
