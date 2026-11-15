import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import type {
  Options, Query, SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DeliveryPolicyController } from "@kaoiro/wrapper-core";
import { AgentHost } from "../src/host.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  let options!: Options;
  let nextInput!: () => Promise<unknown>;
  let wake = deferred();
  let closed = false, index = 0, root = 0;
  const events: Array<() => Promise<SDKMessage>> = [];
  const signal = new AbortController().signal;
  const approval = deferred<{ allow: boolean }>();
  const policy = new DeliveryPolicyController();
  const join = policy.beginJoin();
  policy.acceptJoin({ delivery_policy: "v1" }, join);
  policy.apply({ version: "0", revision: 1, policy: "on" }, join);
  const host = new AgentHost({ agent_id: "test", display_name: "Test",
    persona: { id: "p", name: "P", sprite_set: "p" },
    server_url: "unused" }, {
    onState: () => {}, deliveryPolicy: policy,
    decidePermission: () => approval.promise,
    queryFn: ((args: any) => {
      options = args.options;
      const input = args.prompt[Symbol.asyncIterator]();
      nextInput = () => input.next();
      return Object.assign((async function* () {
        while (!closed) {
          if (!events.length) { await wake.promise; continue; }
          yield await events.shift()!();
        }
      })(), { interrupt: async () => {}, supportedModels: async () => [] }
      ) as unknown as Query;
    }) as never,
  });
  const emit = (value: SDKMessage | (() => Promise<SDKMessage>)) => {
    events.push(typeof value === "function" ? value : async () => value);
    const previous = wake; wake = deferred(); previous.resolve();
  };
  const hook = (name: string, input: Record<string, unknown>) =>
    (options.hooks as any)[name].at(-1).hooks[0]({
      hook_event_name: name, session_id: "s", prompt_id: `p${root}`,
      ...input,
    }, input.tool_use_id, { signal });
  const nextRoot = async () => {
    const prior = host.activeInterAgentTurnToken();
    await host.send(`root${++root}`);
    emit(async () => {
      await nextInput();
      await hook("UserPromptSubmit", { prompt: `root${root}` });
      return { type: "system", subtype: "init", session_id: "s" } as SDKMessage;
    });
    await vi.waitFor(() => {
      expect(host.activeInterAgentTurnToken()).not.toBe(prior);
      expect(host.canPushLiveInput()).toBe(true);
    });
  };
  const running = host.run();
  await nextRoot();
  const reserve = () => {
    const owner = host.activeInterAgentTurnToken()!;
    return host.reserveYieldCut(owner, host.captureLiveInputContext(owner)!)!;
  };
  const pre = (id: string, extra = {}) => hook("PreToolUse", {
    tool_name: "mcp__external__slow", tool_use_id: id, ...extra,
  });
  const result = (id: string, is_error = false) => emit({
    type: "user", session_id: "s", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: id, content: "result", is_error,
    }] },
  } as SDKMessage);
  const terminal = async () => {
    emit({ type: "result", subtype: "success", session_id: "s",
      result_index: index++, result: "done" } as SDKMessage);
    await vi.waitFor(() => expect(host.activeInterAgentTurnToken()).toBeNull());
  };
  return { host, pre, result, reserve, hook, approval, terminal, nextRoot,
    async consumeFold() {
      const next = await nextInput() as any;
      await hook("UserPromptSubmit", { prompt: next.value.message.content });
    },
    allow: (id: string) => options.canUseTool!("mcp__external__slow", {}, {
      toolUseID: id, signal,
    } as never),
    async close() {
      closed = true; wake.resolve(); host.close(); await running;
    } };
}

const push = (host: AgentHost, kind: "fold" | "cut", cut?: any) =>
  host.pushLiveInput({ kind, text: id => `fold_id: ${id}\ninput`,
    envelopes: [], conversationIds: [],
    ...(cut ? { cutReservation: cut } : {}) });

it("reserves the push slot until all MCP results", async () => {
  const f = await fixture();
  try {
    await f.pre("a"); await f.pre("b");
    const cut = f.reserve();
    expect(cut).not.toBeNull();
    expect(f.host.canFoldLiveInput()).toBe(false);
    expect(push(f.host, "fold").kind).toBe("declined");
    expect(push(f.host, "cut", cut).kind).toBe("declined");
    let ready = false;
    const waiting = f.host.waitForMcp(cut).then(() => { ready = true; });
    await f.hook("PostToolUse", { tool_use_id: "a" });
    expect(f.host.hasRunningMcp(cut)).toBe(true);
    f.result("a");
    await vi.waitFor(() => expect(f.host.hasRunningMcp(cut)).toBe(true));
    expect(ready).toBe(false);
    f.result("b", true); await waiting;
    expect(push(f.host, "cut", cut).kind).toBe("pushed");
    expect(f.host.canFoldLiveInput()).toBe(false);
    const denied = await f.pre("late");
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
  } finally { await f.close(); }
});

it("excludes permission wait and denies a late allow", async () => {
  const f = await fixture();
  try {
    await f.pre("running"); await f.pre("asking");
    const decision = f.allow("asking");
    const cut = f.reserve();
    expect(f.host.hasRunningMcp(cut)).toBe(true);
    f.result("running"); await f.host.waitForMcp(cut);
    expect(push(f.host, "cut", cut).kind).toBe("pushed");
    f.approval.resolve({ allow: true });
    expect((await decision)?.behavior).toBe("deny");
  } finally { await f.close(); }
});

it.each([true, false])("approval without cut: %s", async allow => {
  const f = await fixture();
  try {
    await f.pre("asking"); const decision = f.allow("asking");
    f.approval.resolve({ allow });
    expect((await decision)?.behavior).toBe(allow ? "allow" : "deny");
    const cut = f.reserve();
    expect(f.host.hasRunningMcp(cut)).toBe(allow);
  } finally { await f.close(); }
});

it("ignores subagents and permits folds without a cut", async () => {
  const f = await fixture();
  try {
    await f.pre("child", { agent_id: "subagent" });
    const cut = f.reserve();
    expect(f.host.hasRunningMcp(cut)).toBe(false);
    f.host.releaseYieldCut(cut);
    await f.pre("running");
    expect(f.host.canFoldLiveInput()).toBe(true);
    expect(push(f.host, "fold").kind).toBe("pushed");
  } finally { await f.close(); }
});

it("ignores a leaked reservation for the next owner", async () => {
  const f = await fixture();
  try {
    const old = f.reserve();
    const release = vi.spyOn(f.host, "releaseYieldCut")
      .mockImplementation(() => {});
    await f.terminal(); await f.nextRoot();
    expect(f.host.canFoldLiveInput()).toBe(true);
    expect(push(f.host, "fold").kind).toBe("pushed");
    await f.consumeFold();
    const late = await f.pre("old-call", { prompt_id: "p1" });
    expect(late.hookSpecificOutput.permissionDecision).toBe("deny");
    const next = f.reserve();
    release.mockRestore();
    f.host.releaseYieldCut(old);
    expect(f.host.canFoldLiveInput()).toBe(false);
    expect(push(f.host, "cut", old).kind).toBe("declined");
    expect(push(f.host, "cut", next).kind).toBe("pushed");
  } finally { await f.close(); }
});

it.each(["ownerToken", "sessionId", "query", "generation"] as const)(
  "a stale reservation cannot block push (%s)", async field => {
    const f = await fixture();
    try {
      const cut = f.reserve();
      Object.assign(cut, { [field]: field === "query" ? {} : "stale" });
      expect(f.host.canFoldLiveInput()).toBe(true);
      expect(push(f.host, "fold").kind).toBe("pushed");
    } finally { await f.close(); }
  },
);
