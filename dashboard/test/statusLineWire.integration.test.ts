// @vitest-environment jsdom
// Issue 482 on the real phoenix client: the three server events reach the
// handlers parsed, and the two requests leave with the right frame and settle on
// what the server answered. Only the WebSocket is a fake; it answers every push
// from a table the test sets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro, type KaoiroConnection, type KaoiroHandlers } from "../src/lib/protocol";

type Frame = { joinRef: string | null; ref: string | null; topic: string; event: string; payload: any };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static replies = new Map<string, { status: "ok" | "error"; response: unknown }>();
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Frame[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data !== "string") return;
    const [joinRef, ref, topic, event, payload] = JSON.parse(data) as [string | null, string | null, string, string, any];
    this.sent.push({ joinRef, ref, topic, event, payload });
    const reply = FakeWebSocket.replies.get(event) ?? { status: "ok" as const, response: {} };
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.onmessage?.({ data: JSON.stringify([joinRef, ref, topic, "phx_reply", reply]) });
    }, 0);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5);
}

async function connect(handlers: Partial<KaoiroHandlers> = {}): Promise<{ conn: KaoiroConnection; ws: FakeWebSocket }> {
  const required = { onStatus: vi.fn(), onSnapshot: vi.fn(), onEnvelope: vi.fn(), onHosts: vi.fn() };
  const conn = connectKaoiro("ws://test/client", { ...required, ...handlers }, { transport: FakeWebSocket, heartbeatIntervalMs: 1000 });
  await settle();
  const ws = FakeWebSocket.instances[0];
  if (ws === undefined) throw new Error("no fake WebSocket");
  return { conn, ws };
}

function push(ws: FakeWebSocket, event: string, payload: unknown): void {
  ws.onmessage?.({ data: JSON.stringify([null, null, "agents:lobby", event, payload]) });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.replies = new Map();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const ROW = { seq: 2, head: "working", truncated: false, bytes: 7, updated_at: "2026-10-03T12:00:00.000001Z" };

describe("status line events", () => {
  it("hand the parsed snapshot, line and settings to the handlers", async () => {
    const onStatusLineSnapshot = vi.fn();
    const onStatusLine = vi.fn();
    const onStatusLineSettings = vi.fn();
    const { ws } = await connect({ onStatusLineSnapshot, onStatusLine, onStatusLineSettings });

    push(ws, "status_line_snapshot", {
      version: "0",
      agents: { "a.one": ROW, "a.cleared": { seq: 3, cleared: true, updated_at: "t" } },
      snapshot_incomplete: true,
    });
    push(ws, "status_line", { version: "0", agent_id: "a.one", ...ROW });
    push(ws, "status_line_settings", { version: "0", retention: 5, source: "stored", min: 1, max: 100 });

    expect(onStatusLineSnapshot).toHaveBeenCalledWith(
      {
        "a.one": { cleared: false, seq: 2, head: "working", truncated: false, bytes: 7, updatedAt: ROW.updated_at },
        "a.cleared": { cleared: true, seq: 3, updatedAt: "t" },
      },
      true,
    );
    expect(onStatusLine).toHaveBeenCalledWith("a.one", expect.objectContaining({ cleared: false, seq: 2 }));
    expect(onStatusLineSettings).toHaveBeenCalledWith({ retention: 5, source: "stored", min: 1, max: 100 });
  });

  it("ignore a payload they cannot vouch for", async () => {
    const onStatusLineSnapshot = vi.fn();
    const onStatusLine = vi.fn();
    const onStatusLineSettings = vi.fn();
    const { ws } = await connect({ onStatusLineSnapshot, onStatusLine, onStatusLineSettings });

    push(ws, "status_line_snapshot", { version: "0" });
    push(ws, "status_line", { version: "0", agent_id: "a.one", seq: 0 });
    push(ws, "status_line", { version: "0", seq: 1, head: "h", truncated: false, bytes: 1, updated_at: "t" });
    push(ws, "status_line_settings", { version: "0", retention: "20" });

    expect(onStatusLineSnapshot).not.toHaveBeenCalled();
    expect(onStatusLine).not.toHaveBeenCalled();
    expect(onStatusLineSettings).not.toHaveBeenCalled();
  });
});

describe("fetchStatusLineHistory", () => {
  it("asks for the agent's log and resolves the entries newest first", async () => {
    FakeWebSocket.replies.set("status_line_history", {
      status: "ok",
      response: {
        entries: [
          { seq: 2, text: null, updated_at: "b" },
          { seq: 1, text: "first", bytes: 5, updated_at: "a" },
        ],
      },
    });
    const { conn, ws } = await connect();

    const pending = conn.fetchStatusLineHistory("a.one");
    await settle();

    expect(ws.sent.find((f) => f.event === "status_line_history")?.payload).toEqual({ agent_id: "a.one", version: "0" });
    await expect(pending).resolves.toEqual([
      { seq: 2, text: null, bytes: null, updatedAt: "b" },
      { seq: 1, text: "first", bytes: 5, updatedAt: "a" },
    ]);
  });

  it.each(["unknown_agent", "status_line_unavailable", "forbidden"])("rejects with the server's reason %s", async (reason) => {
    FakeWebSocket.replies.set("status_line_history", { status: "error", response: { reason } });
    const { conn } = await connect();

    const pending = conn.fetchStatusLineHistory("a.one");
    const assertion = expect(pending).rejects.toThrow(reason);
    await settle();

    await assertion;
  });

  it("rejects when the reply is not a list of entries", async () => {
    FakeWebSocket.replies.set("status_line_history", { status: "ok", response: { entries: "nope" } });
    const { conn } = await connect();

    const pending = conn.fetchStatusLineHistory("a.one");
    const assertion = expect(pending).rejects.toThrow("error");
    await settle();

    await assertion;
  });
});

describe("setStatusLineRetention", () => {
  it("pushes the retention with a flat version and resolves on ok", async () => {
    const { conn, ws } = await connect();

    const pending = conn.setStatusLineRetention(7);
    await settle();

    expect(ws.sent.find((f) => f.event === "set_status_line_retention")?.payload).toEqual({ retention: 7, version: "0" });
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects with the server's reason", async () => {
    FakeWebSocket.replies.set("set_status_line_retention", { status: "error", response: { reason: "invalid_status_line_retention" } });
    const { conn } = await connect();

    const pending = conn.setStatusLineRetention(500);
    const assertion = expect(pending).rejects.toThrow("invalid_status_line_retention");
    await settle();

    await assertion;
  });
});
