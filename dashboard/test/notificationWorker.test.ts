import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "../src/lib/protocol";

const envelope: Envelope = {
  version: "0", agent_id: "a1", ts: "2026-06-16T00:00:00Z",
  type: "state", state: "waiting_input", display_name: "Agent",
};

class Worker extends EventTarget {
  state: ServiceWorkerState = "installing";
  setState(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("hand-wait notification worker", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function setup(options: { permission?: NotificationPermission; constructorThrows?: boolean; register?: () => Promise<unknown> } = {}) {
    const worker = new Worker();
    const show = vi.fn().mockResolvedValue(undefined);
    const reg = { active: null as Worker | null, installing: worker, waiting: null, showNotification: show };
    const register = vi.fn(options.register ?? (() => Promise.resolve(reg)));
    const create = vi.fn(function () { if (options.constructorThrows !== false) throw new TypeError("unsupported"); });
    Object.assign(create, { permission: options.permission ?? "granted" });
    const play = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    vi.stubGlobal("Notification", create);
    vi.stubGlobal("Audio", vi.fn(function () { return { volume: 0, play }; }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../src/lib/notify");
    mod.registerNotificationWorker();
    return { mod, worker, reg, register, create, show, play, warn };
  }

  it("keeps the page constructor when it succeeds", async () => {
    const s = await setup({ constructorThrows: false });
    s.mod.notifyWait(envelope);
    await flush();
    expect(s.register).toHaveBeenCalledWith("/notification-worker/sw.js");
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.create).toHaveBeenCalledWith("Agent", { body: "your turn", tag: "kaoiro:a1" });
    expect(s.show).not.toHaveBeenCalled();
    expect(s.play).toHaveBeenCalledOnce();
  });

  it("waits without blocking sound, then uses the same notification data", async () => {
    const s = await setup();
    expect(s.mod.notifyWait(envelope)).toBeUndefined();
    expect(s.play).toHaveBeenCalledOnce();
    await flush();
    expect(s.show).not.toHaveBeenCalled();
    s.reg.active = s.worker;
    s.worker.setState("activated");
    await flush();
    expect(s.show).toHaveBeenCalledExactlyOnceWith("Agent", { body: "your turn", tag: "kaoiro:a1" });
    expect(s.warn).not.toHaveBeenCalled();
  });

  it("observes an activating active worker even when another worker is installing", async () => {
    const s = await setup();
    const active = new Worker();
    active.setState("activating");
    s.reg.active = active;
    s.mod.notifyWait(envelope);
    await flush();
    active.setState("activated");
    await flush();
    expect(s.show).toHaveBeenCalledOnce();
  });

  it("expires independently and ignores a late activation", async () => {
    const s = await setup();
    s.mod.notifyWait(envelope);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.warn).toHaveBeenCalledOnce();
    s.reg.active = s.worker;
    s.worker.setState("activated");
    await flush();
    expect(s.show).not.toHaveBeenCalled();
    s.mod.notifyWait(envelope);
    await flush();
    expect(s.show).toHaveBeenCalledOnce();
  });

  it("shows two pending alerts independently when activation arrives before their deadlines", async () => {
    const s = await setup();
    s.mod.notifyWait(envelope);
    s.mod.notifyWait({ ...envelope, agent_id: "a2" });
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    s.reg.active = s.worker;
    s.worker.setState("activated");
    await flush();
    expect(s.show).toHaveBeenCalledTimes(2);
    expect(s.show.mock.calls.map((call) => call[1].tag)).toEqual(["kaoiro:a1", "kaoiro:a2"]);
  });

  it.each(["default", "denied"] as const)("skips notifications when permission is %s", async (permission) => {
    const s = await setup({ permission });
    s.mod.notifyWait(envelope);
    await flush();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.show).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.play).toHaveBeenCalledOnce();
  });

  it("warns once when registration fails", async () => {
    const s = await setup({ register: () => Promise.reject(new Error("unavailable")) });
    s.mod.notifyWait(envelope);
    s.mod.notifyWait(envelope);
    await flush();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(s.show).not.toHaveBeenCalled();
  });

  it("warns if the installing worker becomes redundant", async () => {
    const s = await setup();
    s.mod.notifyWait(envelope);
    await flush();
    s.worker.setState("redundant");
    await flush();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(s.show).not.toHaveBeenCalled();
  });

  it("warns once when showNotification rejects", async () => {
    const s = await setup();
    s.reg.active = s.worker;
    s.worker.setState("activated");
    s.show.mockRejectedValue(new Error("denied"));
    s.mod.notifyWait(envelope);
    s.mod.notifyWait(envelope);
    await flush();
    expect(s.show).toHaveBeenCalledTimes(2);
    expect(s.warn).toHaveBeenCalledOnce();
  });

  it("fails softly without a service worker", async () => {
    const s = await setup();
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const mod = await import("../src/lib/notify");
    mod.registerNotificationWorker();
    mod.notifyWait(envelope);
    await flush();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(s.play).toHaveBeenCalledOnce();
    expect(s.show).not.toHaveBeenCalled();
  });
});
