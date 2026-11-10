import "./isolation.setup";
// @vitest-environment jsdom
// Issue #537 on the real phoenix client: the snapshot reaches the handler
// parsed, the six room requests leave with the right frame, and each settles on
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

function sentFrame(ws: FakeWebSocket, event: string): Frame | undefined {
  return ws.sent.find((frame) => frame.event === event);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.replies = new Map();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rooms_snapshot", () => {
  it("hands the parsed snapshot to the handler", async () => {
    const onRoomsSnapshot = vi.fn();
    const { ws } = await connect({ onRoomsSnapshot });

    push(ws, "rooms_snapshot", {
      version: "0",
      rooms: [{ id: "lobby", name: null }, { id: "r1", name: "Review" }],
      memberships: { "h.a": "r1" },
      snapshot_incomplete: true,
    });

    expect(onRoomsSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = onRoomsSnapshot.mock.calls[0]![0];
    expect(snapshot.rooms).toEqual([{ id: "lobby", name: null }, { id: "r1", name: "Review" }]);
    expect(snapshot.memberships.get("h.a")).toBe("r1");
    expect(snapshot.incomplete).toBe(true);
  });

  it("ignores a payload it cannot vouch for", async () => {
    const onRoomsSnapshot = vi.fn();
    const { ws } = await connect({ onRoomsSnapshot });

    push(ws, "rooms_snapshot", { version: "0" });
    push(ws, "rooms_snapshot", { version: "0", rooms: [{ id: "r1", name: "no lobby" }], memberships: {} });

    expect(onRoomsSnapshot).not.toHaveBeenCalled();
  });
});

describe("room requests", () => {
  it("send the frame the server documents and resolve on its reply", async () => {
    FakeWebSocket.replies.set("create_room", { status: "ok", response: { room: { id: "r1", name: "Review" } } });
    FakeWebSocket.replies.set("rename_room", { status: "ok", response: { room: { id: "r1", name: "Docs" } } });
    FakeWebSocket.replies.set("delete_room", { status: "ok", response: { closed_count: 1, member_count: 2 } });
    FakeWebSocket.replies.set("move_agent", { status: "ok", response: { closed_count: 0, member_count: 1 } });
    FakeWebSocket.replies.set("preview_room_move", { status: "ok", response: { closing_count: 3, member_count: 1 } });
    FakeWebSocket.replies.set("preview_room_delete", { status: "ok", response: { closing_count: 4, member_count: 5 } });
    const { conn, ws } = await connect();

    const results = [
      conn.createRoom("Review"),
      conn.renameRoom("r1", "Docs"),
      conn.deleteRoom("r1"),
      conn.moveAgent("h.a", "r1"),
      conn.previewRoomMove("h.a", "r1"),
      conn.previewRoomDelete("r1"),
    ];
    await settle();

    expect(sentFrame(ws, "create_room")?.payload).toEqual({ name: "Review", version: "0" });
    expect(sentFrame(ws, "rename_room")?.payload).toEqual({ room_id: "r1", name: "Docs", version: "0" });
    expect(sentFrame(ws, "delete_room")?.payload).toEqual({ room_id: "r1", version: "0" });
    expect(sentFrame(ws, "move_agent")?.payload).toEqual({ agent_id: "h.a", room_id: "r1", version: "0" });
    expect(sentFrame(ws, "preview_room_move")?.payload).toEqual({ agent_id: "h.a", room_id: "r1", version: "0" });
    expect(sentFrame(ws, "preview_room_delete")?.payload).toEqual({ room_id: "r1", version: "0" });
    expect(await Promise.all(results)).toEqual([
      { id: "r1", name: "Review" },
      { id: "r1", name: "Docs" },
      { closedCount: 1, movedCount: 2 },
      { closedCount: 0, movedCount: 1 },
      { closingCount: 3, memberCount: 1 },
      { closingCount: 4, memberCount: 5 },
    ]);
  });

  it.each(["forbidden", "rooms_unavailable", "room_change_unconfirmed", "lobby_protected", "unknown_room"])(
    "reject with the server's code %s",
    async (reason) => {
      FakeWebSocket.replies.set("delete_room", { status: "error", response: { reason } });
      const { conn } = await connect();

      const pending = conn.deleteRoom("r1");
      const outcome = expect(pending).rejects.toThrow(new Error(reason));
      await settle();
      await outcome;
    },
  );

  it("reject with invalid_reply when the answer is not a count", async () => {
    FakeWebSocket.replies.set("move_agent", { status: "ok", response: { closed_count: "many" } });
    const { conn } = await connect();

    const pending = conn.moveAgent("h.a", "r1");
    const outcome = expect(pending).rejects.toThrow(new Error("invalid_reply"));
    await settle();
    await outcome;
  });
});
