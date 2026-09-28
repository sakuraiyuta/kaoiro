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
    const root = envelope(7);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "server-incarnation", generation: "wrapper-generation" }),
      turns: { deliveryEnvelopesForTurn: token => token === "turn" ? [root] : [] },
      now: () => "T",
    });
    reporter.queued(root);
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
    const root = envelope(7);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: () => [root] },
      now: () => "T",
    });
    reporter.queued(root);
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.submitted("turn", "exec_input_written");
    reporter.settled("turn");
    expect(reports).toEqual([]);
  });

  it("keeps a disconnected handoff in its captured identity and retires it after replacement", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const root = envelope(7);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: () => [root] },
      now: () => "T",
    });
    reporter.queued(root);
    currentIdentity = null;
    reporter.submitted("turn", "exec_input_written");
    expect(reports.at(-1)).toMatchObject({ incarnation: "old", generation: "g", delivery_seq: 7, stage: "submitted" });

    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.submitted("turn", "exec_input_written");
    expect(reports.filter(report => report.stage === "submitted")).toEqual([
      expect.objectContaining({ incarnation: "old", delivery_seq: 7 }),
    ]);
    const fresh = envelope(7);
    reporter.queued(fresh);
    expect(reports.at(-1)).toMatchObject({ incarnation: "new", delivery_seq: 7, stage: "queued" });
    expect(reports.filter(report => report.stage === "submitted")).toEqual([
      expect.objectContaining({ incarnation: "old", delivery_seq: 7 }),
    ]);
  });

  it("does not relabel an old turn when its sequence is reused after identity replacement", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const old = envelope(12);
    const fresh = envelope(12);
    const turnItems: Record<string, readonly Envelope[]> = { "old-turn": [old], "new-turn": [fresh] };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: token => turnItems[token] ?? [] },
      now: () => "T",
    });
    reporter.queued(old);
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.submitted("old-turn", "exec_input_written");
    expect(reports).toEqual([
      expect.objectContaining({ incarnation: "old", generation: "g", delivery_seq: 12, stage: "queued" }),
    ]);

    reporter.queued(fresh);
    reporter.submitted("new-turn", "exec_input_written");
    reporter.settled("old-turn");
    expect(reports.filter(report => report.stage === "settled")).toEqual([]);
    reporter.settled("new-turn");
    expect(reports.filter(report => report.incarnation === "new")).toEqual([
      expect.objectContaining({ delivery_seq: 12, stage: "queued" }),
      expect.objectContaining({ delivery_seq: 12, stage: "submitted" }),
      expect.objectContaining({ delivery_seq: 12, stage: "settled", reason: "turn_end" }),
    ]);
  });

  it("settles only the fresh record when a captured old receive completes late", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const old = envelope(7);
    const fresh = envelope(7);
    const turnItems: Record<string, readonly Envelope[]> = { "old-turn": [old], "new-turn": [fresh] };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: token => turnItems[token] ?? [] },
      now: () => "T",
    });
    reporter.capture(old);
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.queued(fresh);
    reporter.submitted("new-turn", "prompt_hook");
    reporter.queued(old);
    reporter.settleEnvelope(old, "stale_skip");
    reporter.settled("old-turn");
    reporter.settled("new-turn");
    expect(reports.filter(report => report.stage === "submitted")).toEqual([
      expect.objectContaining({ incarnation: "new", delivery_seq: 7 }),
    ]);
    expect(reports.filter(report => report.stage === "settled")).toEqual([
      expect.objectContaining({ incarnation: "new", delivery_seq: 7, reason: "turn_end" }),
    ]);
  });

  it("settles the captured envelope identity before an async disposition completes", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: () => [] },
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
    const root = envelope(3);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliveryEnvelopesForTurn: () => [root] },
      now: () => "T",
    });
    reporter.queued(root);
    reporter.settled("turn");
    expect(reports.at(-1)).toMatchObject({ stage: "settled", reason: "failed_before_handoff" });
  });

  it("settles a consumed reply only after its tool-result handoff", () => {
    const reports: Record<string, unknown>[] = [];
    const reply = envelope(9);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliveryEnvelopesForTurn: () => [] },
      now: () => "T",
    });
    reporter.queued(reply);
    reporter.submittedEnvelopes("tool-turn", [reply], "tool_result");
    expect(reports.map(report => report.stage)).toEqual(["queued", "submitted"]);
    reporter.settled("tool-turn");
    expect(reports.at(-1)).toMatchObject({ stage: "settled", reason: "turn_end" });
  });

  it("joins a reused sequence waiter reply to its exact identity in the live turn", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const root = envelope(7);
    const reply = envelope(7);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: () => [root] },
      now: () => "T",
    });
    reporter.queued(root);
    reporter.submitted("live-turn", "prompt_hook");
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.queued(reply);
    reporter.submittedEnvelopes("live-turn", [reply], "tool_result");
    expect(reports.filter(report => report.stage === "submitted" && report.incarnation === "new")).toEqual([
      expect.objectContaining({ delivery_seq: 7, handoff: "tool_result" }),
    ]);
    reporter.settled("live-turn");
    expect(reports.filter(report => report.stage === "settled" && report.incarnation === "new")).toEqual([
      expect.objectContaining({ delivery_seq: 7, reason: "turn_end" }),
    ]);
  });

  it("keeps a distinct-sequence waiter reply control", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const root = envelope(7);
    const reply = envelope(8);
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: () => [root] },
      now: () => "T",
    });
    reporter.queued(root);
    reporter.submitted("live-turn", "prompt_hook");
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.queued(reply);
    reporter.submittedEnvelopes("live-turn", [reply], "tool_result");
    expect(reports.filter(report => report.stage === "submitted" && report.incarnation === "new")).toEqual([
      expect.objectContaining({ delivery_seq: 8, handoff: "tool_result" }),
    ]);
    reporter.settled("live-turn");
    expect(reports.filter(report => report.stage === "settled" && report.incarnation === "new")).toEqual([
      expect.objectContaining({ delivery_seq: 8, reason: "turn_end" }),
    ]);
  });

  it("retires old identity records before applying the local capacity limit", () => {
    const reports: Record<string, unknown>[] = [];
    let currentIdentity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => currentIdentity,
      turns: { deliveryEnvelopesForTurn: () => [] },
      now: () => "T",
    });
    for (let sequence = 1; sequence <= 512; sequence += 1) reporter.capture(envelope(sequence));
    currentIdentity = { incarnation: "new", generation: "g" };
    reporter.queued(envelope(513));
    expect(reports).toEqual([
      expect.objectContaining({ incarnation: "new", delivery_seq: 513, stage: "queued" }),
    ]);
  });

  it("bounds unresolved local deliveries and warns only once while full", () => {
    const reports: Record<string, unknown>[] = [];
    const onOverflow = vi.fn();
    const reporter = new DeliveryStageReporter({
      send: report => { reports.push(report); },
      identity: () => ({ incarnation: "i", generation: "g" }),
      turns: { deliveryEnvelopesForTurn: () => [] },
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
