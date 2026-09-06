// @vitest-environment jsdom
// Wire-contract pin for the set_permission REPLY BODY (issue #305 D,
// ふじ round 1 should-fix 2). The component tests drive setPermission
// through a vi.fn() stand-in, so they measure what AgentDetail does with
// an ack — not that connectKaoiro produces one. Nulling
// setPermissionAckOf's return left all of those green: nothing pinned the
// path from the server's phx_reply payload back to a typed
// SetPermissionAck.
//
// Runs against the REAL phoenix client with only the WebSocket swapped,
// mirroring renameAgentWire.integration.test.ts, so the reply this parses
// is the frame Phoenix actually delivers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectKaoiro } from "../src/lib/protocol";

const AGENT_ID = "host-a.p";

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

  deliver(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  parsedFrames(): unknown[][] {
    return this.sentFrames.map((raw) => JSON.parse(raw) as unknown[]);
  }

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

  /** Answers the latest `set_permission` push with the server's own reply
   *  shape: `{:reply, {:ok, %{revision:, status: "pending", requested:}}}`
   *  / `{:reply, {:error, %{reason: ...}}}` (protocol.md, "Requested,
   *  submitted, and effective state"). */
  replyToLatestSetPermission(
    outcome: { ok: true; response: unknown } | { ok: false; reason: string },
  ): void {
    const frame = this.parsedFrames()
      .filter((f) => f[3] === "set_permission")
      .at(-1);
    if (frame === undefined) throw new Error("no set_permission frame was sent");
    const [joinRef, ref, topic] = frame;
    this.deliver([
      joinRef,
      ref,
      topic,
      "phx_reply",
      outcome.ok
        ? { status: "ok", response: outcome.response }
        : { status: "error", response: { reason: outcome.reason } },
    ]);
  }
}

function makeHandlers() {
  return { onStatus: vi.fn(), onSnapshot: vi.fn(), onEnvelope: vi.fn() };
}

describe("set_permission reply contract (issue #305 D, ふじ round 1 S2)", () => {
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

  it("resolves an ok reply into the typed ack the caller renders", async () => {
    const { conn, ws } = await connect();
    const pending = conn.setPermission(AGENT_ID, { sandbox: "read-only" });
    ws.replyToLatestSetPermission({
      ok: true,
      response: {
        revision: 17,
        status: "pending",
        requested: { sandbox: "read-only", network_access: false },
      },
    });
    await expect(pending).resolves.toEqual({
      revision: 17,
      status: "pending",
      requested: { sandbox: "read-only", network_access: false },
    });
  });

  it("resolves null for an ok reply whose body does not parse", async () => {
    // Negative control for the case above: the resolve path is exercised
    // either way, so a green "resolves to the ack" test alone could not
    // tell a real parse from a passthrough.
    const { conn, ws } = await connect();
    const pending = conn.setPermission(AGENT_ID, { network_access: true });
    ws.replyToLatestSetPermission({
      ok: true,
      response: { revision: 17, status: "applied", requested: {} },
    });
    await expect(pending).resolves.toBeNull();
  });

  it("rejects an error reply with the server's reason, the key the UI maps", async () => {
    const { conn, ws } = await connect();
    const pending = conn.setPermission(AGENT_ID, { sandbox: "read-only" });
    ws.replyToLatestSetPermission({ ok: false, reason: "forbidden" });
    await expect(pending).rejects.toThrow("forbidden");
  });
});
