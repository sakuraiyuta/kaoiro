import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "@kaoiro/protocol";
import { DeliveryRecovery, type DeliveryResyncReply } from "../src/delivery_recovery.js";

const envelope = (seq: number) => ({ delivery_seq: seq } as unknown as Envelope);
const status = (issued_seq: number, acked_seq: number) => ({ issued_seq, acked_seq });

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const request = vi.fn<(_: unknown) => Promise<DeliveryResyncReply | null>>().mockResolvedValue(null);
  const resolved = vi.fn();
  const resendAck = vi.fn();
  const unavailable = vi.fn();
  return { recovery: new DeliveryRecovery({ request, resolved, resendAck, unavailable }), request, resolved, resendAck, unavailable };
}

describe("delivery recovery", () => {
  it("retires an explicitly discarded queued input without retiring its active sibling", async () => {
    const { recovery, request } = setup();
    recovery.join(true, status(0, 0));
    recovery.receive(envelope(1));
    recovery.receive(envelope(2));
    recovery.observe(status(2, 0));
    recovery.retire([envelope(2)]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ missing_ranges: [[2, 2]], reason: "interrupted" }), expect.any(AbortSignal));
    recovery.dispose();
  });

  it("finds an interior loss after the join cutoff without retiring a received queued turn", async () => {
    const { recovery, request } = setup();
    recovery.join(true, status(67, 67));
    recovery.receive(envelope(69));
    recovery.observe(status(69, 67));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ cutoff: 69, missing_ranges: [[68, 68]] }), expect.any(AbortSignal));
    recovery.dispose();
  });

  it("does not apply an older timer's grace to newly issued sequences", async () => {
    const { recovery, request } = setup();
    recovery.join(true, status(0, 0));
    recovery.observe(status(1, 0));
    await vi.advanceTimersByTimeAsync(29_000);
    recovery.observe(status(2, 0));
    recovery.receive(envelope(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ missing_ranges: [[2, 2]] }), expect.any(AbortSignal));
    recovery.dispose();
  });

  it("quarantines late frames through response loss and retries the exact retirement", async () => {
    const { recovery, request, resolved } = setup();
    recovery.join(true, status(2, 0));
    expect(recovery.receive(envelope(1))).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const first = request.mock.calls[0]![0];
    recovery.disconnected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({ delivery: status(2, 2), skipped_ranges: [[1, 2]] });
    recovery.join(true, status(2, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenLastCalledWith(first, expect.any(AbortSignal));
    expect(resolved).toHaveBeenCalledOnce();
    expect(recovery.receive(envelope(2))).toBe(false);
    recovery.dispose();
  });

  it("replays a dropped ack at rejoin and does not skip confirmed or received inputs", () => {
    const { recovery, request, resendAck } = setup();
    recovery.receive(envelope(1));
    recovery.confirm(1);
    recovery.receive(envelope(2));
    recovery.join(true, status(2, 0));
    expect(resendAck).toHaveBeenCalledWith(1);
    expect(request).not.toHaveBeenCalled();
    recovery.dispose();
  });

  it("never sends recovery requests to a legacy server", async () => {
    const { recovery, request, unavailable } = setup();
    recovery.join(false, status(2, 0));
    recovery.observe(status(3, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it("limits a retirement page to 256 sequences", () => {
    const { recovery, request } = setup();
    recovery.join(true, status(10_000, 0));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ missing_ranges: [[1, 256]] }), expect.any(AbortSignal));
    recovery.dispose();
  });

  it("returns unconfirmed when a retirement flush reaches its cutoff", async () => {
    const { recovery, request } = setup();
    let resolveRequest!: (reply: DeliveryResyncReply | null) => void;
    request.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve; }));
    recovery.join(true, status(1, 0));
    recovery.receive(envelope(1));
    recovery.retire([envelope(1)]);
    const controller = new AbortController();
    const flushed = recovery.flushRetirements(controller.signal);

    controller.abort();

    await expect(flushed).resolves.toBe("unconfirmed");
    resolveRequest({ delivery: status(1, 1), skipped_ranges: [[1, 1]] });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it("stops all later retirement and gap-resync requests at the flush cutoff", async () => {
    const { recovery, request } = setup();
    recovery.join(true, status(1, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    recovery.stopRetirementRequests();
    expect(recovery.retire([envelope(1)])).toBe(false);
    recovery.join(true, status(1, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledOnce();
    recovery.dispose();
  });
});
