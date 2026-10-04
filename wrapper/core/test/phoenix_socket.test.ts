import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Server, Socket as TcpSocket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloseGuaranteedWebSocket,
  OPENING_HANDSHAKE_TIMEOUT_MS,
  createPhoenixSocket,
} from "../src/phoenix_socket.js";
import type {
  NativeWebSocket,
  PhoenixSocketOptions,
} from "../src/phoenix_socket.js";

type Listener = (event: unknown) => void;

/** Scriptable stand-in for the platform WebSocket. */
class FakeNative implements NativeWebSocket {
  static last: FakeNative | undefined;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  readonly sent: unknown[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  /** What the platform does inside close(). */
  onCloseCall: () => void = () => {};
  readonly #listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeNative.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown = { type }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.onCloseCall();
  }
}

const nativeClose = (code: number) => ({
  type: "close",
  code,
  reason: "native",
  wasClean: false,
});

// Platform sequences measured on Node v22.23.3 (undici 6.28.1) and v24.3.0
// (undici 7.10.0) against a refused port, a 502 upgrade and a pending
// handshake (tmp/reviews/issue-518/design-kogane-r2.md, section 1.1).

function node22FailedHandshake(fake: FakeNative): void {
  fake.emit("error");
}

function node24FailedHandshake(fake: FakeNative): void {
  fake.readyState = 3;
  fake.emit("error");
  fake.emit("close", nativeClose(1002));
}

function node22PendingClose(fake: FakeNative): void {
  fake.onCloseCall = () => {
    fake.emit("error");
    fake.readyState = 2;
    setTimeout(() => fake.emit("error"), 1);
  };
}

function node24PendingClose(fake: FakeNative): void {
  fake.onCloseCall = () => {
    fake.readyState = 3;
    fake.emit("close", nativeClose(0));
    fake.readyState = 2;
    setTimeout(() => {
      fake.readyState = 3;
      fake.emit("error");
      fake.emit("close", nativeClose(1002));
    }, 3);
  };
}

function connect(): {
  ws: CloseGuaranteedWebSocket;
  fake: FakeNative;
  delivered: Array<[string, unknown]>;
} {
  const ws = new CloseGuaranteedWebSocket("ws://x/socket", ["phoenix"], {
    native: () => FakeNative,
  });
  const delivered: Array<[string, unknown]> = [];
  ws.onopen = (event) => delivered.push(["open", event]);
  ws.onmessage = (event) => delivered.push(["message", event]);
  ws.onerror = (event) => delivered.push(["error", event]);
  ws.onclose = (event) => delivered.push(["close", event]);
  const fake = FakeNative.last;
  if (fake === undefined) throw new Error("native socket was not constructed");
  return { ws, fake, delivered };
}

const kinds = (delivered: Array<[string, unknown]>) => delivered.map(([kind]) => kind);
const closes = (delivered: Array<[string, unknown]>) =>
  delivered.filter(([kind]) => kind === "close").map(([, event]) => event);

describe("CloseGuaranteedWebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeNative.last = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the url and protocols to the native constructor", () => {
    const { fake } = connect();
    expect(fake.url).toBe("ws://x/socket");
    expect(fake.protocols).toEqual(["phoenix"]);
  });

  it("follows a Node 22 pre-open error with a synthesized close on the next macrotask", () => {
    const { ws, fake, delivered } = connect();
    node22FailedHandshake(fake);
    expect(kinds(delivered)).toEqual(["error"]);

    vi.advanceTimersByTime(1);
    expect(kinds(delivered)).toEqual(["error", "close"]);
    expect(closes(delivered)[0]).toEqual({
      type: "close",
      code: 1006,
      reason: "opening handshake failed",
      wasClean: false,
    });
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes Node 24's own close through and synthesizes nothing", () => {
    const { ws, fake, delivered } = connect();
    node24FailedHandshake(fake);
    vi.advanceTimersByTime(OPENING_HANDSHAKE_TIMEOUT_MS);
    expect(kinds(delivered)).toEqual(["error", "close"]);
    expect(closes(delivered)[0]).toEqual(nativeClose(1002));
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers open, messages and the native close of an established connection", () => {
    const { ws, fake, delivered } = connect();
    fake.emit("message", { data: "early" });
    fake.readyState = 1;
    fake.emit("open");
    expect(vi.getTimerCount()).toBe(0);
    fake.emit("message", { data: "frame" });
    fake.emit("error");
    fake.readyState = 3;
    fake.emit("close", nativeClose(1012));
    vi.advanceTimersByTime(OPENING_HANDSHAKE_TIMEOUT_MS);

    expect(delivered).toEqual([
      ["open", { type: "open" }],
      ["message", { data: "frame" }],
      ["error", { type: "error" }],
      ["close", nativeClose(1012)],
    ]);
    expect(ws.readyState).toBe(3);
  });

  it("closes the native socket and delivers 1006 when the handshake bound expires", () => {
    const { ws, fake, delivered } = connect();
    vi.advanceTimersByTime(OPENING_HANDSHAKE_TIMEOUT_MS - 1);
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(fake.closeCalls).toEqual([[undefined, undefined]]);
    expect(delivered).toEqual([
      [
        "close",
        {
          type: "close",
          code: 1006,
          reason: "opening handshake timed out",
          wasClean: false,
        },
      ],
    ]);
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["Node 22", node22PendingClose],
    ["Node 24", node24PendingClose],
  ])("drops the events %s fires from the native close() of an expired handshake", (_label, platform) => {
    const { fake, delivered } = connect();
    platform(fake);
    vi.advanceTimersByTime(OPENING_HANDSHAKE_TIMEOUT_MS + 10);
    expect(fake.closeCalls).toHaveLength(1);
    expect(kinds(delivered)).toEqual(["close"]);
    expect(closes(delivered)[0]).toMatchObject({ reason: "opening handshake timed out" });
  });

  it("keeps the handshake bound running through a close() the native socket never answers", () => {
    const { ws, fake, delivered } = connect();
    ws.close();
    expect(fake.closeCalls).toHaveLength(1);
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(OPENING_HANDSHAKE_TIMEOUT_MS);
    expect(closes(delivered)).toEqual([
      expect.objectContaining({ code: 1006, reason: "opening handshake timed out" }),
    ]);
    expect(ws.readyState).toBe(3);
  });

  it("handles Node 22's in-call error from a pending close(), then delivers one close", () => {
    const { ws, fake, delivered } = connect();
    node22PendingClose(fake);
    ws.close();
    expect(kinds(delivered)).toEqual(["error"]);
    expect(ws.readyState).toBe(2);

    vi.advanceTimersByTime(10);
    expect(kinds(delivered)).toEqual(["error", "close"]);
    expect(closes(delivered)[0]).toMatchObject({ code: 1006, reason: "opening handshake failed" });
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers Node 24's in-call close code 0 from a pending close() once", () => {
    const { ws, fake, delivered } = connect();
    node24PendingClose(fake);
    ws.close();
    expect(delivered).toEqual([["close", nativeClose(0)]]);
    expect(fake.readyState).toBe(2);
    expect(ws.readyState).toBe(3);

    vi.advanceTimersByTime(10);
    expect(delivered).toEqual([["close", nativeClose(0)]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers nothing after its close", () => {
    const { fake, delivered } = connect();
    node22FailedHandshake(fake);
    vi.advanceTimersByTime(1);
    fake.emit("message", { data: "late" });
    fake.emit("error");
    fake.emit("close", nativeClose(1006));
    expect(kinds(delivered)).toEqual(["error", "close"]);
  });

  it("closes a native socket that opens after the attempt failed, and never delivers it", () => {
    const { fake, delivered } = connect();
    node22FailedHandshake(fake);
    fake.emit("open");
    expect(fake.closeCalls).toHaveLength(1);

    vi.advanceTimersByTime(1);
    fake.emit("open");
    expect(fake.closeCalls).toHaveLength(2);
    expect(kinds(delivered)).toEqual(["error", "close"]);
  });

  it("calls the handler assigned at dispatch time", () => {
    const { ws, fake, delivered } = connect();
    node22FailedHandshake(fake);
    const replaced: unknown[] = [];
    ws.onclose = (event) => replaced.push(event);
    vi.advanceTimersByTime(1);
    expect(closes(delivered)).toEqual([]);
    expect(replaced).toHaveLength(1);
  });

  it("keeps the failure close scheduled when onerror throws", () => {
    const { ws, fake, delivered } = connect();
    ws.onerror = () => {
      throw new Error("onerror failed");
    };
    expect(() => node22FailedHandshake(fake)).toThrow("onerror failed");

    vi.advanceTimersByTime(1);
    expect(kinds(delivered)).toEqual(["close"]);
    expect(ws.readyState).toBe(3);
  });

  it("is already closed when an onclose fired by the failure close throws", () => {
    const { ws, fake } = connect();
    ws.onclose = () => {
      throw new Error("onclose failed");
    };
    node22FailedHandshake(fake);
    expect(() => vi.advanceTimersByTime(1)).toThrow("onclose failed");
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has closed the native socket when an onclose fired by the handshake bound throws", () => {
    const { ws, fake } = connect();
    ws.onclose = () => {
      throw new Error("onclose failed");
    };
    expect(() => vi.advanceTimersByTime(OPENING_HANDSHAKE_TIMEOUT_MS)).toThrow(
      "onclose failed",
    );
    expect(fake.closeCalls).toHaveLength(1);
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards send, close arguments, binaryType and bufferedAmount", () => {
    const { ws, fake } = connect();
    ws.binaryType = "arraybuffer";
    expect(fake.binaryType).toBe("arraybuffer");
    expect(ws.binaryType).toBe("arraybuffer");
    fake.bufferedAmount = 7;
    expect(ws.bufferedAmount).toBe(7);
    ws.send("frame");
    expect(fake.sent).toEqual(["frame"]);
    ws.close(1000, "bye");
    expect(fake.closeCalls).toEqual([[1000, "bye"]]);
  });
});

describe("createPhoenixSocket", () => {
  it("fixes the transport even against an untyped override", () => {
    const options = { transport: class {}, params: { token: "t" } };
    const socket = createPhoenixSocket(
      "ws://127.0.0.1:1/socket",
      options as PhoenixSocketOptions,
    );
    expect((socket as unknown as { transport: unknown }).transport).toBe(
      CloseGuaranteedWebSocket,
    );
    expect(socket.endPointURL()).toContain("token=t");
  });
});

/** The adapter on the WebSocket of whichever Node runs the suite. */
describe(`CloseGuaranteedWebSocket on the platform WebSocket (Node ${process.versions.node})`, () => {
  const servers: Server[] = [];
  const held: TcpSocket[] = [];

  afterEach(async () => {
    for (const socket of held.splice(0)) socket.destroy();
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  async function refusedPort(): Promise<number> {
    const server = createTcpServer();
    const port = await listen(server);
    servers.pop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  function record(ws: CloseGuaranteedWebSocket) {
    const errors: unknown[] = [];
    const closed: Array<{ code?: number }> = [];
    ws.onerror = (event) => errors.push(event);
    ws.onclose = (event) => closed.push(event as { code?: number });
    return { errors, closed };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  it("delivers one close after a refused connection", async () => {
    const ws = new CloseGuaranteedWebSocket(`ws://127.0.0.1:${await refusedPort()}/socket`);
    const { errors, closed } = record(ws);
    await settle();
    expect(errors).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.code).not.toBe(1000);
    expect(ws.readyState).toBe(3);
  });

  it("delivers one close after a 502 answer to the upgrade", async () => {
    const server = createHttpServer();
    server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const ws = new CloseGuaranteedWebSocket(`ws://127.0.0.1:${await listen(server)}/socket`);
    const { errors, closed } = record(ws);
    await settle();
    expect(errors).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.code).not.toBe(1000);
    expect(ws.readyState).toBe(3);
  });

  it("delivers one close after close() on a pending handshake", async () => {
    let requested!: () => void;
    const request = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const server = createTcpServer((socket) => {
      held.push(socket);
      socket.on("error", () => {});
      socket.once("data", () => requested());
    });
    const ws = new CloseGuaranteedWebSocket(`ws://127.0.0.1:${await listen(server)}/socket`);
    const { closed } = record(ws);
    await request;
    ws.close();
    await settle();
    expect(closed).toHaveLength(1);
    expect(closed[0]?.code).not.toBe(1000);
    expect(ws.readyState).toBe(3);
  });
});
