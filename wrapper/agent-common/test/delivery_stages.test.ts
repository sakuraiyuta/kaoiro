import { describe, expect, it, vi } from "vitest";
import { DeliveryStageReporter } from "../src/delivery_stages.js";
import type { Envelope } from "@kaoiro/protocol";

const envelope = (seq: number): Envelope => ({
  version: "0", agent_id: "sender", persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P", ts: "T", type: "inter_agent_message", state: "idle",
  payload: { to: "self", conversation_id: "cid", turn_number: 1, kind: "inform", body: "hello", delivery_authority: { requested: "normal", granted: "normal" } },
  delivery_seq: seq,
} as unknown as Envelope);

describe("DeliveryStageReporter", () => {
  it("reports queued, submitted and terminal stages with the server identity", () => {
    const reports: Record<string, unknown>[] = [];
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "server-incarnation", generation: "wrapper-generation" }),
      turns: { deliverySequencesForTurn: token => token === "turn" ? [7] : [] },
      now: () => "T",
    });
    reporter.queued(envelope(7));
    reporter.submitted("turn", "prompt_hook");
    reporter.settled("turn");
    expect(reports).toEqual([
      expect.objectContaining({ incarnation: "server-incarnation", generation: "wrapper-generation", delivery_seq: 7, stage: "queued", mode: "normal" }),
      expect.objectContaining({ incarnation: "server-incarnation", generation: "wrapper-generation", delivery_seq: 7, stage: "submitted", handoff: "prompt_hook", mode: "normal" }),
      expect.objectContaining({ incarnation: "server-incarnation", generation: "wrapper-generation", delivery_seq: 7, stage: "settled", reason: "turn_end" }),
    ]);
  });

  it("does not attach a later incarnation to a delivery received before the first join", () => {
    const reports: unknown[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = null;
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliverySequencesForTurn: () => [7] },
      now: () => "T",
    });
    reporter.queued(envelope(7));
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.submitted("turn", "exec_input_written");
    reporter.settled("turn");
    expect(reports).toEqual([]);
  });

  it("keeps the captured identity through a disconnected handoff and retires it after replacement", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliverySequencesForTurn: () => [7] },
      now: () => "T",
    });
    reporter.queued(envelope(7));
    currentIdentity = null;
    reporter.submitted("turn", "exec_input_written");
    expect(reports.at(-1)).toMatchObject({ incarnation: "old", generation: "g", delivery_seq: 7, stage: "submitted" });

    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.submitted("turn", "exec_input_written");
    expect(reports.filter(report => report.stage === "submitted")).toEqual([
      expect.objectContaining({ incarnation: "old", delivery_seq: 7 }),
    ]);
    reporter.queued(envelope(7));
    expect(reports.at(-1)).toMatchObject({ incarnation: "new", generation: "g", delivery_seq: 7, stage: "queued" });
    expect(reports.filter(report => report.stage === "submitted")).toEqual([
      expect.objectContaining({ incarnation: "old", delivery_seq: 7 }),
    ]);
  });

  it("does not relabel an unsubmitted old turn after the server identity changes", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliverySequencesForTurn: () => [12] },
      now: () => "T",
    });
    reporter.queued(envelope(12));
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.submitted("old-turn", "exec_input_written");
    expect(reports).toEqual([
      expect.objectContaining({ incarnation: "old", generation: "g", delivery_seq: 12, stage: "queued" }),
    ]);

    reporter.queued(envelope(12));
    expect(reports.at(-1)).toMatchObject({
      incarnation: "new", generation: "g", delivery_seq: 12, stage: "queued",
    });
    reporter.settled("old-turn");
    expect(reports.filter(report => report.stage === "settled")).toEqual([]);
    reporter.submitted("new-turn", "exec_input_written");
    expect(reports.at(-1)).toMatchObject({
      incarnation: "new", generation: "g", delivery_seq: 12, stage: "submitted",
    });
  });

  it("settles the envelope identity captured before an async disposition", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliverySequencesForTurn: () => [] },
      now: () => "T",
    });
    const oldDelivery = envelope(13);
    reporter.capture(oldDelivery);
    currentIdentity = { incarnation: "new", generation: "g" };
    const newDelivery = envelope(13);
    reporter.queued(newDelivery);

    reporter.settleEnvelope(oldDelivery, "stale_skip");
    expect(reports).toEqual([
      expect.objectContaining({ incarnation: "new", generation: "g", delivery_seq: 13, stage: "queued" }),
    ]);
    reporter.settleEnvelope(newDelivery, "terminal_skip");
    expect(reports.at(-1)).toMatchObject({
      incarnation: "new", generation: "g", delivery_seq: 13, stage: "settled", reason: "terminal_skip",
    });
  });

  it("settles a stream that ends before its first handoff as failed_before_handoff", () => {
    const reports: Record<string, unknown>[] = [];
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliverySequencesForTurn: () => [3] },
      now: () => "T",
    });
    reporter.queued(envelope(3));
    reporter.settled("turn");
    expect(reports.at(-1)).toMatchObject({ stage: "settled", reason: "failed_before_handoff" });
  });

  it("settles a consumed reply only after its tool-result handoff", () => {
    const reports: Record<string, unknown>[] = [];
    const reply = envelope(9);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliverySequencesForTurn: () => [] },
      now: () => "T",
    });
    reporter.queued(reply);
    reporter.submittedEnvelopes("tool-turn", [reply], "tool_result");
    expect(reports.map(report => report.stage)).toEqual(["queued", "submitted"]);
    reporter.settled("tool-turn");
    expect(reports.at(-1)).toMatchObject({ stage: "settled", reason: "turn_end" });
  });

  it("bounds unresolved local deliveries and warns only once while full", () => {
    const reports: Record<string, unknown>[] = [];
    const onOverflow = vi.fn();
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliverySequencesForTurn: () => [] },
      onOverflow,
      now: () => "T",
    });
    for (let sequence = 1; sequence <= 512; sequence += 1) reporter.queued(envelope(sequence));
    reporter.queued(envelope(513));
    reporter.queued(envelope(514));
    expect(reports).toHaveLength(512);
    expect(onOverflow).toHaveBeenCalledOnce();
  });
});
