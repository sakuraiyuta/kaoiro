import { describe, expect, it } from "vitest";
import {
  DeliveryAcknowledgement,
  DeliveryAcknowledger,
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

  it("production composition confirms non-injection and real turn-start through one object", () => {
    const sent: number[] = [];
    const acknowledgement = new DeliveryAcknowledgement((seq) => sent.push(seq));
    acknowledgement.observe({ acked_seq: 0 });

    acknowledgement.acknowledgeEnvelope({ delivery_seq: 1 } as unknown as Envelope);
    expect(sent).toEqual([1]);

    const turns = {
      deliverySequencesForTurn: (turnToken: string) =>
        turnToken === "sdk-turn" ? [3, 2] : [],
    };
    acknowledgement.acknowledgeTurnStart("sdk-turn", turns);
    expect(sent).toEqual([1, 3]);
  });
});
