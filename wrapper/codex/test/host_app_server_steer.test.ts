import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost, type CodexHostOptions } from "../src/host.js";
import { AppServerSession } from "../src/app_server_session.js";
import type { RpcObject } from "../src/app_server_rpc.js";

const config: WrapperConfig = { agent_id: "host-steer", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
  server_url: "ws://unused", model: "gpt-5.6-sol", effort: "high", codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn();vi.restoreAllMocks(); });

type SteerReply = (request: RpcObject, reply: (value: unknown) => void, error: (code: number, message: string, data?: unknown) => void) => void;

function fixture(optIn = true, extra: Partial<CodexHostOptions> = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), sent: RpcObject[] = [];
  let number = 0;
  let holdStart: (() => void) | null = null, holdStarts = false;
  let onSteer: SteerReply = (request, reply) => reply({ turnId: (request.params as { expectedTurnId: string }).expectedTurnId });
  const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  const stdin = new Writable({ write(chunk, _encoding, cb) {
    const request = JSON.parse(String(chunk)) as RpcObject;sent.push(request);
    const reply = (result: unknown) => send({ id: request.id, result });
    if (request.method === "initialize") reply({ userAgent: "test/0.156.1" });
    if (request.method === "thread/start") reply({ thread: { id: "thread" }, model: "gpt-5.6-sol", reasoningEffort: "medium" });
    if (request.method === "account/rateLimits/read") send({ id: request.id, error: { code: -32600, message: "no account" } });
    if (request.method === "config/read") reply({ config: { model_reasoning_effort: "low" } });
    if (request.method === "turn/start") {
      number += 1;
      const id = `turn-${number}`;
      const respond = () => { reply({ turn: { id } });send({ method: "turn/started", params: { threadId: "thread", turn: { id } } }); };
      if (holdStarts) holdStart = respond; else respond();
    }
    if (request.method === "turn/steer") onSteer(request, reply, (code, message, data) =>
      send({ id: request.id, error: { code, message, ...(data === undefined ? {} : { data }) } }));
    if (request.method === "turn/interrupt") { reply({});send({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${number}`, status: "interrupted" } } }); }
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });child.emit("exit", 0, null);stdout.end();stderr.end();queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit);child.kill = vi.fn(() => { exit();return true; });
  const logs: Envelope[] = [], rejected: Envelope[] = [];
  let available = true, syncPending = false, blocked = false;
  const options: CodexHostOptions = { backend: "app-server", appendSystemPrompt: "PERSONA",
    appServerSessionFactory: options => AppServerSession.create({ ...options, transport: { spawnChild: () => child, shutdownTimeoutMs: 100 } }),
    onState: () => {}, onLog: e => logs.push(e), onInstructionRejected: e => rejected.push(e),
    permissionSyncPending: () => syncPending, liveInputBlocked: () => blocked, ...extra };
  if (optIn) options.operatorSteer = { available: () => available };
  const host = new CodexHost(config, options);
  const running = host.run();cleanup.push(async () => { host.close();await running; });
  const byMethod = (method: string) => sent.filter(r => r.method === method);
  const texts = (method: string) => byMethod(method).map(r => (r.params as { input: { text: string }[] }).input[0]?.text);
  const system = () => logs.flatMap(e => (e.payload as { kind?: string; text?: string }).kind === "system" ? [(e.payload as { text: string }).text] : []);
  const operator = (text: string, intent: "early" | "normal" = "early", attachmentIds?: string[]) =>
    host.send(text, attachmentIds, undefined, undefined, { source: "operator", intent });
  const terminal = (status = "completed") => send({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${number}`, status } } });
  const inputItem = (clientId: string) => send({ method: "item/started", params: { threadId: "thread", turnId: `turn-${number}`,
    item: { type: "userMessage", id: `u-${clientId}`, clientId, content: [] } } });
  const completedItem = (clientId: string, text: string) => send({ method: "item/completed", params: { threadId: "thread", turnId: `turn-${number}`,
    item: { type: "userMessage", id: `u-${clientId}`, clientId, content: [{ type: "text", text }] } } });
  const clientId = (index: number) => (byMethod("turn/steer")[index]?.params as { clientUserMessageId: string }).clientUserMessageId;
  return { host, sent, logs, rejected, send, exit, byMethod, texts, system, operator, terminal, inputItem, completedItem, clientId,
    get number() { return number; },
    set onSteer(fn: SteerReply) { onSteer = fn; },
    set holdStarts(value: boolean) { holdStarts = value; },
    releaseStart() { const release = holdStart;holdStart = null;release?.(); },
    set available(value: boolean) { available = value; }, set syncPending(value: boolean) { syncPending = value; },
    set blocked(value: boolean) { blocked = value; } };
}

async function running(f: ReturnType<typeof fixture>) {
  await f.operator("BASE", "normal");
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await vi.waitFor(() => expect(f.host.state).not.toBe("idle"));
}

const turnChanged = (_: RpcObject, __: (value: unknown) => void, error: (code: number, message: string) => void) =>
  error(-32600, "no active turn to steer");

const iaHooks = () => ({ admit: () => null, onAdmit: () => {}, onPrecondition: () => false,
  onResponse: () => {}, onItem: () => {}, onTerminal: () => {}, onSettle: () => {} });

it("T15: IA may overtake peer roots twice; operator steering keeps its queue guard", async () => {
  const f = fixture(true, { interAgentSteer: { available: () => true } });
  await running(f);
  for (let index = 0; index < 3; index += 1) await f.host.send(`ROOT-${index}`, undefined, [`cid-${index}`], `root-${index}`);
  await f.operator("OPERATOR EARLY");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
  expect(f.system()).toContain("Operator input queued for the next turn (behind_earlier_input).");
  // The operator fallback is also a real queued operator input, and must block IA.
  expect(await f.host.steerInterAgentInput("PEER BLOCKED", iaHooks(), "blocked"))
    .toEqual({ kind: "queued", reason: "behind_earlier_input" });
});

it("T15b: a write counts once even when three peer roots are waiting", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } }); await running(f);
  for (let index = 0; index < 3; index += 1) await f.host.send(`ROOT-${index}`, undefined, [`cid-${index}`], `root-${index}`);
  for (let index = 0; index < 2; index += 1) {
    expect((await f.host.steerInterAgentInput(`EARLY-${index}`, iaHooks(), `early-${index}`)).kind).toBe("sent");
  }
  expect(await f.host.steerInterAgentInput("THIRD", iaHooks(), "third")).toEqual({ kind: "queued", reason: "overtake_budget" });
  expect(f.byMethod("turn/steer")).toHaveLength(2);
});

it("T15c: a peer root that starts waiting mid-turn does not charge earlier steers", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } }); await running(f);
  expect((await f.host.steerInterAgentInput("BEFORE", iaHooks(), "before")).kind).toBe("sent");
  await f.host.send("ROOT", undefined, ["cid"], "root");
  for (let index = 0; index < 2; index += 1) {
    expect((await f.host.steerInterAgentInput(`AFTER-${index}`, iaHooks(), `after-${index}`)).kind).toBe("sent");
  }
  expect(f.byMethod("turn/steer")).toHaveLength(3);
});

it("T15d: the overtake budget belongs to the token and is reset at terminal", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } }); await running(f);
  await f.host.send("ROOT-1", undefined, ["cid-1"], "root-1");
  await f.host.send("ROOT-2", undefined, ["cid-2"], "root-2");
  for (let index = 0; index < 2; index += 1) await f.host.steerInterAgentInput(`OLD-${index}`, iaHooks(), `old-${index}`);
  f.terminal(); await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toBe("ROOT-1");
  for (let index = 0; index < 2; index += 1) {
    expect((await f.host.steerInterAgentInput(`NEW-${index}`, iaHooks(), `new-${index}`)).kind).toBe("sent");
  }
});

it("T15e: protocol-uncertain writes consume the same overtake budget", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } }); await running(f);
  await f.host.send("ROOT", undefined, ["cid"], "root");
  f.onSteer = (_request, reply) => reply({ turnId: "wrong-turn" });
  for (let index = 0; index < 2; index += 1) await f.host.steerInterAgentInput(`UNCERTAIN-${index}`, iaHooks(), `uncertain-${index}`);
  await new Promise(resolve => setImmediate(resolve));
  expect(await f.host.steerInterAgentInput("THIRD", iaHooks(), "third")).toEqual({ kind: "queued", reason: "overtake_budget" });
});

it.each(["synthetic", "placeholder"] as const)("T12: a queued %s input still blocks IA", async kind => {
  const f = fixture(false, { interAgentSteer: { available: () => true } }); await running(f);
  if (kind === "synthetic") await f.host.send("NOTICE");
  else expect(f.host.createInterAgentPlaceholder("placeholder", 1)).toBe(true);
  expect(await f.host.steerInterAgentInput("EARLY", iaHooks(), "early")).toEqual({ kind: "queued", reason: "behind_earlier_input" });
});

it("steers an operator input into the running turn and reports inclusion", async () => {
  const f = fixture();
  await running(f);
  await f.operator("STEER");
  expect(f.byMethod("turn/steer")).toHaveLength(1);
  expect(f.byMethod("turn/steer")[0]?.params).toMatchObject({ threadId: "thread", expectedTurnId: "turn-1" });
  f.inputItem(f.clientId(0));
  f.terminal();
  await vi.waitFor(() => expect(f.system()).toContain("Operator input was included in the running turn."));
  expect(f.system()).toContain("Operator input accepted into the running turn.");
  expect(f.texts("turn/start")).toEqual(["BASE"]);
});

it("attaches IA to the current turn only after admission and correlates the completed item text", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } });
  await running(f);
  const events: string[] = [];
  const hooks = {
    admit: () => null,
    onAdmit: () => events.push("write"),
    onPrecondition: (_token: string, id: string, arrival: number) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: (_token: string, _id: string, response: { kind: string }) => events.push(`response:${response.kind}`),
    onItem: () => events.push("item"),
    onTerminal: () => events.push("terminal"),
    onSettle: (_token: string, _id: string, response: { kind: string }, observed: boolean) => events.push(`settle:${response.kind}:${observed}`),
  };
  const result = await f.host.steerInterAgentInput("PEER BODY", hooks, "kaoiro-ia-steer:test");
  expect(result).toMatchObject({ kind: "sent", batchId: "kaoiro-ia-steer:test" });
  await vi.waitFor(() => expect(events).toContain("response:A"));
  f.completedItem("wrong-client", "PEER BODY");
  await new Promise(resolve => setImmediate(resolve));
  expect(events).not.toContain("item");
  f.completedItem("kaoiro-ia-steer:test", "PEER BODY");
  f.terminal();
  await vi.waitFor(() => expect(events).toContain("settle:A:true"));
  expect(events).toEqual(["write", "response:A", "item", "terminal", "settle:A:true"]);
  expect(f.texts("turn/start")).toEqual(["BASE"]);
});

it("inserts an exceptional fallback slot at its original arrival before later input", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } });
  await running(f);
  await f.operator("LATER ROOT", "normal");
  expect(f.host.createInterAgentPlaceholder("exceptional", 1.5)).toBe(true);
  expect(f.host.replaceInterAgentPlaceholder("exceptional", "EXCEPTIONAL FALLBACK", ["cid"], "fallback-token")).toBe(true);
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toContain("EXCEPTIONAL FALLBACK");
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(3));
  expect(f.texts("turn/start")[2]).toContain("LATER ROOT");
  expect(f.host.pendingInterAgentPlaceholderCount).toBe(0);
});

it("reconciles a response arriving after terminal without a second turn-end callback", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } });
  await running(f);
  let replyAfterTerminal: ((value: unknown) => void) | undefined;
  f.onSteer = (_request, reply) => { replyAfterTerminal = reply; };
  const events: string[] = [];
  await f.host.steerInterAgentInput("PEER BODY", {
    admit: () => null, onAdmit: () => events.push("write"),
    onPrecondition: (_token, id, arrival) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: (_token, _id, response) => events.push(`response:${response.kind}`),
    onItem: () => events.push("item"),
    onTerminal: () => events.push("terminal"),
    onSettle: (_token, _id, response, observed) => events.push(`settle:${response.kind}:${observed}`),
  }, "kaoiro-ia-steer:late");
  f.completedItem("kaoiro-ia-steer:late", "PEER BODY");
  f.terminal();
  await vi.waitFor(() => expect(events).toContain("terminal"));
  expect(events).not.toContain("settle:A:true");
  replyAfterTerminal?.({ turnId: "turn-1" });
  await vi.waitFor(() => expect(events).toContain("settle:A:true"));
  expect(events).toEqual(["write", "item", "terminal", "response:A", "settle:A:true"]);
});

it("a completed item with the right client ID but wrong text cannot authorize IA", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } });
  await running(f);
  const item = vi.fn(), settle = vi.fn();
  await f.host.steerInterAgentInput("PEER BODY", {
    admit: () => null, onAdmit: () => {},
    onPrecondition: (_token, id, arrival) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: () => {}, onItem: item,
    onTerminal: () => {}, onSettle: settle,
  }, "kaoiro-ia-steer:conflict");
  f.completedItem("kaoiro-ia-steer:conflict", "WRONG BODY");
  f.completedItem("kaoiro-ia-steer:conflict", "PEER BODY");
  f.terminal();
  await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
  expect(item).not.toHaveBeenCalled();
  expect(settle.mock.calls[0]?.[5]).toBe(true);
});

it("limits IA to three writes while preserving the common eight-write cap", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } });
  await running(f);
  const hooks = { admit: () => null, onAdmit: () => {},
    onPrecondition: (_token: string, id: string, arrival: number) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: () => {}, onItem: () => {}, onTerminal: () => {}, onSettle: () => {} };
  for (let index = 0; index < 3; index += 1) {
    expect((await f.host.steerInterAgentInput(`PEER ${index}`, hooks, `kaoiro-ia-steer:${index}`)).kind).toBe("sent");
  }
  expect(await f.host.steerInterAgentInput("PEER 3", hooks, "kaoiro-ia-steer:3"))
    .toEqual({ kind: "queued", reason: "inter_agent_steer_cap" });
  expect(f.byMethod("turn/steer")).toHaveLength(3);
});

it("holds a rejected IA steer at its arrival position before later root input", async () => {
  const f = fixture(false, { interAgentSteer: { available: () => true } });
  await running(f);
  f.onSteer = turnChanged;
  const batchId = "kaoiro-ia-steer:rejected";
  await f.host.steerInterAgentInput("PEER BODY", {
    admit: () => null, onAdmit: () => {},
    onPrecondition: (_token, id, arrival) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: () => {}, onItem: () => {}, onTerminal: () => {},
    onSettle: () => expect(f.host.replaceInterAgentPlaceholder(batchId, "PEER ROOT", ["cid"], "root-token")).toBe(true),
  }, batchId);
  await f.operator("LATER", "normal");
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(3));
  expect(f.texts("turn/start")).toEqual(["BASE", "PEER ROOT", "LATER"]);
});

it("AC-1: after a P response a later operator input queues behind the placeholder (P -> op2 -> T)", async () => {
  const f = fixture();
  await running(f);
  f.onSteer = turnChanged;
  await f.operator("OP1");
  await f.operator("OP2");
  expect(f.byMethod("turn/steer")).toHaveLength(1);
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(3));
  expect(f.texts("turn/start")).toEqual(["BASE", "OP1", "OP2"]);
  expect(f.byMethod("turn/steer")).toHaveLength(1);
});

it("AC-1: a contradicting input item removes the placeholder and op2 goes next (P -> op2 -> O -> T)", async () => {
  const f = fixture();
  await running(f);
  f.onSteer = turnChanged;
  await f.operator("OP1");
  await f.operator("OP2");
  f.inputItem(f.clientId(0));
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")).toEqual(["BASE", "OP2"]);
  expect(f.byMethod("turn/steer")).toHaveLength(1);
  expect(f.system()).toContain("Operator input delivery is unknown (protocol_contradiction); it will not be re-sent.");
});

it("a V response is never resubmitted and does not hold a later input", async () => {
  const f = fixture();
  await running(f);
  let first = true;
  f.onSteer = (request, reply) => {
    reply({ turnId: first ? "turn-other" : (request.params as { expectedTurnId: string }).expectedTurnId });first = false;
  };
  await f.operator("OP1");
  await f.operator("OP2");
  expect(f.byMethod("turn/steer")).toHaveLength(2);
  f.inputItem(f.clientId(1));
  f.terminal();
  await vi.waitFor(() => expect(f.system()).toContain("Operator input delivery is unknown (protocol_violation); it will not be re-sent."));
  expect(f.texts("turn/start")).toEqual(["BASE"]);
});

it("R3 must 2: with the echo present but permission sync pending, nothing is steered", async () => {
  const f = fixture();
  await running(f);
  f.syncPending = true;
  await f.operator("WAIT");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
  expect(f.system()).toContain("Operator input queued for the next turn (pending_settings).");
  f.syncPending = false;
  await f.operator("LATER");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
  expect(f.system()).toContain("Operator input queued for the next turn (behind_earlier_input).");
});

it("re-evaluates every guard at the commit point after waiting for the start response", async () => {
  for (const change of ["reserve", "interrupt"] as const) {
    const f = fixture();
    f.holdStarts = true;
    await f.operator("BASE", "normal");
    await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
    const pending = f.operator("DURING");
    await new Promise(resolve => setImmediate(resolve));
    if (change === "reserve") f.blocked = true;
    else void f.host.interrupt().catch(() => {});
    f.releaseStart();
    await pending;
    expect(f.byMethod("turn/steer"), change).toHaveLength(0);
    await f.host.close();
  }
});

it("a pending session-reset notice keeps later operator input off the running turn", async () => {
  const f = fixture();
  await running(f);
  await f.host.send("RESET FAILED", undefined, undefined, undefined, { source: "reset_notice" });
  await f.operator("AFTER");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
  expect(f.system()).toContain("Operator input queued for the next turn (reset_pending).");
});

it("settles once when a disconnect overlaps close", async () => {
  const f = fixture();
  await running(f);
  f.onSteer = () => {};
  const pending = f.operator("LOST");
  await vi.waitFor(() => expect(f.byMethod("turn/steer")).toHaveLength(1));
  f.exit();
  f.host.close();
  await pending;
  await vi.waitFor(() => expect(f.system().filter(t => t.startsWith("Operator input delivery is unknown"))).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.system().filter(t => t.startsWith("Operator input"))).toEqual(["Operator input delivery is unknown (connection); it will not be re-sent."]);
});

it("queues input with attachments, and never steers with the opt-in unavailable or for normal intent", async () => {
  const f = fixture();
  await running(f);
  await f.operator("WITH IMAGE", "early", ["upload-1"]);
  expect(f.system()).toContain("Operator input queued for the next turn (attachments_not_steerable).");
  await f.operator("NORMAL", "normal");
  const g = fixture(false);
  await running(g);
  await g.operator("NO OPT-IN");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
  expect(g.byMethod("turn/steer")).toHaveLength(0);
});

it("rechecks the echo at the commit point and caps steers per turn", async () => {
  const f = fixture();
  await running(f);
  f.available = false;
  await f.operator("NO ECHO");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
  expect(f.system()).toContain("Operator input queued for the next turn (operator_steer_unavailable).");
  const g = fixture();
  await running(g);
  for (let i = 0; i < 9; i += 1) await g.operator(`S${i}`);
  expect(g.byMethod("turn/steer")).toHaveLength(8);
  expect(g.system()).toContain("Operator input queued for the next turn (steer_cap).");
});

it("G5: a pending model or effort keeps operator input off the running turn", async () => {
  for (const change of ["model", "effort"] as const) {
    const f = fixture();
    await running(f);
    if (change === "model") await f.host.setModel("gpt-5.6-sol");
    else await f.host.setEffort("low");
    await f.operator(`AFTER ${change}`);
    expect(f.byMethod("turn/steer"), change).toHaveLength(0);
    expect(f.system()).toContain("Operator input queued for the next turn (pending_settings).");
  }
});

it("after a foreign turn the next dispatch fails closed and settles every queued entry once", async () => {
  for (const head of ["ia", "operator"] as const) {
    const starts = vi.fn(), ends = vi.fn(), finals = vi.fn();
    const f = fixture(true, { onTurnStart: starts, onTurnEnd: ends, onTurnFinalized: finals });
    await running(f);
    f.send({ method: "turn/started", params: { threadId: "thread", turn: { id: "foreign-1" } } });
    await vi.waitFor(() => expect(f.system()).toContain(
      "The app-server ran a turn this wrapper did not start; steering and new turns are stopped pending operator recovery."));
    const ia = (token: string) => f.host.send(`IA ${token}`, undefined, [`cid-${token}`], token);
    if (head === "ia") { await ia("ia-1");await f.operator("OP", "normal");await ia("ia-2"); }
    else { await f.operator("OP", "normal");await ia("ia-1");await ia("ia-2"); }
    f.terminal();
    await vi.waitFor(() => expect(finals.mock.calls.map(([x]) => x.turnToken)).toEqual(expect.arrayContaining(["ia-1", "ia-2"])));
    await new Promise(resolve => setTimeout(resolve, 50));
    const count = (spy: typeof starts, token: string) => spy.mock.calls.filter(([x]) => x.turnToken === token).length;
    for (const token of ["ia-1", "ia-2"]) {
      expect(count(starts, token), `${head} start ${token}`).toBe(0);
      expect(count(ends, token), `${head} end ${token}`).toBe(1);
      expect(count(finals, token), `${head} final ${token}`).toBe(1);
    }
    expect(f.texts("turn/start"), head).toEqual(["BASE"]);
    expect(f.byMethod("turn/steer")).toHaveLength(0);
    expect(f.host.state, `${head} host state`).toBe("error");
    for (const token of ["ia-1", "ia-2"]) {
      const [end] = ends.mock.calls.filter(([x]) => x.turnToken === token).map(([x]) => x);
      expect(end, `${head} end ${token}`).not.toHaveProperty("terminal");
      expect(end?.error?.detail, `${head} end ${token}`).toContain("did not start");
    }
  }
});

it("fences a foreign turn with IA steering enabled and operator steering disabled", async () => {
  const ends = vi.fn();
  const f = fixture(false, { interAgentSteer: { available: () => true }, onTurnEnd: ends });
  await running(f);
  f.send({ method: "turn/started", params: { threadId: "thread", turn: { id: "foreign-1" } } });
  await vi.waitFor(() => expect(f.system()).toContain(
    "The app-server ran a turn this wrapper did not start; steering and new turns are stopped pending operator recovery."));
  await f.host.send("IA", undefined, ["cid-ia"], "ia-1");
  f.terminal();
  await vi.waitFor(() => expect(ends.mock.calls.map(([end]) => end.turnToken)).toContain("ia-1"));
  expect(f.byMethod("turn/start")).toHaveLength(1);
});


it("a later operator steer cannot overtake a queued peer root", async () => {
  const f = fixture(true, { interAgentSteer: { available: () => true } });
  await running(f);
  await f.host.send("EARLIER PEER ROOT", undefined, ["peer-cid"], "peer-root-token");
  await f.operator("LATER OPERATOR");
  expect(f.byMethod("turn/steer")).toHaveLength(0);
});

it("a later peer steer cannot overtake a queued operator root", async () => {
  const f = fixture(true, { interAgentSteer: { available: () => true } });
  await running(f);
  await f.operator("EARLIER OPERATOR ROOT", "normal");
  const result = await f.host.steerInterAgentInput("LATER PEER", {
    admit: () => null, onAdmit: () => {},
    onPrecondition: (_token, id, arrival) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: () => {}, onItem: () => {},
    onTerminal: () => {}, onSettle: () => {},
  }, "kaoiro-ia-steer:later-peer");
  expect(result).toMatchObject({ kind: "queued", reason: "behind_earlier_input" });
  expect(f.byMethod("turn/steer")).toHaveLength(0);
});

it("a conflicting IA item after precondition rejection releases its placeholder", async () => {
  const f = fixture(true, { interAgentSteer: { available: () => true } });
  await running(f);
  f.onSteer = turnChanged;
  let conflict = false;
  await f.host.steerInterAgentInput("PEER BODY", {
    admit: () => null, onAdmit: () => {},
    onPrecondition: (_token, id, arrival) => f.host.createInterAgentPlaceholder(id, arrival),
    onResponse: () => {}, onItem: () => {}, onTerminal: () => {},
    onSettle: (_token, id, _response, _observed, _write, itemConflict) => {
      conflict = itemConflict;
      f.host.removeInterAgentPlaceholder(id);
    },
  }, "kaoiro-ia-steer:review-conflict");
  await vi.waitFor(() => expect(f.byMethod("turn/steer")).toHaveLength(1));
  f.completedItem("kaoiro-ia-steer:review-conflict", "WRONG BODY");
  await f.operator("LATER ROOT", "normal");
  f.terminal();
  await vi.waitFor(() => expect(conflict).toBe(true));
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")).toEqual(["BASE", "LATER ROOT"]);
});
