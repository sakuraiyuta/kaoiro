import { describe, expect, it } from "vitest";
import { DeliveryAcknowledger } from "../src/delivery_ack.js";

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
});
