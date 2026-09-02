// @vitest-environment jsdom
// Wire-contract pin (issue #207 code-review-assessment must-fix 3, mirrors
// renameAgentWire.integration.test.ts exactly). A component test alone only
// proves "the UI calls connection.renameUser(...)"; a server channel test
// alone only proves "the server accepts rename_user". Neither closes the
// seam BETWEEN them -- that connectKaoiro's REAL renameUser() actually
// pushes the exact `"rename_user"` event / `{ version, user_id,
// display_name }` payload shape the server's
// handle_in("rename_user", ...) accepts (pinned server-side in
// agents_channel_test.exs' `rename_user` describe block, issue #197
// 段階3).
//
// Runs against the REAL phoenix client with only the WebSocket swapped --
// same ReplyingWebSocket harness as renameAgentWire.integration.test.ts,
// so this is the frame Phoenix ACTUALLY serializes, not a hand-rolled
// stand-in for it.
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

  /** Answers the LATEST `rename_user` push with an ok/error phx_reply,
   *  mirroring the server's actual reply shapes
   *  (agents_channel.ex's `{:reply, {:ok, entry}}` where entry is
   *  `Users.rename/3`'s `{ id, kind, display_name }` /
   *  `{:reply, {:error, %{reason: ...}}}`). */
  replyToLatestRename(outcome: { ok: true } | { ok: false; reason: string }): void {
    const frame = this.parsedFrames()
      .filter((f) => f[3] === "rename_user")
      .at(-1);
    if (frame === undefined) throw new Error("no rename_user frame was sent");
    const [joinRef, ref, topic] = frame;
    this.deliver([
      joinRef,
      ref,
      topic,
      "phx_reply",
      outcome.ok
        ? {
            status: "ok",
            response: { id: "u1", kind: "user", display_name: "新名" },
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

describe("rename_user wire contract (issue #207 code-review-assessment must-fix 3)", () => {
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

  it('renameUser は event="rename_user"、payload={version, user_id, display_name} の exact frame を agents:lobby へ push する', async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameUser("u1", "あお(改名)");

    const frame = ws.parsedFrames().find((f) => f[3] === "rename_user");
    expect(frame).toBeDefined();
    const [, , topic, event, payload] = frame!;
    expect(topic).toBe("agents:lobby");
    expect(event).toBe("rename_user");
    // Exact shape -- no extra keys, no partial match. A future refactor
    // that renames `user_id` or nests the payload differently must fail
    // THIS test, not silently drift from the server's accepted shape.
    // `version` (ADR-0015): every client -> server message needs the
    // flat version stamp, `rename_user` included. `display_name`
    // (canonical key, matching renameAgent's own precedent) -- the
    // server's extract_name_field/1 still accepts the legacy `name` key
    // too, but this client sends the canonical one.
    expect(payload).toEqual({
      version: "0",
      user_id: "u1",
      display_name: "あお(改名)",
    });

    ws.replyToLatestRename({ ok: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it("ok reply で Promise が resolve する", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameUser("u1", "改名後");
    ws.replyToLatestRename({ ok: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it("error reply の reason がそのまま Error.message へ届く (代表値 invalid_name) — reason ごとの分岐は client 側に無い", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameUser("u1", "");
    ws.replyToLatestRename({ ok: false, reason: "invalid_name" });
    await expect(pending).rejects.toThrow("invalid_name");
  });

  it("error reply の reason がそのまま Error.message へ届く (代表値 unknown_user)", async () => {
    const { conn, ws } = await connect();
    const pending = conn.renameUser("no-such-user", "改名後");
    ws.replyToLatestRename({ ok: false, reason: "unknown_user" });
    await expect(pending).rejects.toThrow("unknown_user");
  });
});
