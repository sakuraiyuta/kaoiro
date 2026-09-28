import { describe, expect, it } from "vitest";
import {
  DeliveryAcknowledger,
  DeliveryAcknowledgement,
  createDeliveryAcknowledgementRuntime,
  createDeliveryAcknowledgementWiring,
} from "../src/delivery_ack.js";
import type { Envelope } from "../src/types.js";

describe("DeliveryAcknowledger (issue #247)", () => {
  it("continues completed turns after the server retires a missing sequence", () => {
    const sent: number[] = [];
    const acknowledgement = new DeliveryAcknowledgement((seq) => sent.push(seq));
    acknowledgement.observe({ acked_seq: 67 });
    acknowledgement.acknowledgeEnvelope({ delivery_seq: 69 } as unknown as Envelope);
    acknowledgement.acknowledgeEnvelope({ delivery_seq: 70 } as unknown as Envelope);
    expect(sent).toEqual([]);
    acknowledgement.observe({ acked_seq: 68 });
    expect(sent).toEqual([70]);
  });

  it("retains an out-of-order retirement behind a received unstarted input", () => {
    const sent: number[] = [];
    const acknowledgement = new DeliveryAcknowledgement((seq) => sent.push(seq));
    acknowledgement.observe({ acked_seq: 0, skipped_ranges: [[2, 2]] });
    expect(sent).toEqual([]);
    acknowledgement.acknowledgeEnvelope({ delivery_seq: 1 } as unknown as Envelope);
    expect(sent).toEqual([2]);
  });
  it("out-of-order SDK starts only acknowledge the contiguous prefix", () => {
    const ledger = new DeliveryAcknowledger();
    expect(ledger.bind(4)).toBeNull();
    expect(ledger.complete(6)).toBeNull();
    expect(ledger.complete(5)).toBe(6);
  });

  it("invalid, duplicate, and already-confirmed numbers never move the watermark", () => {
    const ledger = new DeliveryAcknowledger();
    ledger.bind(1);
    expect(ledger.complete(0)).toBeNull();
    expect(ledger.complete(1)).toBeNull();
    expect(ledger.complete(2)).toBe(2);
    expect(ledger.complete(2)).toBeNull();
  });

  it("bounds out-of-order completions and fails closed until the prefix drains", () => {
    const ledger = new DeliveryAcknowledger();
    for (let seq = 2; seq <= 1_001; seq += 1) expect(ledger.complete(seq)).toBeNull();
    expect(ledger.complete(1_002)).toBeNull();
    expect(ledger.complete(1)).toBe(1_001);
    expect(ledger.complete(1_002)).toBe(1_002);
  });

  function productionWiring(sequences: Record<string, readonly number[]>) {
    const sent: number[] = [];
    const wiring = createDeliveryAcknowledgementWiring(
      (seq) => sent.push(seq),
      { deliverySequencesForTurn: (turnToken) => sequences[turnToken] ?? [] },
    );
    return { sent, wiring };
  }

  it("production wiring takes the ServerLink delivery-status edge", () => {
    const { sent, wiring } = productionWiring({ "sdk-turn": [2] });

    wiring.onInterAgentDeliveryStatus({ acked_seq: 1 });
    wiring.onTurnStart("sdk-turn");
    expect(sent).toEqual([2]);
  });

  it("production wiring takes the non-injection handler edge", () => {
    const { sent, wiring } = productionWiring({});

    wiring.onInterAgentDeliveryStatus({ acked_seq: 0 });
    wiring.acknowledgeDelivery({ delivery_seq: 1 } as unknown as Envelope);
    expect(sent).toEqual([1]);
  });

  it("production wiring takes the actual host turn-start edge", () => {
    const { sent, wiring } = productionWiring({ "sdk-turn": [1] });

    wiring.onInterAgentDeliveryStatus({ acked_seq: 0 });
    wiring.onTurnStart("sdk-turn");
    expect(sent).toEqual([1]);
  });

  it("preserves legacy dispatch acknowledgements when the server has no incarnation", () => {
    const sent: number[] = [];
    const envelope = { delivery_seq: 1 } as unknown as Envelope;
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => sent.push(seq),
      { deliverySequencesForTurn: () => [1], deliveryEnvelopesForTurn: () => [envelope] },
      () => null,
    );
    runtime.withServerLinkOptions({}).onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(envelope);
    runtime.acknowledgeDelivery(envelope);
    expect(sent).toEqual([1]);
  });

  it("an SDK notification turn does not acknowledge queued wrapper delivery", () => {
    const sent: number[] = [];
    const runtime = createDeliveryAcknowledgementRuntime(
      (seq) => sent.push(seq),
      { deliverySequencesForTurn: () => [1] },
    );
    const host = runtime.withHostOptions({});
    runtime.withServerLinkOptions({}).onInterAgentDeliveryStatus({ acked_seq: 0 });
    host.onTurnStart({ turnToken: "notification", kind: "sdk_notification" });
    expect(sent).toEqual([]);
    host.onTurnStart({ turnToken: "wrapper", kind: "wrapper_input" });
    expect(sent).toEqual([1]);
  });

  it("drops a delayed old-identity ack instead of confirming a reused new sequence", () => {
    const sent: number[] = [];
    let identity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const old = { delivery_seq: 1 } as unknown as Envelope;
    const fresh = { delivery_seq: 1 } as unknown as Envelope;
    const turnItems: Record<string, readonly Envelope[]> = {
      "old-turn": [old],
      "new-turn": [fresh],
    };
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => sent.push(seq),
      {
        deliverySequencesForTurn: () => [1],
        deliveryEnvelopesForTurn: token => turnItems[token] ?? [],
      },
      () => identity,
    );
    const link = runtime.withServerLinkOptions({});
    const host = runtime.withHostOptions({});
    link.onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(old);

    identity = { incarnation: "new", generation: "g" };
    link.onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(fresh);
    runtime.acknowledgeDelivery(old);
    host.onTurnStart({ turnToken: "old-turn", kind: "wrapper_input" });
    expect(sent).toEqual([]);

    host.onTurnStart({ turnToken: "new-turn", kind: "wrapper_input" });
    expect(sent).toEqual([1]);
  });

  it("replays a completed watermark after a same-identity rejoin", async () => {
    const sent: number[] = [];
    const originalIdentity = { incarnation: "i", generation: "g" };
    let identity: { incarnation: string; generation: string } | null = originalIdentity;
    const envelope = { delivery_seq: 1 } as unknown as Envelope;
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => sent.push(seq),
      { deliverySequencesForTurn: () => [1], deliveryEnvelopesForTurn: () => [envelope] },
      () => identity,
    );
    const status = runtime.withServerLinkOptions({});
    const host = runtime.withHostOptions({});
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(envelope);

    identity = null;
    host.onTurnStart({ turnToken: "turn" });
    expect(sent).toEqual([]);

    identity = originalIdentity;
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    await Promise.resolve();
    expect(sent).toEqual([1]);
  });

  it("retires a disconnected watermark when a different identity joins", async () => {
    const sent: number[] = [];
    let identity: { incarnation: string; generation: string } | null = {
      incarnation: "old", generation: "g",
    };
    const old = { delivery_seq: 1 } as unknown as Envelope;
    const fresh = { delivery_seq: 1 } as unknown as Envelope;
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => sent.push(seq),
      {
        deliverySequencesForTurn: () => [1],
        deliveryEnvelopesForTurn: token => token === "old" ? [old] : [fresh],
      },
      () => identity,
    );
    const status = runtime.withServerLinkOptions({});
    const host = runtime.withHostOptions({});
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(old);
    identity = null;
    host.onTurnStart({ turnToken: "old" });

    identity = { incarnation: "new", generation: "g" };
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    await Promise.resolve();
    expect(sent).toEqual([]);

    runtime.captureDelivery(fresh);
    host.onTurnStart({ turnToken: "fresh" });
    expect(sent).toEqual([1]);
  });

  it("does not replay a watermark already covered by the rejoin status", async () => {
    const sent: number[] = [];
    let identity: { incarnation: string; generation: string } | null = {
      incarnation: "i", generation: "g",
    };
    const envelope = { delivery_seq: 1 } as unknown as Envelope;
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => sent.push(seq),
      { deliverySequencesForTurn: () => [1], deliveryEnvelopesForTurn: () => [envelope] },
      () => identity,
    );
    const status = runtime.withServerLinkOptions({});
    const host = runtime.withHostOptions({});
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(envelope);
    identity = null;
    host.onTurnStart({ turnToken: "turn" });
    expect(sent).toEqual([]);
    identity = { incarnation: "i", generation: "g" };
    status.onInterAgentDeliveryStatus({ acked_seq: 1 });
    await Promise.resolve();
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  it("cancels a queued replay if the live identity changes before it runs", async () => {
    const sent: number[] = [];
    let identity: { incarnation: string; generation: string } | null = {
      incarnation: "i", generation: "g",
    };
    const envelope = { delivery_seq: 1 } as unknown as Envelope;
    const runtime = createDeliveryAcknowledgementRuntime(
      seq => sent.push(seq),
      { deliverySequencesForTurn: () => [1], deliveryEnvelopesForTurn: () => [envelope] },
      () => identity,
    );
    const status = runtime.withServerLinkOptions({});
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    runtime.captureDelivery(envelope);
    identity = null;
    runtime.withHostOptions({}).onTurnStart({ turnToken: "turn" });

    identity = { incarnation: "i", generation: "g" };
    status.onInterAgentDeliveryStatus({ acked_seq: 0 });
    identity = { incarnation: "replacement", generation: "g" };
    await Promise.resolve();
    expect(sent).toEqual([]);
  });
});
