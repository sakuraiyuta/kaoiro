import "../../../scripts/test/fixtures/test-isolation.mjs";
import { PermissionSyncTimeoutError } from "@kaoiro/wrapper-core";
import type { ServerLink, ServerLinkOptions } from "@kaoiro/wrapper-core";
import type { Envelope, ToolDescriptor } from "@kaoiro/agent-common";
import { expect, it, vi } from "vitest";
import { runGrokCli } from "../src/cli.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const config = {
  agent_id: "test.grok", display_name: "Grok",
  server_url: "ws://127.0.0.1:1/wrapper",
  persona: { id: "default", name: "Default", sprite_set: "default" },
};
const notice = {
  version: "0", op: "assign", reason: "operator_control", work: {},
} as Parameters<NonNullable<ServerLinkOptions["onWorkNotice"]>>[0];
const workId = "wrk_AbCdEfGhIjKlMnOpQrStUv";

async function fixture(
  available: boolean,
  exercise: (f: {
    options: ServerLinkOptions;
    descriptors: ToolDescriptor[];
    outbound: Envelope[];
    envelopes: Envelope[];
    send: ReturnType<typeof vi.fn>;
    requests: unknown[];
  }) => Promise<void>,
  earlyNotice = false,
) {
  const outbound: Envelope[] = [], envelopes: Envelope[] = [];
  const requests: unknown[] = [];
  let options!: ServerLinkOptions, descriptors!: ToolDescriptor[];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const send = vi.fn(async (_text: string) => {});
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const run = runGrokCli({
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => config,
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false,
      built_at: "unknown", version: "unknown", channel: "dev" }),
    createServerLink: (_url, _id, o) => {
      options = o;
      if (earlyNotice) o.onWorkNotice?.(notice);
      queueMicrotask(() => o.onPersonaPrompt?.("Persona"));
      return {
        send: (e: Envelope) => envelopes.push(e), setSessionId: () => {},
        close: () => {}, reportDisconnectIntent: async () => {},
        deliveryIncarnation: () => null, deliveryGeneration: () => null,
        noticeAttributionMode: () => "legacy",
        workControlSupported: () => available,
        deliveryModes: () => null,
        deliveryModesState: () => "legacy",
        requestWorkStatus: async (input: unknown) => {
          requests.push(["status", input]); return { works: [] };
        },
        requestWorkOpResult: async (input: unknown) => {
          requests.push(["result", input]); return { outcome: "unknown" };
        },
        requestDeliveryStatus: async () => ({}),
        sendInterAgent: async (e: Envelope) => {
          outbound.push(e);
          const control = e.payload.work_control as { op?: string } | undefined;
          if ((control?.op === "complete" || control?.op === "cancel") &&
              e.payload.body === "unauthorized")
            return { kind: "rejected", reason: "work_not_authorized" };
          return { kind: "accepted", stamp: null };
        },
      } as unknown as ServerLink;
    },
    createHost: o => {
      descriptors = o.toolDescriptors ?? [];
      return {
        state: "waiting_input", statusSnapshot: () => ({}),
        activeInterAgentTurnToken: () => null,
        run: async () => { started(); await finished; },
        send, close: () => finish(), closed: finished,
        applyPermissionSync: () => {},
      } as never;
    },
    onHostCreated: () => {},
    platform: "darwin",
  });
  void run.catch(() => {});
  try {
    await start;
    await exercise({ options, descriptors, outbound, envelopes, send,
      requests });
  } finally { finish(); await run; }
}

it("wires work tools and surfaces server operation results", async () => {
  await fixture(true, async ({ options, descriptors, outbound, requests }) => {
    expect(options.workControl).toBe("v1");
    expect(options.interAgentDeliveryModes).toEqual({
      version: "v1", early: "none", yield: "none", stage_reports: false,
    });
    const call = (name: string, input: Record<string, unknown>) =>
      descriptors.find(d => d.name === name)!.handler(input);
    expect(descriptors.map(d => d.name)).toEqual(expect.arrayContaining([
      "send_to_agent", "work_status", "work_op_result", "delivery_status",
    ]));
    await call("work_status", { work_id: workId });
    await call("work_op_result", { operation_id: "op_1_aaa" });
    expect(requests).toEqual([
      ["status", { work_id: workId }],
      ["result", { operation_id: "op_1_aaa" }],
    ]);
    const assigned = await call("send_to_agent", { to: "peer", kind: "request",
      body: "assign", work_control: { op: "assign", title: "Work" } });
    expect(assigned.isError).not.toBe(true);
    expect(outbound.at(-1)?.payload.work_control).toMatchObject({
      op: "assign", title: "Work",
    });
    for (const op of ["accept_assignment", "decline", "complete", "cancel"]) {
      const result = await call("send_to_agent", { to: "peer", kind: "response",
        body: op, work_control: { op, work_id: workId } });
      expect(outbound.at(-1)?.payload.work_control).toMatchObject({ op,
        work_id: workId });
      expect(result.isError).not.toBe(true);
      if (op === "complete" || op === "cancel") {
        const rejected = await call("send_to_agent", { to: "peer",
          kind: "response", body: "unauthorized",
          work_control: { op, work_id: workId } });
        expect(rejected.isError).toBe(true);
        expect(rejected.content[0]?.text).toContain("work_not_authorized");
      }
    }
  });
});

it("rejects work locally with an old server but keeps normal messages", async () => {
  await fixture(false, async ({ descriptors, outbound }) => {
    const call = descriptors.find(d => d.name === "send_to_agent")!.handler;
    const result = await call({ to: "peer", kind: "response", body: "accept",
      work_control: { op: "accept_assignment", work_id: workId } });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("work_control_unavailable");
    expect(outbound).toHaveLength(0);
    await call({ to: "peer", kind: "response", body: "ordinary" });
    expect(outbound).toHaveLength(1);
  });
});

it("queues notices until the host is ready", async () => {
  await fixture(true, async ({ send }) => {
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toContain('"op":"assign"');
  }, true);
});

it("suppresses notice permission timeouts and continues the queue", async () => {
  await fixture(true, async ({ options, send, envelopes }) => {
    send.mockRejectedValueOnce(new PermissionSyncTimeoutError());
    options.onWorkNotice?.({ ...notice, op: "complete" });
    options.onWorkNotice?.({ ...notice, op: "cancel" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0]?.[0]).toContain('"op":"complete"');
    expect(send.mock.calls[1]?.[0]).toContain('"op":"cancel"');
    expect(envelopes.some(e => e.payload.text === "grok turn failed"))
      .toBe(false);
  });
});

it("reports other notice failures", async () => {
  await fixture(true, async ({ options, send, envelopes }) => {
    send.mockRejectedValueOnce(new Error("send failed"));
    options.onWorkNotice?.(notice);
    await vi.waitFor(() => expect(envelopes.some(e =>
      e.payload.text === "grok turn failed")).toBe(true));
  });
});

it("negotiates work control on the ServerLink wire", async () => {
  const server = await phoenixLoopback(() => ({ work_control: "v1" }));
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const run = runGrokCli({
    platform: "darwin",
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ ...config, server_url: server.url }),
    createHost: () => ({ state: "waiting_input", run: () => finished,
      close: () => finish(), closed: finished }) as never,
  });
  void run.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    expect(server.received.find(x => x.event === "phx_join")?.payload)
      .toMatchObject({ work_control: "v1", inter_agent_delivery_modes: {
        version: "v1", early: "none", yield: "none", stage_reports: false,
      } });
    server.push("persona_prompt", { prompt: "Persona" });
  } finally { finish(); await run; await server.close(); }
});

it("sends early intent after the server negotiates delivery modes", async () => {
  const server = await phoenixLoopback(() => ({ work_control: "v1",
    inter_agent_delivery_modes: "v1" }));
  let descriptors!: ToolDescriptor[];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const run = runGrokCli({
    platform: "darwin",
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ ...config, server_url: server.url }),
    createHost: options => {
      descriptors = options.toolDescriptors ?? [];
      return { state: "waiting_input", statusSnapshot: () => ({}),
        activeInterAgentTurnToken: () => null,
        run: () => finished, close: () => finish(), closed: finished } as never;
    },
  });
  void run.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    server.push("persona_prompt", { prompt: "Persona" });
    await vi.waitFor(() => expect(descriptors).toBeDefined());
    const result = await descriptors.find(d => d.name === "send_to_agent")!
      .handler({ to: "peer", kind: "inform", body: "early probe",
        delivery_intent: "early" });
    expect(result.isError).not.toBe(true);
    expect(server.received.some(x => x.event === "envelope" &&
      (x.payload.payload as Record<string, unknown>)?.delivery_intent ===
        "early")).toBe(true);
  } finally { finish(); await run; await server.close(); }
});
