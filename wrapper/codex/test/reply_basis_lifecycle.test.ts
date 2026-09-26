import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { ServerLink } from "@kaoiro/wrapper-core";
import { InterAgentTool, handoffToolResult, type Envelope } from "@kaoiro/agent-common";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

type PhoenixSocket = ReturnType<NonNullable<ConstructorParameters<typeof ServerLink>[3]>>;
type Channel = ReturnType<PhoenixSocket["channel"]>;
const { Socket } = createRequire(new URL("../../core/package.json", import.meta.url))("phoenix") as {
  Socket: new (url: string, options: unknown) => PhoenixSocket;
};

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const config = { agent_id: "self", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P", server_url: "ws://localhost" };
const args = { to: "peer", conversation_id: "cid", kind: "response" as const, body: "reply" };

async function fixture(options: { join?: (n: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
  reject?: () => Record<string, unknown> | undefined; reply?: (event: string) => Record<string, unknown> | Promise<Record<string, unknown>>; defaultSocket?: boolean; timeout?: number; afterWait?: () => Promise<void> } = {}) {
  const wire = await phoenixLoopback(options.join ?? (() => ({ inter_agent_reply_basis: "v1" })), options.reply ?? (() => ({})),
    event => event === "phx_join" ? options.reject?.() : undefined);
  let mode: "v1" | "legacy" | "pending" = "pending", socket!: PhoenixSocket;
  const linkOptions = { personaId: "p", interAgentReplyBasis: "v1" as const, onReplyBasisMode: (m: typeof mode) => { mode = m; } };
  const link = options.defaultSocket ? new ServerLink(wire.url, "self", linkOptions) : new ServerLink(wire.url, "self", linkOptions, (url, opts) => {
    socket = new Socket(url, { ...opts, timeout: options.timeout ?? 100, rejoinAfterMs: () => 100, reconnectAfterMs: () => 100 });
    return socket;
  });
  const diagnostics: Record<string, unknown>[] = [];
  const tool = new InterAgentTool({ onReplyDiagnostic: d => { diagnostics.push(d); }, config, getState: () => "thinking", send: e => link.send(e),
    replyBasisMode: () => mode, replyBasisGeneration: () => link.replyBasisGeneration(),
    waitReplyBasisMode: async signal => { const result = await link.waitForReplyBasisMode(signal); await options.afterWait?.(); return result; }, sendInterAgent: (e, gen) => link.sendInterAgent(e, gen),
  });
  const abort = new AbortController(); tool.beginReplyInput("T", abort.signal);
  const invoke = () => tool.invoke(args, { origin: { token: "T", signal: abort.signal } });
  return { wire, link, tool, abort, invoke, diagnostics, mode: () => mode,
    socket: () => socket as PhoenixSocket & { conn: WebSocket; channels: Channel[] },
    sent: () => wire.received.filter(x => x.event === "envelope" && x.payload.type === "inter_agent_message"),
    async close() { abort.abort(); tool.endReplyInput("T"); link.close(); await wire.close(); },
  };
}
function waiting(f: Awaited<ReturnType<typeof fixture>>) {
  let done = 0;
  const mode = f.link.waitForReplyBasisMode().then(x => { done++; return x; });
  const first = f.invoke().then(x => { done++; return x; });
  const queued = f.invoke().then(x => { done++; return x; });
  return { mode, first, queued, done: () => done };
}
async function noSend(w: ReturnType<typeof waiting>, code: string) {
  await vi.waitFor(() => expect(w.done()).toBe(3), { timeout: 1500 });
  for (const result of [await w.first, await w.queued]) {
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ error: code, send_not_attempted: true });
    if (code === "reply_basis_closed") expect(body.guidance).toContain("A new wrapper connection is required");
  }
}

it.each(["v1", "legacy"] as const)("initial %s join releases direct and CID waiters", async mode => {
  const join = deferred<Record<string, unknown>>(); const f = await fixture({ join: () => join.promise, timeout: 1000 });
  try {
    const w = waiting(f); expect(w.done()).toBe(0);
    join.resolve(mode === "v1" ? { inter_agent_reply_basis: "v1" } : {});
    expect(await w.mode).toBe(mode); expect((await w.first).isError).toBeUndefined(); expect((await w.queued).isError).toBeUndefined();
    expect(f.sent()).toHaveLength(2); expect(f.link.replyBasisGeneration()).toBeGreaterThan(0);
  } finally { join.resolve({}); await f.close(); }
});

it.each(["phx_close", "server-kick", "channel-leave", "link-close", "normal-socket-close"])("%s is terminal for existing and future waiters", async event => {
  const join = deferred<Record<string, unknown>>(); const f = await fixture({ join: () => join.promise, defaultSocket: event === "phx_close", timeout: 1000 });
  try {
    await vi.waitFor(() => expect(f.wire.joins).toBe(1)); const generation = f.link.replyBasisGeneration(); const w = waiting(f);
    if (event === "link-close") f.link.close();
    else if (event === "channel-leave") f.socket().channels[0]!.leave();
    else if (event === "normal-socket-close") f.wire.closeNormally();
    else f.wire.push("phx_close", event === "server-kick" ? { reason: "revoked" } : {});
    await noSend(w, "reply_basis_closed"); expect(await w.mode).toBe("closed");
    expect(await f.link.waitForReplyBasisMode()).toBe("closed");
    expect(JSON.stringify(await f.invoke())).toContain("reply_basis_closed");
    expect(f.link.replyBasisGeneration()).toBeGreaterThan(generation);
    join.resolve({ inter_agent_reply_basis: "v1" });
    // A late join reply must not revive a removed or explicitly closed channel.
    await new Promise(r => setTimeout(r, 250));
    expect(await f.link.waitForReplyBasisMode()).toBe("closed"); expect(f.wire.joins).toBe(1); expect(f.sent()).toHaveLength(0);
  } finally { join.resolve({}); await f.close(); }
});

it.each(["phx_error", "abnormal-socket-close", "socket-error"])("%s recovers through the real Phoenix rejoin path", async event => {
  const next = deferred<Record<string, unknown>>();
  const f = await fixture({ join: n => n === 1 ? { inter_agent_reply_basis: "v1" } : next.promise, timeout: 1000 });
  try {
    await vi.waitFor(() => expect(f.mode()).toBe("v1")); const generation = f.link.replyBasisGeneration();
    if (event === "phx_error") f.wire.push("phx_error", {});
    else if (event === "abnormal-socket-close") f.wire.drop();
    else f.socket().conn.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(f.mode()).toBe("pending")); const w = waiting(f);
    await vi.waitFor(() => expect(f.wire.joins).toBe(2)); expect(w.done()).toBe(0); expect(f.sent()).toHaveLength(0);
    next.resolve({ inter_agent_reply_basis: "v1" });
    expect(await w.mode).toBe("v1"); expect((await w.first).isError).toBeUndefined(); expect((await w.queued).isError).toBeUndefined();
    expect(f.sent()).toHaveLength(2); expect(f.link.replyBasisGeneration()).toBeGreaterThan(generation);
  } finally { next.resolve({}); await f.close(); }
});

it.each(["join-error", "join-timeout"])("%s releases failed waits, drains CID waiters, then permits a later join", async event => {
  let failing = true;
  const stalled = deferred<Record<string, unknown>>();
  const f = await fixture({ join: () => failing && event === "join-timeout" ? stalled.promise : { inter_agent_reply_basis: "v1" },
    reject: () => failing && event === "join-error" ? { reason: "fixture denied" } : undefined });
  try {
    const w = waiting(f); await noSend(w, "reply_basis_pending"); expect(await w.mode).toBe("pending"); expect(f.sent()).toHaveLength(0);
    failing = false;
    await vi.waitFor(() => expect(f.mode()).toBe("v1"), { timeout: 1500 });
    expect(f.wire.joins).toBeGreaterThan(1); expect((await f.invoke()).isError).toBeUndefined(); expect(f.sent()).toHaveLength(1);
  } finally { stalled.resolve({}); await f.close(); }
});

it.each(["leave", "kick"])("unrecognized server %s event is not a Phoenix channel close", async event => {
  const f = await fixture();
  try {
    expect(await f.link.waitForReplyBasisMode()).toBe("v1"); const gen = f.link.replyBasisGeneration();
    f.wire.push(event, {}); expect((await f.invoke()).isError).toBeUndefined();
    expect(f.link.replyBasisGeneration()).toBe(gen); expect(f.sent()).toHaveLength(1); expect(f.wire.joins).toBe(1);
  } finally { await f.close(); }
});

it("abort releases only its callers, including the CID queue, without poisoning negotiation", async () => {
  const join = deferred<Record<string, unknown>>(); const f = await fixture({ join: () => join.promise, timeout: 1000 });
  try {
    const mode = f.link.waitForReplyBasisMode(f.abort.signal); const first = f.invoke(), queued = f.invoke();
    const gen = f.link.replyBasisGeneration(); f.abort.abort();
    expect(await mode).toBe("pending");
    for (const r of await Promise.all([first, queued])) expect(JSON.parse(r.content[0]!.text)).toMatchObject({ error: "stale_tool_call", send_not_attempted: true });
    expect(f.link.replyBasisGeneration()).toBe(gen); expect(f.sent()).toHaveLength(0);
    join.resolve({ inter_agent_reply_basis: "v1" }); expect(await f.link.waitForReplyBasisMode()).toBe("v1");
    f.tool.beginReplyInput("U");
    expect((await f.tool.invoke(args, { origin: { token: "U" } })).isError).toBeUndefined(); expect(f.sent()).toHaveLength(1);
  } finally { join.resolve({}); await f.close(); }
});

it("a silent join has a fixed deadline and a finite same-CID queue", async () => {
  const join = deferred<Record<string, unknown>>(); const f = await fixture({ join: () => join.promise, timeout: 60_000 });
  try {
    const w = waiting(f);
    await vi.waitFor(() => expect(w.done()).toBe(3), { timeout: 22_000, interval: 50 });
    await noSend(w, "reply_basis_pending"); expect(await w.mode).toBe("pending"); expect(f.sent()).toHaveLength(0);
  } finally { join.resolve({}); await f.close(); }
}, 25_000);


it("a failed wait cannot borrow a join that succeeds before its continuation", async () => {
  let failing = true, waiting = false;
  const resume = deferred<void>();
  const f = await fixture({ reject: () => failing ? { reason: "fixture denied" } : undefined,
    afterWait: async () => { waiting = true; await resume.promise; } });
  try {
    const call = f.invoke(); await vi.waitFor(() => expect(waiting).toBe(true));
    failing = false; await vi.waitFor(() => expect(f.mode()).toBe("v1")); resume.resolve();
    expect(JSON.parse((await call).content[0]!.text)).toMatchObject({ error: "reply_basis_pending", send_not_attempted: true });
    expect(f.sent()).toHaveLength(0);
    expect((await f.invoke()).isError).toBeUndefined(); expect(f.sent()).toHaveLength(1);
  } finally { resume.resolve(); await f.close(); }
});

it.each(["join-error", "phx_close"])("%s renews a waiter ticket only for definite recoverable nonacceptance", async event => {
  let failing = false;
  const f = await fixture({ reject: () => failing ? { reason: "fixture denied" } : undefined });
  try {
    expect(await f.link.waitForReplyBasisMode()).toBe("v1");
    const context = { origin: { token: "T", signal: f.abort.signal } };
    const first = f.tool.invoke({ ...args, wait_for_response: true, timeout_ms: 1000 }, context);
    await vi.waitFor(() => expect(f.sent()).toHaveLength(1));
    const input: Envelope = { version: "0", agent_id: "peer", persona: config.persona, display_name: "P",
      ts: "2026-09-26T00:00:00Z", type: "inter_agent_message", state: "thinking", ext: {},
      payload: { to: "self", conversation_id: "cid", turn_number: 3, kind: "response", body: "observed input",
        meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" }, new_conversation: false } };
    await f.tool.receiveInbound(input);
    const result = await first; expect(handoffToolResult(result, () => {})).toBe(true);
    const auth = JSON.parse(result.content[0]!.text).reply_authorization;
    expect(auth.in_reply_to).toBe(3);
    failing = true; f.wire.push(event === "phx_close" ? "phx_close" : "phx_error", {});
    await vi.waitFor(() => expect(f.mode()).toBe("pending"));
    const rejected = await f.tool.invoke({ ...args, ...auth }, context);
    const body = JSON.parse(rejected.content[0]!.text);
    expect(body).toMatchObject({ error: event === "phx_close" ? "reply_basis_closed" : "reply_basis_pending", send_not_attempted: true });
    expect(f.sent()).toHaveLength(1);
    if (event === "phx_close") { expect(body.reply_authorization).toBeUndefined(); return; }
    expect(body.reply_authorization.in_reply_to).toBe(3);
    expect(body.reply_authorization.reply_ticket).not.toBe(auth.reply_ticket);
    failing = false; await vi.waitFor(() => expect(f.mode()).toBe("v1"));
    const premature = await f.tool.invoke({ ...args, ...body.reply_authorization }, context);
    expect(JSON.parse(premature.content[0]!.text).error).toBe("invalid_reply_ticket"); expect(f.sent()).toHaveLength(1);
    expect(handoffToolResult(rejected, () => {})).toBe(true);
    expect((await f.tool.invoke({ ...args, ...body.reply_authorization }, context)).isError).toBeUndefined();
    expect(f.sent()).toHaveLength(2); expect(f.sent()[1]!.payload.payload).toMatchObject({ in_reply_to: 3 });
  } finally { await f.close(); }
});

it("channel close preserves unknown for a written push but drains its CID successor locally", async () => {
  const ack = deferred<Record<string, unknown>>();
  const f = await fixture({ reply: event => event === "envelope" ? ack.promise : {} });
  try {
    expect(await f.link.waitForReplyBasisMode()).toBe("v1");
    const first = f.invoke(); await vi.waitFor(() => expect(f.sent()).toHaveLength(1));
    const queued = f.invoke(); f.wire.push("phx_close", {});
    const firstResult = await first;
    expect(JSON.stringify(firstResult)).toContain("unknown");
    expect(JSON.stringify(firstResult)).not.toContain("send_not_attempted");
    expect(JSON.parse((await queued).content[0]!.text)).toMatchObject({ error: "reply_basis_closed", send_not_attempted: true });
    expect(f.sent()).toHaveLength(1);
  } finally { ack.resolve({}); await f.close(); }
});


it.each(["join-error", "phx_close"])("internal notice reports definite no-send after %s without borrowing later readiness", async event => {
  let failing = true, waiting = false;
  const resume = deferred<void>(); const join = deferred<Record<string, unknown>>();
  const f = await fixture({ join: () => event === "phx_close" ? join.promise : { inter_agent_reply_basis: "v1" },
    reject: () => event === "join-error" && failing ? { reason: "fixture denied" } : undefined,
    afterWait: async () => { waiting = true; await resume.promise; } });
  try {
    const notice: Envelope = { version: "0", agent_id: "self", persona: config.persona, display_name: "P", ts: "2026-09-26T00:00:00Z",
      type: "inter_agent_message", state: "thinking", ext: {}, payload: { conversation_id: "cid", turn_number: 1, body: "notice" } };
    f.tool.sendInternalNotice(notice);
    if (event === "phx_close") { await vi.waitFor(() => expect(f.wire.joins).toBe(1)); f.wire.push("phx_close", {}); }
    await vi.waitFor(() => expect(waiting).toBe(true));
    if (event === "join-error") { failing = false; await vi.waitFor(() => expect(f.mode()).toBe("v1")); }
    resume.resolve();
    await vi.waitFor(() => expect(f.diagnostics).toContainEqual(expect.objectContaining({ event: "internal_notice_rejected", disposition: "rejected",
      reason: event === "phx_close" ? "reply_basis_closed" : "reply_basis_pending", send_not_attempted: true })));
    expect(f.sent()).toHaveLength(0);
  } finally { resume.resolve(); join.resolve({}); await f.close(); }
});
