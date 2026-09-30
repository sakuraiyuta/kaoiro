import { describe, expect, it, vi } from "vitest";
import { PermissionBroker, type PendingPermissionExt, type WrapperConfig } from "@kaoiro/agent-common";
import {
  admit, approvalGate, ApprovalRouter, createApprovalOwner, fileChangeKey, parseApprovalRequest,
  type AdmitFacts, type ApprovalChannel, type ApprovalOwner, type ApprovalTransition, type ParsedApproval,
} from "../src/app_server_approval.js";
import { SERVER_REQUEST_DISABLED, type RpcObject } from "../src/app_server_rpc.js";

const COMMAND = "item/commandExecution/requestApproval";
const FILE = "item/fileChange/requestApproval";

function params(over: RpcObject = {}): RpcObject {
  return { threadId: "th", turnId: "t1", itemId: "i1", startedAtMs: 1, kind: "command", command: "ls", cwd: "/w", ...over };
}
function request(over: RpcObject = {}, method: string = COMMAND): ParsedApproval | null {
  return parseApprovalRequest(method, params(over));
}
function owner(over: { [K in keyof ApprovalOwner]?: ApprovalOwner[K] | undefined } = {}): ApprovalOwner {
  const o = { ...createApprovalOwner("th"), start: { kind: "started", turnId: "t1" }, approvalPolicy: "on-request", ...over } as ApprovalOwner;
  if ("start" in over && over.start === undefined) delete o.start;
  return o;
}
function facts(over: Partial<AdmitFacts> = {}): AdmitFacts {
  return { rpcFailed: false, boundThreadId: "th", owner: owner(), enabled: true, ...over };
}

describe("parseApprovalRequest", () => {
  it("accepts the two routed methods with valid params", () => {
    expect(request()).not.toBeNull();
    expect(parseApprovalRequest(FILE, { threadId: "th", turnId: "t1", itemId: "i1", startedAtMs: 1, reason: null, grantRoot: null })).not.toBeNull();
  });

  it.each([
    ["missing turnId", COMMAND, params({ turnId: undefined })],
    ["non-string threadId", COMMAND, params({ threadId: 7 })],
    ["missing startedAtMs", COMMAND, params({ startedAtMs: undefined })],
    ["an unknown kind", COMMAND, params({ kind: "shell" })],
    ["a non-string command", COMMAND, params({ command: ["ls"] })],
    ["a non-string grantRoot", FILE, params({ grantRoot: 3 })],
    ["non-object params", COMMAND, "x"],
    ["the permissions-profile method", "item/permissions/requestApproval", params()],
    ["an elicitation", "mcpServer/elicitation/request", params()],
    ["a legacy approval", "execCommandApproval", params()],
  ])("rejects %s", (_label, method, raw) => {
    expect(parseApprovalRequest(method, raw)).toBeNull();
  });
});

describe("approvalGate", () => {
  it("is open only when the opt-in, a non-never policy and a routed method all hold", () => {
    expect(approvalGate(true, "on-request", COMMAND)).toBe(true);
    expect(approvalGate(true, "untrusted", FILE)).toBe(true);
  });

  it.each([
    ["opt-in off", false, "on-request", COMMAND],
    ["policy never", true, "never", COMMAND],
    ["policy not yet written", true, undefined, COMMAND],
    ["permissions-profile method", true, "on-request", "item/permissions/requestApproval"],
  ] as const)("closes with only %s", (_label, enabled, policy, method) => {
    expect(approvalGate(enabled, policy, method)).toBe(false);
  });
});

// MC/DC over the decision list: the base input passes every rule and lands on
// rule 10. Each positive case makes only rule k's condition true; its negative
// control flips only that condition back and must leave rule k.
describe("admit decision list", () => {
  const base = { request: request(), facts: facts() };
  const cases: Array<{ rule: number; state: string; label: string; input: { request: ParsedApproval | null; facts: AdmitFacts } }> = [
    { rule: 1, state: "rejected", label: "method outside the allowlist", input: { request: null, facts: facts() } },
    { rule: 2, state: "dropped", label: "rpc failed", input: { request: request(), facts: facts({ rpcFailed: true }) } },
    { rule: 3, state: "rejected", label: "thread mismatch", input: { request: request({ threadId: "other" }), facts: facts() } },
    { rule: 4, state: "rejected", label: "no owner", input: { request: request(), facts: facts({ owner: undefined }) } },
    { rule: 5, state: "dropped", label: "owner aborted", input: { request: request(), facts: facts({ owner: owner({ aborted: true }) }) } },
    { rule: 6, state: "dropped", label: "owner terminal", input: { request: request(), facts: facts({ owner: owner({ terminal: true }) }) } },
    { rule: 7, state: "held", label: "start not set", input: { request: request(), facts: facts({ owner: owner({ start: undefined }) }) } },
    { rule: 8, state: "rejected", label: "start failed", input: { request: request(), facts: facts({ owner: owner({ start: { kind: "failed" } }) }) } },
    { rule: 8, state: "rejected", label: "started another turn", input: { request: request(), facts: facts({ owner: owner({ start: { kind: "started", turnId: "t2" } }) }) } },
    { rule: 9, state: "rejected", label: "gate closed by opt-in", input: { request: request(), facts: facts({ enabled: false }) } },
    { rule: 9, state: "rejected", label: "gate closed by never", input: { request: request(), facts: facts({ owner: owner({ approvalPolicy: "never" }) }) } },
    { rule: 10, state: "pending", label: "every rule false", input: base },
  ];

  it.each(cases)("rule $rule ($label) decides", ({ rule, state, input }) => {
    expect(admit(input.request, input.facts)).toEqual({ state, rule });
  });

  it.each(cases.filter(c => c.rule !== 10))("rule $rule ($label) negative control reaches rule 10", ({ rule }) => {
    // Flipping rule k's condition on the positive case is the base input.
    expect(admit(base.request, base.facts).rule).not.toBe(rule);
    expect(admit(base.request, base.facts)).toEqual({ state: "pending", rule: 10 });
  });

  it("rule 10 negative control: closing the gate alone leaves pending", () => {
    expect(admit(base.request, facts({ enabled: false })).rule).toBe(9);
  });

  it.each([
    ["bad method and rpc failed", null, facts({ rpcFailed: true }), 1],
    ["rpc failed and thread mismatch", request({ threadId: "x" }), facts({ rpcFailed: true }), 2],
    ["thread mismatch and no owner", request({ threadId: "x" }), facts({ owner: undefined }), 3],
    ["aborted and terminal", request(), facts({ owner: owner({ aborted: true, terminal: true }) }), 5],
    ["terminal and start not set", request(), facts({ owner: owner({ terminal: true, start: undefined }) }), 6],
    ["start not set and gate closed", request(), facts({ enabled: false, owner: owner({ start: undefined }) }), 7],
    ["start failed and gate closed", request(), facts({ enabled: false, owner: owner({ start: { kind: "failed" } }) }), 8],
  ] as const)("priority: %s", (_label, req, f, rule) => {
    expect(admit(req, f).rule).toBe(rule);
  });
});

const config: WrapperConfig = {
  agent_id: "test.approval",
  persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
  display_name: "クロエ",
  server_url: "ws://localhost:4000/wrapper",
};

function channel(failed = false) {
  const writes: Array<{ id: string | number; result?: RpcObject; error?: unknown }> = [];
  const state = { failed };
  const c: ApprovalChannel & { writes: typeof writes; state: typeof state } = {
    writes, state,
    get failed() { return state.failed; },
    respond(id, result) { if (state.failed) return false; writes.push({ id, result }); return true; },
    respondError(id, error) { if (state.failed) return false; writes.push({ id, error }); return true; },
  };
  return c;
}

function routerRig(options: { onPendingChange?: (slot: PendingPermissionExt | null, router: ApprovalRouter) => void; deadlineMs?: number | null } = {}) {
  const slots: Array<PendingPermissionExt | null> = [];
  const transitions: ApprovalTransition[] = [];
  let router!: ApprovalRouter;
  const broker = new PermissionBroker({
    config, send: () => {}, newId: (() => { let n = 0; return () => `req-${++n}`; })(),
    onPendingChange: slot => { slots.push(slot); options.onPendingChange?.(slot, router); },
  });
  router = new ApprovalRouter({
    enabled: true, decide: (tool, input, signal, opts) => broker.decide(tool, input, signal, opts),
    deadlineMs: options.deadlineMs ?? null, onTransition: t => transitions.push(t),
  });
  return { router, broker, slots, transitions };
}

const raw = (id: number, over: RpcObject = {}, method = COMMAND) => ({ id, key: `n:${id}`, method, params: params(over) });

describe("ApprovalRouter", () => {
  it("answers a closed gate with -32601 and shows nothing", () => {
    const c = channel();
    const transitions: ApprovalTransition[] = [];
    const router = new ApprovalRouter({ enabled: false, onTransition: t => transitions.push(t) });
    router.receive(raw(0), c, { boundThreadId: "th", owner: owner() });
    expect(c.writes).toEqual([{ id: 0, error: SERVER_REQUEST_DISABLED }]);
    expect(transitions).toEqual([{ key: "n:0", from: "absent", event: "R", to: "rejected", rule: 9, write: "-32601" }]);
  });

  it("writes nothing for a rejection on a failed channel (bad method and rpc failed)", () => {
    const c = channel(true);
    const transitions: ApprovalTransition[] = [];
    const router = new ApprovalRouter({ enabled: false, onTransition: t => transitions.push(t) });
    router.receive(raw(0, {}, "item/permissions/requestApproval"), c, { boundThreadId: "th", owner: owner() });
    expect(c.writes).toEqual([]);
    expect(transitions[0]).toMatchObject({ to: "rejected", rule: 1 });
    expect(transitions[0]!.write).toBeUndefined();
  });

  it("shows a pending request with the dialog input, then writes the operator's accept once", async () => {
    const { router, broker, slots, transitions } = routerRig();
    const c = channel();
    router.receive(raw(0, { reason: "why", commandActions: [{ type: "unknown" }] }), c, { boundThreadId: "th", owner: owner() });
    expect(slots[0]).toMatchObject({
      request_id: "req-1", tool_name: "codex:command_execution",
      input: { command: "ls", cwd: "/w", kind: "command", reason: "why", command_actions: [{ type: "unknown" }] },
    });
    broker.resolve({ request_id: "req-1", allow: true });
    router.resolved("n:0");
    broker.resolve({ request_id: "req-1", allow: false });
    expect(c.writes).toEqual([{ id: 0, result: { decision: "accept" } }]);
    expect(slots.at(-1)).toBeNull();
    expect(transitions.map(t => `${t.from}.${t.event}>${t.to}`)).toEqual(["absent.R>pending", "pending.D>replied", "replied.S>replied"]);
  });

  it("maps an operator deny to decline and a deadline to decline", async () => {
    vi.useFakeTimers();
    try {
      const { router, broker } = routerRig({ deadlineMs: 1_000 });
      const c = channel();
      router.receive(raw(0), c, { boundThreadId: "th", owner: owner() });
      router.receive(raw(1), c, { boundThreadId: "th", owner: owner() });
      broker.resolve({ request_id: "req-1", allow: false, message: "not reaching codex" });
      vi.advanceTimersByTime(1_000);
      expect(c.writes).toEqual([{ id: 0, result: { decision: "decline" } }, { id: 1, result: { decision: "decline" } }]);
    } finally { vi.useRealTimers(); }
  });

  it("copies fileChange changes from the item snapshot, or marks them unavailable", () => {
    const { router, slots } = routerRig();
    const o = owner();
    o.fileChanges.set(fileChangeKey("th", "t1", "i1"), [{ path: "p5.txt", kind: "add", diff: "+hello" }]);
    router.receive(raw(0, { itemId: "i1", reason: null, grantRoot: null }, FILE), channel(), { boundThreadId: "th", owner: o });
    router.receive(raw(1, { itemId: "i2" }, FILE), channel(), { boundThreadId: "th", owner: o });
    expect(slots[0]).toMatchObject({ tool_name: "codex:file_change", input: { item_id: "i1", changes: [{ path: "p5.txt", kind: "add", diff: "+hello" }] } });
    expect(slots[1]).toMatchObject({ input: { item_id: "i2", changes_unavailable: true } });
  });

  it("never shows a snapshot of the same item id from another turn", () => {
    const { router, slots } = routerRig();
    const o = owner();
    o.fileChanges.set(fileChangeKey("th", "t0", "i1"), [{ path: "old.txt" }]);
    router.receive(raw(0, { itemId: "i1" }, FILE), channel(), { boundThreadId: "th", owner: o });
    expect(slots[0]).toMatchObject({ input: { item_id: "i1", changes_unavailable: true } });
    expect(slots[0]!.input).not.toHaveProperty("changes");
  });

  it("drops a pending request on abort without a write, and ignores the late decision", () => {
    const { router, broker, slots } = routerRig();
    const c = channel();
    const o = owner();
    router.receive(raw(0), c, { boundThreadId: "th", owner: o });
    router.abort(o);
    broker.resolve({ request_id: "req-1", allow: true });
    expect(c.writes).toEqual([]);
    expect(slots.at(-1)).toBeNull();
  });

  it("writes exactly one accept when the slot callback reenters with an abort (settle order)", () => {
    const o = owner();
    const { router, broker } = routerRig({
      onPendingChange: (slot, r) => { if (slot === null) r.abort(o); },
    });
    const c = channel();
    router.receive(raw(0), c, { boundThreadId: "th", owner: o });
    broker.resolve({ request_id: "req-1", allow: true });
    expect(c.writes).toEqual([{ id: 0, result: { decision: "accept" } }]);
  });

  it("does not write for a broker close", async () => {
    const { router, broker } = routerRig();
    const c = channel();
    router.receive(raw(0), c, { boundThreadId: "th", owner: owner() });
    broker.close();
    expect(c.writes).toEqual([]);
  });

  it("keeps records of another owner or channel when one fails", () => {
    const { router, transitions } = routerRig();
    const c1 = channel(), c2 = channel();
    const o1 = owner(), o2 = owner();
    router.receive(raw(0), c1, { boundThreadId: "th", owner: o1 });
    router.receive(raw(1), c2, { boundThreadId: "th", owner: o2 });
    router.fail({ channel: c1 });
    router.terminal(o1);
    router.abort(o1);
    expect(transitions.filter(t => t.key === "n:1").map(t => t.to)).toEqual(["pending"]);
    router.resolved("n:1");
    expect(transitions.filter(t => t.key === "n:1").map(t => `${t.event}>${t.to}`)).toEqual(["R>pending", "S>dropped"]);
    expect(c2.writes).toEqual([]);
  });

  it("shares the one slot with a bridge-tool request: newest shows, and the slot falls back", () => {
    const { router, broker, slots } = routerRig();
    void broker.decide("mcp__kaoiro__request_session_reset", {});
    expect(slots.at(-1)).toMatchObject({ request_id: "req-1" });
    router.receive(raw(0), channel(), { boundThreadId: "th", owner: owner() });
    expect(slots.at(-1)).toMatchObject({ request_id: "req-2", tool_name: "codex:command_execution" });
    router.resolved("n:0");
    expect(slots.at(-1)).toMatchObject({ request_id: "req-1" });
    broker.resolve({ request_id: "req-1", allow: false });
    expect(slots.at(-1)).toBeNull();
  });

  it("refuses an enabled router without a broker", () => {
    expect(() => new ApprovalRouter({ enabled: true })).toThrow("needs a broker");
  });
});
