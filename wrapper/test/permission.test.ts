import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  PermissionBroker,
} from "../src/permission.js";
import type { Envelope, WrapperConfig } from "../src/types.js";

const config: WrapperConfig = {
  agent_id: "test.perm",
  persona: { id: "ao", name: "あお", sprite_set: "ao" },
};

function makeBroker(overrides: { timeoutMs?: number } = {}) {
  const sent: Envelope[] = [];
  let counter = 0;
  const broker = new PermissionBroker({
    config,
    send: (envelope) => sent.push(envelope),
    now: () => "2026-06-11T00:00:00Z",
    newId: () => `req-${++counter}`,
    ...overrides,
  });
  return { broker, sent };
}

describe("PermissionBroker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decide は permission_request エンベロープを送る", () => {
    const { broker, sent } = makeBroker();

    void broker.decide("Bash", { command: "ls" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "permission_request",
      state: "waiting_permission",
      agent_id: "test.perm",
      payload: {
        request_id: "req-1",
        tool_name: "Bash",
        input: { command: "ls" },
      },
    });
  });

  it("permission_decision の relay で resolve する", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide("Bash", {});
    broker.resolve({ request_id: "req-1", allow: true });

    await expect(pending).resolves.toStrictEqual({ allow: true });
  });

  it("deny の message を伝える", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide("Bash", {});
    broker.resolve({ request_id: "req-1", allow: false, message: "却下" });

    await expect(pending).resolves.toEqual({ allow: false, message: "却下" });
  });

  it("無応答は既定 600 秒で deny (fail-closed、ADR-0011)", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide("Bash", {});
    vi.advanceTimersByTime(DEFAULT_PERMISSION_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({
      allow: false,
      message: "kaoiro: permission request timed out",
    });
  });

  it("タイムアウト後の遅延 decision は無視される", async () => {
    const { broker } = makeBroker({ timeoutMs: 1000 });

    const pending = broker.decide("Bash", {});
    vi.advanceTimersByTime(1000);
    broker.resolve({ request_id: "req-1", allow: true });

    await expect(pending).resolves.toMatchObject({ allow: false });
  });

  it("未知の request_id は無視される", () => {
    const { broker } = makeBroker();
    expect(() =>
      broker.resolve({ request_id: "req-none", allow: true }),
    ).not.toThrow();
  });

  it("16KB 超の input は payload から落とし truncated を立てる", () => {
    const { broker, sent } = makeBroker();

    void broker.decide("Write", { content: "x".repeat(20_000) });

    expect(sent[0]?.payload).toMatchObject({
      tool_name: "Write",
      truncated: true,
    });
    expect(sent[0]?.payload).not.toHaveProperty("input");
  });

  it("close は保留中の要求を全て deny で解決する", async () => {
    const { broker } = makeBroker();

    const a = broker.decide("Bash", {});
    const b = broker.decide("Write", {});
    broker.close();

    await expect(a).resolves.toMatchObject({ allow: false });
    await expect(b).resolves.toMatchObject({ allow: false });
  });
});
