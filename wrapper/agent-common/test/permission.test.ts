import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fitsApprovalPayload,
  MAX_INPUT_BYTES,
  PermissionBroker,
} from "../src/permission.js";
import type {
  Envelope,
  PendingPermissionExt,
  WrapperConfig,
} from "../src/types.js";

const config: WrapperConfig = {
  agent_id: "test.perm",
  persona: { id: "ao", name: "あお", sprite_set: "ao" },
  display_name: "あお",
  server_url: "ws://localhost:4000/wrapper",
};

function makeBroker(
  overrides: {
    timeoutMs?: number;
    onPendingChange?: (pending: PendingPermissionExt | null) => void;
  } = {},
) {
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

  it("既定では timeout なし (SDK と同じく無制限待機、ADR-0022)", async () => {
    const { broker } = makeBroker();

    const pending = broker.decide("Bash", {});
    // 24h を仮想時間で進めても deny で解決しない。
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    const racer = Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r("still-pending"), 0)),
    ]);
    vi.advanceTimersByTime(1);
    await expect(racer).resolves.toBe("still-pending");

    broker.resolve({ request_id: "req-1", allow: true });
    await expect(pending).resolves.toMatchObject({ allow: true });
  });

  it("opt-in の有限 timeoutMs では fail-closed deny する", async () => {
    const { broker } = makeBroker({ timeoutMs: 5_000 });

    const pending = broker.decide("Bash", {});
    vi.advanceTimersByTime(5_000);

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

  it("onPendingChange は decide で pending、resolve で null を順に呼ぶ", async () => {
    const events: (PendingPermissionExt | null)[] = [];
    const { broker } = makeBroker({
      onPendingChange: (p) => events.push(p),
    });

    const pending = broker.decide("Bash", { command: "ls" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      request_id: "req-1",
      tool_name: "Bash",
      input: { command: "ls" },
      ts: "2026-06-11T00:00:00Z",
    });

    broker.resolve({ request_id: "req-1", allow: true });
    await pending;
    expect(events).toHaveLength(2);
    expect(events[1]).toBeNull();
  });

  it("falls the single slot back to a still-live request (issue #285 M2)", async () => {
    // ADR-0022 gives the wrapper ONE authoritative pending slot; concurrent
    // tool calls compete for it. Settling the newest must hand the slot back
    // to the older one rather than empty it, or that request stays hidden
    // from the operator with no way to answer it.
    const events: (PendingPermissionExt | null)[] = [];
    const { broker } = makeBroker({ onPendingChange: (p) => events.push(p) });

    const first = broker.decide("Bash", { command: "one" });
    const second = broker.decide("Bash", { command: "two" });
    expect(events.map((p) => p?.request_id ?? null)).toEqual(["req-1", "req-2"]);

    broker.resolve({ request_id: "req-2", allow: true });
    await second;
    expect(events[events.length - 1]).toMatchObject({ request_id: "req-1" });

    broker.resolve({ request_id: "req-1", allow: true });
    await first;
    expect(events[events.length - 1]).toBeNull();
  });

  it("onPendingChange は close でも null を呼ぶ", async () => {
    const events: (PendingPermissionExt | null)[] = [];
    const { broker } = makeBroker({
      onPendingChange: (p) => events.push(p),
    });

    const pending = broker.decide("Bash", {});
    broker.close();
    await pending;
    expect(events[events.length - 1]).toBeNull();
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

  // fitsApprovalPayload is exported so callers outside this class can fail
  // closed before an oversized input ever reaches decide(). Pin it against
  // decide()'s own truncated/not-truncated split, not a re-derived
  // expectation — two independently computed byte counts could agree by
  // coincidence and still drift later.
  it("fitsApprovalPayload は decide() の truncated 判定と一致する", () => {
    const { broker: brokerA, sent: sentA } = makeBroker();
    const underCap = { content: "x".repeat(100) };
    void brokerA.decide("Write", underCap);
    expect(fitsApprovalPayload(underCap)).toBe(true);
    expect(sentA[0]?.payload).not.toHaveProperty("truncated");

    const { broker: brokerB, sent: sentB } = makeBroker();
    const overCap = { content: "x".repeat(20_000) };
    void brokerB.decide("Write", overCap);
    expect(fitsApprovalPayload(overCap)).toBe(false);
    expect(sentB[0]?.payload).toMatchObject({ truncated: true });

    expect(MAX_INPUT_BYTES).toBe(16_384);
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
