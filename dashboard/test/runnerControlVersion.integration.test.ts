// @vitest-environment jsdom
// Regression coverage for issue #182 (ADR-0015): the client -> server
// runner-control relay events (`stop` / `enumerate_sessions` /
// `refresh_engine_catalog`) must carry a flat `version` key so the
// server's relay_to_runner/4 has a value to compare instead of silently
// normalizing an absent one (protocol.md 「version」節).
//
// Drives the REAL phoenix client (only the WebSocket transport is a fake),
// same pattern as reconnect.integration.test.ts, but this fake additionally
// auto-acks every push with a generic "ok" phx_reply so `pushAsync()`
// promises resolve and the channel actually reaches the "joined" state
// (Phoenix buffers pushes made before join completes, then flushes them).
// This asserts what actually leaves the socket, not a stubbed connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro, type KaoiroConnection } from "../src/lib/protocol";

type WireFrame = {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: unknown;
};

class AckingWebSocket {
  static instances: AckingWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = AckingWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: WireFrame[] = [];

  constructor(public url: string) {
    AckingWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === AckingWebSocket.CLOSED) return;
      this.readyState = AckingWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    const [joinRef, ref, topic, event, payload] = JSON.parse(data) as [
      string | null,
      string | null,
      string,
      string,
      unknown,
    ];
    this.sent.push({ joinRef, ref, topic, event, payload });
    // Generic ok-ack for every push (join, heartbeat, operator control
    // pushes alike) — this fixture only asserts outgoing payload shape,
    // never real server behaviour.
    setTimeout(() => {
      if (this.readyState !== AckingWebSocket.OPEN) return;
      const reply = [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }];
      this.onmessage?.({ data: JSON.stringify(reply) });
    }, 0);
  }

  close(): void {
    this.readyState = AckingWebSocket.CLOSED;
  }
}

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onEnvelope: vi.fn(),
    onHosts: vi.fn(),
  };
}

/** Advances fake timers in small steps so every hop of the join/ack
 *  round-trip (WS open -> phx_join send -> reply schedule -> onmessage ->
 *  channel "joined") settles, without depending on the exact hop count. */
async function settleSocket(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(5);
  }
}

async function connectAndJoin(): Promise<{
  conn: KaoiroConnection;
  ws: AckingWebSocket;
}> {
  const conn = connectKaoiro("ws://test/client", makeHandlers(), {
    transport: AckingWebSocket,
    heartbeatIntervalMs: 1000,
  });
  await settleSocket();
  const ws = AckingWebSocket.instances[0];
  if (ws === undefined) throw new Error("fake WebSocket was not created");
  return { conn, ws };
}

function payloadOf(ws: AckingWebSocket, event: string): Record<string, unknown> {
  const frame = ws.sent.find((f) => f.event === event);
  if (frame === undefined) throw new Error(`no "${event}" frame was sent`);
  return frame.payload as Record<string, unknown>;
}

beforeEach(() => {
  AckingWebSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runner-control relay events carry version (issue #182, ADR-0015)", () => {
  // Every case fires the push first, then advances fake timers with
  // settleSocket() so the auto-ack reply (a fake `setTimeout`) can run
  // before the returned promise is awaited — under vi.useFakeTimers() a
  // bare `await` on a timer-dependent promise never settles on its own.
  it("stop", async () => {
    const { conn, ws } = await connectAndJoin();
    const pending = conn.stop("hostA.abc123");
    await settleSocket();
    await pending;
    expect(payloadOf(ws, "stop").version).toBe("0");
  });

  it("enumerateSessions", async () => {
    const { conn, ws } = await connectAndJoin();
    const pending = conn.enumerateSessions("hostA", "/workspace");
    await settleSocket();
    await pending;
    expect(payloadOf(ws, "enumerate_sessions").version).toBe("0");
  });

  it("enumerateAgentSessions", async () => {
    const { conn, ws } = await connectAndJoin();
    const pending = conn.enumerateAgentSessions("hostA.abc123");
    await settleSocket();
    await pending;
    expect(payloadOf(ws, "enumerate_sessions").version).toBe("0");
  });

  it("refreshEngineCatalog", async () => {
    const { conn, ws } = await connectAndJoin();
    // catalogPending only resolves on a catalog_result broadcast the fake
    // server never sends; only the outgoing push frame is under test here.
    void conn.refreshEngineCatalog("hostA", "claude-code").catch(() => {});
    await settleSocket();
    expect(payloadOf(ws, "refresh_engine_catalog").version).toBe("0");
  });

  it("restore (対象外イベント) には version を付与しない — スコープの pin", async () => {
    const { conn, ws } = await connectAndJoin();
    const pending = conn.restore("hostA.abc123");
    await settleSocket();
    await pending;
    expect(payloadOf(ws, "restore").version).toBeUndefined();
  });

  // issue #88 (ふじ review 2026-08-05, must-fix 2): launch_defaults never
  // touches the runner, but ADR-0015 stamps `version` on ALL three-party
  // messages, not only the runner-relay subset this file's title covers —
  // `restore`'s no-version case above pins an EXISTING gap in that other
  // subset, not a license to omit version from a NEW event.
  it("launch_defaults には version を付与する (ADR-0015)", async () => {
    const { conn, ws } = await connectAndJoin();
    const pending = conn.getLaunchDefaults();
    await settleSocket();
    await pending;
    expect(payloadOf(ws, "launch_defaults").version).toBe("0");
  });
});
