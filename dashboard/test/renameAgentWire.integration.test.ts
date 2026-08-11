// @vitest-environment jsdom
// Wire-contract pin (issue #197 段階3 unit B, ふじ判定 — dashboard wire
// test). A component test alone only proves "the UI calls
// connection.renameAgent(...)"; a server channel test alone only proves
// "the server accepts rename_agent". Neither closes the seam BETWEEN
// them — that connectKaoiro's REAL renameAgent() actually pushes the
// exact `"rename_agent"` event / `{ version, agent_id, name }` payload
// shape the
// server's handle_in("rename_agent", ...) accepts (pinned server-side in
// unit A's agents_channel_test.exs). A docs-only sync against protocol.md
// was explicitly rejected by ふじ for the same reason: markdown agreeing
// with a hand-written constant proves nothing about what connectKaoiro's
// implementation actually serializes onto the wire.
//
// Runs against the REAL phoenix client with only the WebSocket swapped —
// mirrors replayEnvelopeWire.integration.test.ts's ReplyingWebSocket
// harness — so this is the frame Phoenix ACTUALLY serializes, not a
// hand-rolled stand-in for it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro } from "../src/lib/protocol";

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

  parsedFrames(): unknown[][] {
    return this.sentFrames.map((raw) => JSON.parse(raw) as unknown[]);
  }

  /** Answers the lobby's phx_join with `ok`, the way the server does. */
  ackJoin(): void {
    const join = this.parsedFrames().find(
      (f) => f[3] === "phx_join" && f[2] === "agents:lobby",
    );
    if (join === undefined) throw new Error("no phx_join frame was sent");
    this.deliver([
      join[0],
      join[1],
      "agents:lobby",
      "phx_reply",
      { status: "ok", response: {} },
    ]);
  }

  /** Answers the LATEST `rename_agent` push with an ok/error phx_reply,
   *  mirroring the server's actual reply shapes (agents_channel.ex's
   *  `{:reply, {:ok, %{"persona" => ..., "revision" => ...}}}` /
   *  `{:reply, {:error, %{reason: ...}}}`). */
  replyToLatestRename(outcome: { ok: true } | { ok: false; reason: string }): void {
    const frame = this.parsedFrames()
      .filter((f) => f[3] === "rename_agent")
      .at(-1);
    if (frame === undefined) throw new Error("no rename_agent frame was sent");
    const [joinRef, ref, topic] = frame;
    this.deliver([
      joinRef,
      ref,
      topic,
      "phx_reply",
      outcome.ok
        ? {
            status: "ok",
            response: {
              persona: { id: "ao", name: "新名", sprite_set: "ao" },
              revision: 1,
            },
          }
        : { status: "error", response: { reason: outcome.reason } },
    ]);
  }
}

function makeHandlers() {
  return {
    onStatus: vi.fn(),
    onSnapshot: vi.fn(),
    onEnvelope: vi.fn(),
  };
}

describe("rename_agent wire contract (issue #197 段階3 unit B, ふじ判定)", () => {
  beforeEach(() => {
    ReplyingWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connect() {
    const conn = connectKaoiro("ws://test/client", makeHandlers(), {
      transport: ReplyingWebSocket as unknown as typeof WebSocket,
      heartbeatIntervalMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    const ws = ReplyingWebSocket.instances[0]!;
    ws.ackJoin();
    return { conn, ws };
  }

  it("renameAgent は event=\"rename_agent\"、payload={version, agent_id, name} の exact frame を agents:lobby へ push する", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameAgent("host-a.ao", "あお(改名)");

    const frame = ws
      .parsedFrames()
      .find((f) => f[3] === "rename_agent");
    expect(frame).toBeDefined();
    const [, , topic, event, payload] = frame!;
    expect(topic).toBe("agents:lobby");
    expect(event).toBe("rename_agent");
    // Exact shape — no extra keys, no partial match. A future refactor
    // that renames `agent_id` or nests the payload differently must fail
    // THIS test, not silently drift from the server's accepted shape.
    // `version` (ADR-0015, issue #197 段階3 ふじ MF-1 レビュー指摘): this
    // event never reaches the runner, but every client -> server message
    // still needs the flat version stamp.
    expect(payload).toEqual({
      version: "0",
      agent_id: "host-a.ao",
      name: "あお(改名)",
    });

    ws.replyToLatestRename({ ok: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it("ok reply で Promise が resolve する", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameAgent("host-a.ao", "改名後");
    ws.replyToLatestRename({ ok: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it("error reply の reason がそのまま Error.message へ届く (代表値 invalid_name) — reason ごとの分岐は client 側に無い", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameAgent("host-a.ao", "");
    ws.replyToLatestRename({ ok: false, reason: "invalid_name" });
    await expect(pending).rejects.toThrow("invalid_name");
  });

  it("error reply の reason がそのまま Error.message へ届く (revision_exhausted, issue #197 段階3 ふじ MF-5)", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameAgent("host-a.ao", "改名後");
    ws.replyToLatestRename({ ok: false, reason: "revision_exhausted" });
    await expect(pending).rejects.toThrow("revision_exhausted");
  });
});
