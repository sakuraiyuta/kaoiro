import { describe, expect, it } from "vitest";
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
      send: report => reports.push(report),
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

  it("does not invent an incarnation when the join did not provide one", () => {
    const reports: unknown[] = [];
    const reporter = new DeliveryStageReporter({
      send: report => reports.push(report),
      identity: () => null,
      turns: { deliverySequencesForTurn: () => [7] },
      now: () => "T",
    });
    reporter.queued(envelope(7));
    reporter.submitted("turn", "exec_input_written");
    reporter.settled("turn");
    expect(reports).toEqual([]);
  });

  it("settles a stream that ends before its first handoff as failed_before_handoff", () => {
    const reports: Record<string, unknown>[] = [];
    const reporter = new DeliveryStageReporter({
      send: report => reports.push(report),
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliverySequencesForTurn: () => [3] },
      now: () => "T",
    });
    reporter.queued(envelope(3));
    reporter.settled("turn");
    expect(reports.at(-1)).toMatchObject({ stage: "settled", reason: "failed_before_handoff" });
  });
});
