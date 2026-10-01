// Exercise the production CLI, host, session, and coordinator over a scripted
// app-server connection.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";
import { CodexHost, type CodexHostOptions } from "../src/host.js";
import { AppServerSession } from "../src/app_server_session.js";
import { CodexInterAgentTurnCoordinator } from "../src/inter_agent_turn_coordinator.js";
import type { RpcObject } from "../src/app_server_rpc.js";

const config: WrapperConfig = { agent_id: "self.agent", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
  server_url: "ws://localhost:4000/wrapper", model: "gpt-5.6-sol", effort: "high", codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.restoreAllMocks(); });

function inbound(seq: number, cid: string, body: string, granted: "early" | "normal"): Envelope {
  return { version: "0", agent_id: "peer.agent", persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer", ts: "2026-10-01T00:00:00Z", type: "inter_agent_message", state: "tool_running",
    delivery_seq: seq,
    payload: { to: "self.agent", conversation_id: cid, turn_number: 2, kind: "inform", body,
      meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" },
      new_conversation: false,
      delivery_authority: { requested: granted, granted },
      notice_attribution: "v1" } satisfies InterAgentMessagePayload,
    ext: {} } as Envelope;
}

async function compose(options: { holdSteerWrite?: boolean; steerOutcome?: "P" | "E" } = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough(), sent: RpcObject[] = [];
  let number = 0;
  let heldSteerWrite: (() => void) | undefined;
  const settledWriteStates: string[] = [];
  const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
  let coordinator: CodexInterAgentTurnCoordinator | undefined;
  const originalReserve = CodexInterAgentTurnCoordinator.prototype.reserveSteer;
  vi.spyOn(CodexInterAgentTurnCoordinator.prototype, "reserveSteer")
    .mockImplementation(function (this: CodexInterAgentTurnCoordinator, ...args) {
      coordinator = this;
      return originalReserve.call(this, ...args);
    });
  const stdin = new Writable({ write(chunk, _encoding, cb) {
    const request = JSON.parse(String(chunk)) as RpcObject; sent.push(request);
    const reply = (result: unknown) => send({ id: request.id, result });
    if (request.method === "initialize") reply({ userAgent: "test/0.156.1" });
    if (request.method === "thread/start") reply({ thread: { id: "thread" }, model: "gpt-5.6-sol", reasoningEffort: "medium" });
    if (request.method === "account/rateLimits/read") send({ id: request.id, error: { code: -32600, message: "no account" } });
    if (request.method === "config/read") reply({ config: { model_reasoning_effort: "low" } });
    if (request.method === "turn/start") {
      number += 1;
      const id = `turn-${number}`;
      reply({ turn: { id } }); send({ method: "turn/started", params: { threadId: "thread", turn: { id } } });
    }
    if (request.method === "turn/steer") {
      send({ id: request.id, error: options.steerOutcome === "P"
        ? { code: -32600, message: "cannot steer a compact turn",
          data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } } } }
        : { code: -32600, message: options.steerOutcome === "E" ? "invalid request" : "no active turn to steer" } });
      if (options.holdSteerWrite) { heldSteerWrite = cb; return; }
    }
    cb();
  } });
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); stdout.end(); stderr.end(); queueMicrotask(() => child.emit("close", 0, null));
  };
  stdin.on("finish", exit); child.kill = vi.fn(() => { exit(); return true; });

  let linkOptions!: Record<string, any>;
  let hostOptions!: CodexHostOptions;
  let host: CodexHost | undefined;
  const retired: Envelope[] = [];
  const link = { close: () => {}, currentSessionId: () => null, send: () => {},
    deliveryModes: () => ({ version: "v1", early: "steer", yield: "none", stage_reports: true }),
    noticeAttributionMode: () => "v1",
    deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
    replyBasisGeneration: () => 1, setSessionId: () => {},
    permissionSyncPending: () => false,
    sendInterAgent: async () => ({ kind: "accepted" }),
    reportDeliveryStage: () => {},
    acknowledgeInterAgentDelivery: () => {},
    retireInterAgentDeliveries: (envelopes: readonly Envelope[]) => { retired.push(...envelopes); return true; },
    flushInterAgentRetirements: async () => {},
    reportDisconnectIntent: async () => {},
  };
  const signals = process.listeners("SIGINT");
  const cli = runCodexCli({ backend: "app-server",
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (hostConfig, options) => {
      const o0 = options as CodexHostOptions;
      hostOptions = o0;
      const created = new CodexHost(hostConfig, { ...o0, backend: "app-server",
        appServerSessionFactory: o => AppServerSession.create({ ...o, transport: { spawnChild: () => child, shutdownTimeoutMs: 100 } }) });
      const originalSteer = created.steerInterAgentInput.bind(created);
      vi.spyOn(created, "steerInterAgentInput").mockImplementation((text, hooks, batchId) =>
        originalSteer(text, { ...hooks, onSettle: (...args) => {
          settledWriteStates.push(args[4]);
          hooks.onSettle(...args);
        } }, batchId));
      host = created;
      return created as never;
    },
    prepareStartup: async () => {},
  });
  cleanup.push(async () => {
    heldSteerWrite?.();
    host?.close(); await cli.catch(() => {});
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
  });
  await vi.waitFor(() => expect(host).toBeDefined());
  linkOptions.onReplyBasisMode("v1");
  linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
  const byMethod = (method: string) => sent.filter(r => r.method === method);
  const texts = (method: string) => byMethod(method).map(r => (r.params as { input: { text: string }[] }).input[0]?.text ?? "");
  const terminal = () => send({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${number}`, status: "completed" } } });
  const completedSteerItem = (index: number, text: string) => {
    const clientId = (byMethod("turn/steer")[index]?.params as { clientUserMessageId: string }).clientUserMessageId;
    send({ method: "item/completed", params: { threadId: "thread", turnId: `turn-${number}`,
      item: { type: "userMessage", id: `u-${clientId}`, clientId, content: [{ type: "text", text }] } } });
  };
  const assertQuiescent = () => {
    expect(host!.pendingInterAgentPlaceholderCount).toBe(0);
    expect(coordinator?.pendingSteerReservationCount).toBe(0);
  };
  return { host: host!, hostOptions, linkOptions, byMethod, texts, terminal, completedSteerItem, retired, assertQuiescent,
    settledWriteStates, releaseSteerWrite: () => { heldSteerWrite?.(); heldSteerWrite = undefined; },
    get coordinator() { return coordinator; } };
}

async function scenario(successors: number, successorBody?: string) {
  const f = await compose();
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await vi.waitFor(() => expect(f.host.state).not.toBe("idle"));
  await f.linkOptions.onInterAgentMessage(inbound(1, "cid", "EARLY BODY", "early"));
  await vi.waitFor(() => expect(f.byMethod("turn/steer")).toHaveLength(1));
  for (let i = 0; i < successors; i++) {
    await f.linkOptions.onInterAgentMessage(inbound(2 + i, `succ-${i}`, successorBody ?? `SUCCESSOR ${i}`, "normal"));
  }
  expect(f.byMethod("turn/steer")).toHaveLength(1);
  expect(f.byMethod("turn/start")).toHaveLength(1);
  f.terminal();
  return f;
}

it("Kohaku review control: a precondition-rejected steer falls back into its placeholder", async () => {
  const f = await scenario(0);
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2), { timeout: 3000 });
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  f.assertQuiescent();
});

it("attaches a precondition placeholder before the running turn settles", async () => {
  const f = await compose();
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await f.linkOptions.onInterAgentMessage(inbound(1, "cid", "EARLY BODY", "early"));
  await vi.waitFor(() => expect(f.host.pendingInterAgentPlaceholderCount).toBe(1));
  expect(f.byMethod("turn/start")).toHaveLength(1);
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  f.assertQuiescent();
});

it("a completed item after precondition rejection prevents fallback replay", async () => {
  const f = await compose();
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await f.linkOptions.onInterAgentMessage(inbound(1, "cid", "EARLY BODY", "early"));
  await vi.waitFor(() => expect(f.host.pendingInterAgentPlaceholderCount).toBe(1));
  f.completedSteerItem(0, f.texts("turn/steer")[0]!);
  f.terminal();
  await vi.waitFor(() => { f.assertQuiescent(); });
  expect(f.byMethod("turn/start")).toHaveLength(1);
  await f.host.send("LATER ROOT", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toContain("LATER ROOT");
});

it("keeps a P fallback in its original slot while the RPC write callback is pending", async () => {
  const f = await compose({ holdSteerWrite: true, steerOutcome: "P" });
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await f.linkOptions.onInterAgentMessage(inbound(1, "cid", "EARLY BODY", "early"));
  await vi.waitFor(() => expect(f.host.pendingInterAgentPlaceholderCount).toBe(1));
  await f.linkOptions.onInterAgentMessage(inbound(2, "successor", "SUCCESSOR BODY", "normal"));
  f.terminal();
  await vi.waitFor(() => expect(f.settledWriteStates).toEqual(["writing"]));
  f.assertQuiescent();
  expect(f.retired).toHaveLength(0);
  f.releaseSteerWrite();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  expect(f.texts("turn/start")[1]).not.toContain("SUCCESSOR BODY");
  f.terminal();
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(3));
  expect(f.texts("turn/start")[2]).toContain("SUCCESSOR BODY");
  f.assertQuiescent();
});

it("removes an E reservation while the RPC write callback is pending", async () => {
  const f = await compose({ holdSteerWrite: true, steerOutcome: "E" });
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await f.linkOptions.onInterAgentMessage(inbound(1, "cid", "EARLY BODY", "early"));
  await vi.waitFor(() => expect(f.byMethod("turn/steer")).toHaveLength(1));
  f.terminal();
  await vi.waitFor(() => expect(f.settledWriteStates).toEqual(["writing"]));
  f.assertQuiescent();
  expect(f.retired).toHaveLength(0);
  f.releaseSteerWrite();
  await f.host.send("LATER ROOT", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toContain("LATER ROOT");
  expect(f.texts("turn/start")[1]).not.toContain("EARLY BODY");
  f.assertQuiescent();
});

it("Kohaku review control: one queued successor stays behind the fallback", async () => {
  const f = await scenario(1);
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2), { timeout: 3000 });
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  expect(f.texts("turn/start")[1]).not.toContain("SUCCESSOR");
  f.assertQuiescent();
});

it("Kohaku review: a full successor batch must not strand the fallback placeholder", async () => {
  const f = await scenario(10);
  await vi.waitFor(() => expect(f.byMethod("turn/start").length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  expect(f.texts("turn/start")[1]).not.toContain("SUCCESSOR");
  f.assertQuiescent();
});

it("Kohaku review control: nine successors stay behind the fallback", async () => {
  const f = await scenario(9);
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2), { timeout: 3000 });
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  expect(f.texts("turn/start")[1]).not.toContain("SUCCESSOR");
  f.assertQuiescent();
});

it("Kohaku review: two 8 KB successors must not strand the fallback placeholder", async () => {
  const f = await scenario(2, "X".repeat(8_100));
  await vi.waitFor(() => expect(f.byMethod("turn/start").length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  f.assertQuiescent();
});

it("Kohaku review: a stranded placeholder also blocks a later operator root", async () => {
  const f = await scenario(2, "X".repeat(8_100));
  await f.host.send("LATER OPERATOR ROOT", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start").length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
  expect(f.texts("turn/start")[1]).toContain("EARLY BODY");
  f.assertQuiescent();
});

it("removes a fallback slot when its conversation becomes terminal before settlement", async () => {
  const f = await compose();
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  const early = inbound(1, "cid", "EARLY BODY", "early");
  (early.payload as unknown as InterAgentMessagePayload).meta.done = true;
  await f.linkOptions.onInterAgentMessage(early);
  await vi.waitFor(() => expect(f.byMethod("turn/steer")).toHaveLength(1));
  const descriptor = f.hostOptions.toolDescriptors!.find(d => d.name === "send_to_agent")!;
  const result = await descriptor.handler({ to: "peer.agent", kind: "done", body: "done", conversation_id: "cid", done: true },
    { origin: { token: f.host.activeInterAgentTurnToken() } } as never);
  expect(result.isError).not.toBe(true);
  f.terminal();
  await vi.waitFor(() => { f.assertQuiescent(); });
  expect(f.byMethod("turn/start")).toHaveLength(1);
  await f.host.send("LATER ROOT", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toContain("LATER ROOT");
});

it("retires a queued fallback once during watchdog fail-stop", async () => {
  const f = await scenario(10);
  expect(f.host.failStopForWatchdogAttributionUnknown()).toBe(true);
  await f.host.waitForWatchdogCleanup();
  f.assertQuiescent();
  expect(f.byMethod("turn/start")).toHaveLength(1);
  expect(f.host.state).toBe("error");
  expect(f.retired.filter(e => e.payload.conversation_id === "cid")).toHaveLength(1);
});

it("retires a rejected fallback if its exact host slot cannot be replaced", async () => {
  const f = await compose();
  const diagnostic = vi.spyOn(process.stderr, "write");
  const original = f.host.replaceInterAgentPlaceholder.bind(f.host);
  const replacement = vi.spyOn(f.host, "replaceInterAgentPlaceholder").mockImplementation((id, text, cids, token) =>
    text.includes("EARLY BODY") ? false : original(id, text, cids, token));
  await f.host.send("BASE", undefined, undefined, undefined, { source: "operator", intent: "normal" });
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(1));
  await f.linkOptions.onInterAgentMessage(inbound(1, "cid", "EARLY BODY", "early"));
  await vi.waitFor(() => expect(f.byMethod("turn/steer")).toHaveLength(1));
  await f.linkOptions.onInterAgentMessage(inbound(2, "next", "NEXT BODY", "normal"));
  f.terminal();
  await vi.waitFor(() => expect(f.retired.filter(e => e.payload.conversation_id === "cid")).toHaveLength(1));
  await vi.waitFor(() => { f.assertQuiescent(); });
  expect(replacement).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls.some(([chunk]) => String(chunk).includes("inter-agent fallback slot replacement failed"))).toBe(true);
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  expect(f.texts("turn/start")[1]).toContain("NEXT BODY");
  expect(f.texts("turn/start")[1]).not.toContain("EARLY BODY");
});

it("the shared quiescence check detects an orphaned slot and reservation", async () => {
  const f = await scenario(0);
  await vi.waitFor(() => expect(f.byMethod("turn/start")).toHaveLength(2));
  f.assertQuiescent();
  const coordinator = f.coordinator!;
  const orphan = inbound(1, "orphan", "ORPHAN", "early");
  expect(f.host.createInterAgentPlaceholder("orphan", 1)).toBe(true);
  expect(() => f.assertQuiescent()).toThrow();
  f.host.removeInterAgentPlaceholder("orphan");
  f.assertQuiescent();
  expect(coordinator.reserveSteer("orphan", orphan, "reply-owed", 1)).toBe(true);
  expect(() => f.assertQuiescent()).toThrow();
  coordinator.discardSteerReservation("orphan");
  f.assertQuiescent();
});
