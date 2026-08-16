import { describe, expect, it } from "vitest";
import {
  DeliveryAcknowledger,
  createDeliveryAcknowledgementWiring,
} from "../src/delivery_ack.js";
import type { Envelope } from "../src/types.js";

describe("DeliveryAcknowledger (issue #247)", () => {
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
});
