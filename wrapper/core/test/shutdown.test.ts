import { afterEach, describe, expect, it, vi } from "vitest";
import { WrapperShutdown } from "../src/shutdown.js";

afterEach(() => vi.useRealTimers());

describe("WrapperShutdown", () => {
  it("runs each cleanup phase once and bounds retirement and disconnect waits", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let now = 0;
    let retirementSignal: AbortSignal | undefined;
    let disconnectSignal: AbortSignal | undefined;
    let linkCloseSignal: AbortSignal | undefined;
    const shutdown = new WrapperShutdown({
      begin: reason => { events.push(`begin:${reason}`); },
      flushRetirements: signal => {
        events.push("flush");
        retirementSignal = signal;
        return new Promise(resolve => signal.addEventListener("abort", () => resolve("unconfirmed"), { once: true }));
      },
      closeRetirementRequests: () => { events.push("retirements-closed"); },
      reportDisconnectIntent: (reason, options) => {
        events.push(`disconnect:${reason}`);
        disconnectSignal = options.signal;
        return new Promise(resolve => options.signal?.addEventListener("abort", () => resolve(false), { once: true }));
      },
      closeLink: signal => {
        events.push("close");
        linkCloseSignal = signal;
        return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    }, 100, () => now);

    const advance = async (milliseconds: number): Promise<void> => {
      now += milliseconds;
      await vi.advanceTimersByTimeAsync(milliseconds);
    };

    const first = shutdown.start("stop");
    expect(shutdown.start("crash")).toBe(first);
    await advance(0);
    expect(events).toEqual(["begin:stop", "flush"]);

    await advance(70);
    expect(retirementSignal?.aborted).toBe(true);
    expect(events).toEqual(["begin:stop", "flush", "retirements-closed", "disconnect:stop"]);

    await advance(20);
    expect(disconnectSignal?.aborted).toBe(true);
    expect(linkCloseSignal?.aborted).toBe(false);
    await advance(5);
    expect(linkCloseSignal?.aborted).toBe(true);
    await first;
    expect(events).toEqual(["begin:stop", "flush", "retirements-closed", "disconnect:stop", "close"]);
  });
});
