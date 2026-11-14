import "./isolation.setup";
// @vitest-environment jsdom
// issue #1107: sendInstruction tells "not pushed" apart from "pushed, but no
// reply in time". Drives the real phoenix client; only the WebSocket is fake.
// A push made before the channel is joined would wait in phoenix's buffer and
// be dropped unsent on timeout, so it must be refused at once instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectKaoiro,
  INSTRUCTION_NOT_CONNECTED,
  INSTRUCTION_UNCONFIRMED,
  type KaoiroConnection,
} from "../src/lib/protocol";

type WireFrame = { joinRef: string | null; ref: string | null; topic: string; event: string };

/** Acks every push except the events listed in `silent`, which get no reply. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static silent = new Set<string>();
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: WireFrame[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    const [joinRef, ref, topic, event] = JSON.parse(data) as [
      string | null,
      string | null,
      string,
      string,
    ];
    this.sent.push({ joinRef, ref, topic, event });
    if (FakeWebSocket.silent.has(event)) return;
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      const reply = [joinRef, ref, topic, "phx_reply", { status: "ok", response: { delivery_policy_control: "v1" } }];
      this.onmessage?.({ data: JSON.stringify(reply) });
    }, 0);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** The server side drops the connection. */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

const connections: KaoiroConnection[] = [];

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.silent = new Set();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const conn of connections.splice(0)) conn.disconnect();
  vi.useRealTimers();
});

function connect(): KaoiroConnection {
  const conn = connectKaoiro(
    "ws://test/client",
    { onStatus: vi.fn(), onSnapshot: vi.fn(), onEnvelope: vi.fn(), onHosts: vi.fn() },
    { transport: FakeWebSocket, heartbeatIntervalMs: 60_000 },
  );
  connections.push(conn);
  return conn;
}

/** Lets every hop of the open -> join -> reply round trip settle. */
async function settleSocket(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5);
}

function instructionFrames(): WireFrame[] {
  return FakeWebSocket.instances.flatMap((ws) => ws.sent.filter((f) => f.event === "instruction"));
}

/** Records how a promise settles without awaiting it. */
function track(promise: Promise<void>): { outcome: string | undefined } {
  const state: { outcome: string | undefined } = { outcome: undefined };
  promise.then(
    () => (state.outcome = "ok"),
    (error: unknown) => (state.outcome = error instanceof Error ? error.message : String(error)),
  );
  return state;
}

describe("sendInstruction outcome (issue #1107)", () => {
  it("P1: a pushed instruction without a reply rejects as unconfirmed after the push timeout", async () => {
    FakeWebSocket.silent.add("instruction");
    const conn = connect();
    await settleSocket();
    const sent = track(conn.sendInstruction("host-a.p", "hello"));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sent.outcome).toBeUndefined();
    expect(instructionFrames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sent.outcome).toBe(INSTRUCTION_UNCONFIRMED);
    expect(instructionFrames()).toHaveLength(1);
  });

  it("P2a: before the first join completes, it is refused at once and never pushed", async () => {
    const conn = connect();
    const sent = track(conn.sendInstruction("host-a.p", "hello"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.outcome).toBe(INSTRUCTION_NOT_CONNECTED);
    await settleSocket();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(FakeWebSocket.instances[0]?.sent.some((f) => f.event === "phx_join")).toBe(true);
    expect(instructionFrames()).toHaveLength(0);
  });

  it("P2b: after the connection drops, it is refused at once", async () => {
    const conn = connect();
    await settleSocket();
    FakeWebSocket.instances[0]!.drop();
    const sent = track(conn.sendInstruction("host-a.p", "hello"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.outcome).toBe(INSTRUCTION_NOT_CONNECTED);
  });

  it("P3: control — a joined push that gets ok resolves", async () => {
    const conn = connect();
    await settleSocket();
    const sent = track(conn.sendInstruction("host-a.p", "hello"));
    await settleSocket();
    expect(sent.outcome).toBe("ok");
    expect(instructionFrames()).toHaveLength(1);
  });
});
