// @vitest-environment jsdom
// Wire glue for ADR-0051 that App.svelte cannot reach on its own: the lobby
// channel's join reply (which opens the D4 buffer window) and the
// `history_replay_envelope` push (ADR-0051 D3-3 追補 / ふじ 30-10 M2).
//
// Runs against the REAL phoenix client with only the WebSocket swapped, so
// the frame shapes — not a hand-rolled stand-in for them — are what decide
// whether `onJoined` / `onHistoryReplayEnvelope` fire.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro } from "../src/lib/protocol";

/** Minimal transport that opens on the next tick and lets the test both read
 *  what phoenix sent and feed frames back. */
class ReplyingWebSocket {
  static instances: ReplyingWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = ReplyingWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sentFrames: string[] = [];

  constructor(public url: string) {
    ReplyingWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState === ReplyingWebSocket.CLOSED) return;
      this.readyState = ReplyingWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(): void {
    this.readyState = ReplyingWebSocket.CLOSED;
  }

  /** The v2 JSON serializer frame: [join_ref, ref, topic, event, payload]. */
  deliver(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Answers the lobby's phx_join with `ok`, the way the server does. */
  ackJoin(): void {
    const join = this.sentFrames
      .map((raw) => JSON.parse(raw) as unknown[])
      .find((f) => f[3] === "phx_join" && f[2] === "agents:lobby");
    if (join === undefined) throw new Error("no phx_join frame was sent");
    this.deliver([join[0], join[1], "agents:lobby", "phx_reply", {
      status: "ok",
      response: {},
    }]);
  }
}

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onEnvelope: vi.fn(),
    onJoined: vi.fn(),
    onHistoryReplayEnvelope: vi.fn(),
  };
}

function interAgentEnvelope() {
  return {
    version: "0",
    agent_id: "agent-b",
    persona: { id: "b", name: "b", sprite_set: "b" },
    ts: "2026-08-08T00:00:01Z",
    type: "inter_agent_message",
    state: "idle",
    payload: {
      to: "agent-a",
      conversation_id: "cid-1",
      turn_number: 1,
      kind: "inform",
      body: "restored",
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  };
}

beforeEach(() => {
  ReplyingWebSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lobby join / history_replay_envelope の wire 結線 (ADR-0051)", () => {
  async function connect() {
    const handlers = makeHandlers();
    const conn = connectKaoiro("ws://test/client", handlers, {
      token: "t",
      transport: ReplyingWebSocket as unknown as typeof WebSocket,
      heartbeatIntervalMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    const ws = ReplyingWebSocket.instances[0]!;
    return { handlers, conn, ws };
  }

  it("join 成功で onJoined が発火する (D4 buffer 窓の開始点)", async () => {
    const { handlers, conn, ws } = await connect();

    expect(handlers.onJoined).not.toHaveBeenCalled();
    ws.ackJoin();
    expect(handlers.onJoined).toHaveBeenCalledTimes(1);

    conn.disconnect();
  });

  it("history_replay_envelope は pane 付きで専用ハンドラへ届く", async () => {
    const { handlers, conn, ws } = await connect();
    ws.ackJoin();

    const envelope = interAgentEnvelope();
    ws.deliver([null, null, "agents:lobby", "history_replay_envelope", {
      pane_agent_id: "agent-a",
      envelope,
    }]);

    expect(handlers.onHistoryReplayEnvelope).toHaveBeenCalledWith(
      "agent-a",
      envelope,
    );
    // 通常 envelope 経路 (= fan-out する側) には流れない。
    expect(handlers.onEnvelope).not.toHaveBeenCalled();

    conn.disconnect();
  });

  it("pane 欠落 / 非 IA の history_replay_envelope は落とす (fail-closed)", async () => {
    const { handlers, conn, ws } = await connect();
    ws.ackJoin();

    const envelope = interAgentEnvelope();
    ws.deliver([null, null, "agents:lobby", "history_replay_envelope", {
      envelope,
    }]);
    ws.deliver([null, null, "agents:lobby", "history_replay_envelope", {
      pane_agent_id: "",
      envelope,
    }]);
    ws.deliver([null, null, "agents:lobby", "history_replay_envelope", {
      pane_agent_id: "agent-a",
      envelope: { ...envelope, type: "log" },
    }]);

    expect(handlers.onHistoryReplayEnvelope).not.toHaveBeenCalled();

    conn.disconnect();
  });
});
