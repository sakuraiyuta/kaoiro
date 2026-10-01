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

type SteerSchedule = "included" | "ticket-use" | "item-before-response" | "accepted-unobserved" | "unwritten" | "write-failed" | "write-timeout" | "precondition";

async function compose(backend: "app-server" | "exec", echo: boolean, grant: "early" | "normal" = "early",
  schedule: SteerSchedule = "included") {
  let linkOptions!: Record<string, any>, hostOptions!: Record<string, any>;
  const reports: Record<string, unknown>[] = [], acknowledged: number[] = [], notices: Envelope[] = [];
  const send = vi.fn(async () => {}), steer = vi.fn(async (text: string, hooks: Record<string, any>, batchId: string) => {
    expect(hooks.admit("active")).toBe(null);
    hooks.onAdmit("active", batchId);
    if (schedule === "item-before-response") hooks.onItem("active", batchId);
    if (schedule === "precondition") hooks.onResponse("active", batchId, { kind: "P", reason: "no_active_turn" });
    else if (schedule !== "unwritten" && schedule !== "write-failed" && schedule !== "write-timeout") hooks.onResponse("active", batchId, { kind: "A" });
    if (schedule === "included" || schedule === "ticket-use") hooks.onItem("active", batchId);
    if (schedule === "ticket-use") {
      const authText = text.split("\n").find(line => line.startsWith("reply_authorization: "))!;
      const authorization = JSON.parse(authText.slice("reply_authorization: ".length));
      const sendTool = (hostOptions.toolDescriptors as Array<{ name: string; handler: (input: Record<string, unknown>, context: unknown) => Promise<any> }>)
        .find(descriptor => descriptor.name === "send_to_agent")!;
      const reply = await sendTool.handler({ to: "peer.agent", conversation_id: "cid", kind: "response", body: "ANSWER", ...authorization },
        { origin: { token: "active" } });
      expect(reply.isError).toBeFalsy();
    }
    hooks.onTerminal("active", batchId);
    hooks.onSettle("active", batchId, schedule === "precondition" ? { kind: "P", reason: "no_active_turn" }
      : schedule === "unwritten" || schedule === "write-failed" || schedule === "write-timeout" ? { kind: "C" } : { kind: "A" },
    schedule === "included" || schedule === "ticket-use" || schedule === "item-before-response", schedule === "unwritten" ? "unwritten" : schedule === "write-failed" ? "failed" : "written", false, "T");
    return { kind: "sent" as const, turnToken: "active", batchId, text };
  });
  const link = { close: () => {}, currentSessionId: () => null, send: () => {},
    deliveryModes: () => echo ? { version: "v1", early: "steer", yield: "none", stage_reports: true } : null,
    noticeAttributionMode: () => echo ? "v1" : "legacy",
    deliveryIncarnation: () => "inc", deliveryGeneration: () => "gen",
    sendInterAgent: async (envelope: Envelope) => { notices.push(envelope); return { kind: "accepted" }; },
    reportDeliveryStage: (report: Record<string, unknown>) => reports.push(report),
    acknowledgeInterAgentDelivery: (sequence: number) => acknowledged.push(sequence) };
  const host = { state: "thinking", statusExtSnapshot: () => ({}), activeInterAgentTurnToken: () => "active", send, steerInterAgentInput: steer,
    replaceInterAgentPlaceholder: () => false,
    run: async () => {
      linkOptions.onReplyBasisMode("v1");
      linkOptions.onInterAgentDeliveryStatus({ acked_seq: 0 });
      hostOptions.onTurnStart({ turnToken: "active", kind: "wrapper_input" });
      await linkOptions.onInterAgentMessage(inbound(grant));
      if (steer.mock.calls.length > 0) {
        hostOptions.onTurnEnd({ turnToken: "active", conversationIds: [], terminal: "turn.completed" });
      }
      await new Promise(resolve => setImmediate(resolve));
    } };
  const signals = process.listeners("SIGINT");
  try { await runCodexCli({ backend,
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _id, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
      return link as never;
    },
    createHost: (_config, options) => { hostOptions = options as unknown as Record<string, any>; return host as never; },
    prepareStartup: async () => {},
  }); } finally {
    for (const listener of process.listeners("SIGINT")) if (!signals.includes(listener)) process.removeListener("SIGINT", listener);
  }
  return { reports, acknowledged, notices, send, steer, linkOptions };
}

describe("production Codex IA steer composition", () => {
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
    expect(result.send).toHaveBeenCalledOnce();
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
});
