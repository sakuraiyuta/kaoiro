import { describe, expect, it, vi } from "vitest";
import type { Envelope, InterAgentMessagePayload, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent", persona: { id: "p", name: "P", sprite_set: "p" }, display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

function inbound(granted: "early" | "normal" = "early"): Envelope {
  return { version: "0", agent_id: "peer.agent", persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer", ts: "2026-10-01T00:00:00Z", type: "inter_agent_message", state: "tool_running",
    delivery_seq: 1,
    payload: { to: "self.agent", conversation_id: "cid", turn_number: 2, kind: "inform", body: "PEER BODY",
      meta: { done: false, propose_next: "" }, owner: { kind: "user", id: "operator" },
      new_conversation: false,
      delivery_authority: { requested: granted, granted },
      notice_attribution: "v1" } satisfies InterAgentMessagePayload,
    ext: {} } as Envelope;
}

interface ComposeExtra {
  policyOff?: boolean;
  offAfterWrite?: boolean;
  mutate?: (early: any) => void;
  root?: { agent_id: string; conversation_id: string };
  idle?: boolean;
  hostQueued?: string;
  rootWaiting?: boolean;
}

type SteerSchedule = "queued-successor" | "terminal-before-settle" | "included" | "ticket-use" | "item-before-response" | "accepted-unobserved" | "unwritten" | "write-failed" | "write-timeout" | "precondition";

async function compose(backend: "app-server" | "exec", echo: boolean, grant: "early" | "normal" = "early",
  schedule: SteerSchedule = "included", noticeEcho = echo, otherPeerRoot = false, extra: ComposeExtra = {}) {
  const rootSpec = extra.root ?? (otherPeerRoot ? { agent_id: "other.agent", conversation_id: "other-cid" } : undefined);
  let linkOptions!: Record<string, any>, hostOptions!: Record<string, any>;
  const reports: Record<string, unknown>[] = [], acknowledged: number[] = [], notices: Envelope[] = [];
  let activeToken = "active";
  let policyJoin = 0;
  let held: { hooks: Record<string, any>; batchId: string } | undefined;
  const send = vi.fn(async (..._args: unknown[]) => {}), steer = vi.fn(async (text: string, hooks: Record<string, any>, batchId: string) => {
    if (extra.hostQueued !== undefined) return { kind: "queued" as const, reason: extra.hostQueued };
    expect(hooks.admit(activeToken)).toBe(null);
    hooks.onAdmit(activeToken, batchId);
    if (extra.offAfterWrite) hostOptions.deliveryPolicy.apply({ revision: 2, policy: "off" }, policyJoin);
    if (schedule === "queued-successor" || schedule === "terminal-before-settle") {
      hooks.onResponse(activeToken, batchId, { kind: "A" }); hooks.onItem(activeToken, batchId);
      held = { hooks, batchId };
      return { kind: "sent" as const, turnToken: activeToken, batchId, text };
    }
    if (schedule === "item-before-response") hooks.onItem(activeToken, batchId);
    if (schedule === "precondition") hooks.onResponse(activeToken, batchId, { kind: "P", reason: "no_active_turn" });
    else if (schedule !== "unwritten" && schedule !== "write-failed" && schedule !== "write-timeout") hooks.onResponse(activeToken, batchId, { kind: "A" });
    if (schedule === "included" || schedule === "ticket-use") hooks.onItem(activeToken, batchId);
    if (schedule === "ticket-use") {
      const authText = text.split("\n").find(line => line.startsWith("reply_authorization: "))!;
      const authorization = JSON.parse(authText.slice("reply_authorization: ".length));
      const sendTool = (hostOptions.toolDescriptors as Array<{ name: string; handler: (input: Record<string, unknown>, context: unknown) => Promise<any> }>)
        .find(descriptor => descriptor.name === "send_to_agent")!;
      const reply = await sendTool.handler({ to: "peer.agent", conversation_id: "cid", kind: "response", body: "ANSWER", ...authorization },
        { origin: { token: activeToken } });
      expect(reply.isError).toBeFalsy();
    }
    hooks.onTerminal(activeToken, batchId);
    hooks.onSettle(activeToken, batchId, schedule === "precondition" ? { kind: "P", reason: "no_active_turn" }
      : schedule === "unwritten" || schedule === "write-failed" || schedule === "write-timeout" ? { kind: "C" } : { kind: "A" },
    schedule === "included" || schedule === "ticket-use" || schedule === "item-before-response", schedule === "unwritten" ? "unwritten" : schedule === "write-failed" ? "failed" : "written", false, "T");
    return { kind: "sent" as const, turnToken: activeToken, batchId, text };
  });
  const link = { close: () => {}, currentSessionId: () => null, send: () => {},
    deliveryModes: () => echo ? { version: "v1", early: "steer", yield: "none", stage_reports: true } : null,
    noticeAttributionMode: () => noticeEcho ? "v1" : "legacy",
    deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
    sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted" }; },
    reportDeliveryStage: (report: Record<string, unknown>) => reports.push(report),
    acknowledgeInterAgentDelivery: (sequence: number) => acknowledged.push(sequence) };
  const replace = vi.fn(() => true);
  const host = { state: "thinking", statusExtSnapshot: () => ({}), activeInterAgentTurnToken: () => extra.idle ? null : activeToken, send, steerInterAgentInput: steer,
    replaceInterAgentPlaceholder: replace,
    createInterAgentPlaceholder: () => true,
    removeInterAgentPlaceholder: () => {},
    run: async () => {
      linkOptions.onReplyBasisMode("v1");
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      if (rootSpec !== undefined) {
        const root = inbound("normal") as any;
        root.agent_id = rootSpec.agent_id; root.payload.conversation_id = rootSpec.conversation_id;
        root.payload.body = "OTHER ROOT"; root.payload.turn_number = 1;
        await linkOptions.onInterAgentMessage(root);
        expect(send).toHaveBeenCalledOnce();
        activeToken = extra.rootWaiting ? "other-running-token" : String(send.mock.calls[0]![3]);
        send.mockClear();
      }
      hostOptions.onTurnStart({ turnToken: activeToken, conversationIds: rootSpec !== undefined ? [rootSpec.conversation_id] : [] });
      const early = inbound(grant) as any;
      if (rootSpec !== undefined) early.delivery_seq = 2;
      extra.mutate?.(early);
      await linkOptions.onInterAgentMessage(early);
      if (schedule === "queued-successor" || schedule === "terminal-before-settle") {
        const next = inbound("normal") as any;
        next.delivery_seq = rootSpec !== undefined ? 3 : 2; next.payload.turn_number = 3; next.payload.body = "SUCCESSOR";
        await linkOptions.onInterAgentMessage(next);
        expect(send).not.toHaveBeenCalled();
        if (schedule === "terminal-before-settle") {
          held!.hooks.onTerminal(activeToken, held!.batchId);
          hostOptions.onTurnEnd({ turnToken: activeToken, conversationIds: rootSpec !== undefined ? [rootSpec.conversation_id] : [], terminal: "turn.completed" });
          expect(send).not.toHaveBeenCalled();
        }
        if (schedule !== "terminal-before-settle") held!.hooks.onTerminal(activeToken, held!.batchId);
        held!.hooks.onSettle(activeToken, held!.batchId, { kind: "A" }, true, "written", false, "T");
      }
      if (steer.mock.calls.length > 0 && schedule !== "terminal-before-settle") {
        hostOptions.onTurnEnd({ turnToken: activeToken, conversationIds: rootSpec !== undefined ? [rootSpec.conversation_id] : [], terminal: "turn.completed" });
      }
      await new Promise(resolve => setImmediate(resolve));
    } };
  const signals = process.listeners("SIGINT");
  try { await runCodexCli({ backend,
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      options.deliveryPolicy?.acceptJoin({}, options.deliveryPolicy.beginJoin());
      if (extra.offAfterWrite) {
        const policy = options.deliveryPolicy!;
        policyJoin = policy.beginJoin();
        policy.acceptJoin({ delivery_policy: "v1" }, policyJoin);
        policy.apply({ revision: 1, policy: "on" }, policyJoin);
      }
      if (extra.policyOff) {
        const policy = options.deliveryPolicy!;
        const join = policy.beginJoin();
        policy.acceptJoin({ delivery_policy: "v1" }, join);
        policy.apply({ revision: 1, policy: "off" }, join);
      }
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (_config, options) => { hostOptions = options as unknown as Record<string, any>; return host as never; },
    prepareStartup: async () => {},
  }); } finally {
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
  }
  return { reports, acknowledged, notices, send, steer, replace, linkOptions,
    policy: hostOptions.deliveryPolicy.decision() };
}

describe("production Codex IA steer composition", () => {
  it.each(["unwritten", "write-failed", "write-timeout", "precondition", "accepted-unobserved"] as const)(
    "preserves one started %s outcome across off", async schedule => {
      const result = await compose("app-server", true, "early", schedule, true, false, { offAfterWrite: true });
      expect(result.policy).toMatchObject({ allowed: false, policy: "off", revision: 2 });
      expect(result.steer).toHaveBeenCalledOnce();
      const fallback = schedule === "unwritten" || schedule === "precondition";
      const uncertain = schedule === "write-timeout" || schedule === "accepted-unobserved";
      expect(result.send).not.toHaveBeenCalled();
      expect(result.replace).toHaveBeenCalledTimes(fallback ? 1 : 0);
      expect(result.acknowledged).toEqual(uncertain ? [1] : []);
      expect(result.reports.filter(report => report.stage === "unknown")).toHaveLength(uncertain ? 1 : 0);
      expect(result.reports.filter(report => report.stage === "submitted")).toHaveLength(schedule === "accepted-unobserved" ? 1 : 0);
      expect(result.reports.some(report => report.reason === "local_policy_disabled")).toBe(false);
    },
  );

  it.each(["classification", "final commit"] as const)("keeps one normal root and no acknowledgement after %s policy refusal", async boundary => {
    const result = await compose("app-server", true, "early", "included", true, false,
      boundary === "classification" ? { policyOff: true } : { hostQueued: "local_policy_disabled" });
    expect(result.send).toHaveBeenCalledOnce();
    expect(result.steer).toHaveBeenCalledTimes(boundary === "classification" ? 0 : 1);
    expect(result.acknowledged).toEqual([]);
    expect(result.reports.filter(report => report.reason === "local_policy_disabled")).toEqual([
      expect.objectContaining({ stage: "queued", mode: "normal", incarnation: "inc", generation: "gen", delivery_seq: 1 }),
    ]);
    expect(result.reports.some(report => report.stage === "submitted")).toBe(false);
  });
  it("steers a server-granted early peer input and resolves its sequence", async () => {
    const result = await compose("app-server", true);
    expect(result.linkOptions.interAgentDeliveryModes.early).toBe("steer");
    expect(result.steer).toHaveBeenCalledOnce();
    expect(result.send).not.toHaveBeenCalled();
    expect(result.reports.map(report => [report.stage, report.handoff ?? report.reason])).toEqual([
      ["queued", undefined], ["submitted", "turn_steer_accepted"], ["settled", "turn_end"],
    ]);
    expect(result.acknowledged).toContain(1);
  });

  it("accepts an item before its response without submitting twice", async () => {
    const result = await compose("app-server", true, "early", "item-before-response");
    expect(result.reports.map(report => [report.stage, report.handoff ?? report.reason])).toEqual([
      ["queued", undefined], ["submitted", "turn_steer_item_observed"], ["settled", "turn_end"],
    ]);
  });

  it("credits only the ticketed steer when the model sends a reply", async () => {
    const result = await compose("app-server", true, "early", "ticket-use");
    expect(result.reports.map(report => report.stage)).toEqual(["queued", "submitted", "included", "settled"]);
    expect(result.notices.map(envelope => (envelope.payload as unknown as InterAgentMessagePayload).body)).toEqual(["ANSWER"]);
  });

  it("marks accepted but unobserved input uncertain and tells the sender to wait", async () => {
    const result = await compose("app-server", true, "early", "accepted-unobserved");
    expect(result.reports.map(report => [report.stage, report.reason])).toEqual([
      ["queued", undefined], ["submitted", undefined], ["unknown", "turn_steer_not_observed"],
    ]);
    expect((result.notices[0]?.payload as unknown as InterAgentMessagePayload)?.error).toMatchObject({
      code: "timeout", affected_deliveries: [{ delivery_seq: 1, peer_turn_number: 2 }],
    });
    expect(result.reports.at(-1)).toMatchObject({ mode: "early", reason: "turn_steer_not_observed" });
    expect(result.reports.at(-1)).not.toHaveProperty("handoff");
  });

  it("resolves a possibly written no-response steer as uncertain", async () => {
    const result = await compose("app-server", true, "early", "write-timeout");
    expect(result.reports.at(-1)).toMatchObject({ stage: "unknown", mode: "early",
      handoff: "turn_steer_write_uncertain", reason: "turn_steer_timeout" });
    expect(result.send).not.toHaveBeenCalled();
    expect((result.notices[0]?.payload as unknown as InterAgentMessagePayload)?.error?.code).toBe("timeout");
  });

  it("leaves a failed write unresolved instead of qualifying server uncertainty", async () => {
    const result = await compose("app-server", true, "early", "write-failed");
    expect(result.reports.map(report => report.stage)).toEqual(["queued"]);
    expect((result.notices[0]?.payload as unknown as InterAgentMessagePayload)?.error?.code).toBe("timeout");
    expect(result.send).not.toHaveBeenCalled();
  });

  it.each(["unwritten", "precondition"] as const)("queues %s without a write-uncertain report", async schedule => {
    const result = await compose("app-server", true, "early", schedule);
    expect(result.replace).toHaveBeenCalledOnce();
    expect(result.send).not.toHaveBeenCalled();
    expect(result.reports.map(report => report.stage)).toEqual(["queued"]);
    expect(result.notices).toEqual([]);
  });

  it.each([
    ["exec", true, "early"], ["app-server", false, "early"], ["app-server", true, "normal"],
  ] as const)("queues when backend=%s echo=%s grant=%s", async (backend, echo, grant) => {
    const result = await compose(backend, echo, grant);
    expect(result.steer).not.toHaveBeenCalled();
    expect(result.send).toHaveBeenCalledOnce();
    expect(result.reports.map(report => report.stage)).toEqual(["queued"]);
  });

  it.each([
    [true, false], [false, true],
  ] as const)("queues when delivery-mode echo=%s and attribution echo=%s", async (modes, attribution) => {
    const result = await compose("app-server", modes, "early", "included", attribution);
    expect(result.steer).not.toHaveBeenCalled();
    expect(result.send).toHaveBeenCalledOnce();
  });
});

it.each(["queued-successor", "terminal-before-settle"] as const)(
  "resumes a queued peer root when its steer resolves in the %s order", async schedule => {
    const result = await compose("app-server", true, "early", schedule);
    expect(result.send).toHaveBeenCalledOnce();
  },
);

it("resumes a steered peer after a different peer's root turn ends", async () => {
  const result = await compose("app-server", true, "early", "queued-successor", true, true);
  expect(result.send).toHaveBeenCalledOnce();
});

describe("early input that is not steered says why", () => {
  function captureQueuedLog(fail = false) {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      const line = String(chunk);
      if (line.includes("inter-agent early input queued")) {
        if (fail) throw new Error("diagnostic sink unavailable");
        lines.push(line);
      }
      return true;
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it.each([
    ["the exec backend", () => compose("exec", true), "steer_not_negotiated"],
    ["a missing delivery-mode echo", () => compose("app-server", false), "steer_not_negotiated"],
    ["a missing attribution echo", () => compose("app-server", true, "early", "included", false), "steer_not_negotiated"],
    ["a queued root from the same sender", () => compose("app-server", true, "early", "included", true, false,
      { root: { agent_id: "peer.agent", conversation_id: "earlier-cid" }, rootWaiting: true }), "behind_queued_root_same_sender"],
    ["an open root in the same conversation", () => compose("app-server", true, "early", "included", true, false,
      { root: { agent_id: "other.agent", conversation_id: "cid" }, rootWaiting: true }), "behind_open_root_same_conversation"],
    ["an oversized message", () => compose("app-server", true, "early", "included", true, false,
      { mutate: early => { early.payload.body = "x".repeat(20_000); } }), "too_large"],
    ["a malformed delivery sequence", () => compose("app-server", true, "early", "included", true, false,
      { mutate: early => { early.delivery_seq = 0; } }), "invalid_delivery_identity"],
    ["no running turn", () => compose("app-server", true, "early", "included", true, false, { idle: true }), "no_active_turn"],
  ] as const)("logs one reason line for %s", async (_name, run, reason) => {
    const log = captureQueuedLog();
    try {
      const result = await run();
      expect(result.steer).not.toHaveBeenCalled();
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toMatch(new RegExp(`^\\[kaoiro\\] inter-agent early input queued: ${reason} seq=\\d+ from=peer\\.agent\\n$`));
    } finally { log.restore(); }
  });

  it("logs the host's own reason when it declines an early input", async () => {
    const log = captureQueuedLog();
    try {
      const result = await compose("app-server", true, "early", "included", true, false, { hostQueued: "turn_ending" });
      expect(result.steer).toHaveBeenCalledOnce();
      expect(result.send).toHaveBeenCalledOnce();
      expect(log.lines).toEqual(["[kaoiro] inter-agent early input queued: turn_ending seq=1 from=peer.agent\n"]);
    } finally { log.restore(); }
  });

  it.each([
    ["a steered early input", () => compose("app-server", true)],
    ["a normal input", () => compose("app-server", true, "normal")],
    ["a normal input without negotiation", () => compose("exec", false, "normal")],
  ] as const)("logs nothing for %s", async (_name, run) => {
    const log = captureQueuedLog();
    try {
      await run();
      expect(log.lines).toEqual([]);
    } finally { log.restore(); }
  });

  it("still queues the input when the diagnostic sink fails", async () => {
    const log = captureQueuedLog(true);
    try {
      const result = await compose("exec", true);
      expect(result.send).toHaveBeenCalledOnce();
      expect(result.reports.map(report => report.stage)).toEqual(["queued"]);
    } finally { log.restore(); }
  });
});
