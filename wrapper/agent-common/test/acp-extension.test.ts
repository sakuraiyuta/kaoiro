import "../../../scripts/test/fixtures/test-isolation.mjs";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  connectAcp,
  metadataTee,
  notification,
  type AcpExtension,
  type InboundLineSummary,
  type WireMetadata,
} from "../src/acp/connection.js";
import { AcpSession } from "../src/acp/session.js";

function fakeChild() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  stdin.resume();
  return {
    child: Object.assign(new EventEmitter(), { stdout, stdin }) as unknown as
      ChildProcessWithoutNullStreams,
    emit: (message: unknown) =>
      stdout.write(JSON.stringify({ jsonrpc: "2.0", ...(message as object) }) + "\n"),
    raw: (text: string) => stdout.write(text),
    finish: (text: string) => stdout.end(text),
    stdin,
    end: () => {
      stdout.end();
      stdin.end();
    },
  };
}
const handlers = () => ({
  update: vi.fn(),
  permission: vi.fn(),
  metadata: vi.fn(),
});
const sessionUpdate = {
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    },
  },
};

describe("connectAcp without an extension", () => {
  it("registers ACP methods only and adds no vendor metadata", async () => {
    const { child, emit, end } = fakeChild();
    const h = handlers();
    const connection = connectAcp(child, h);
    emit({
      method: "_x.example/notice",
      params: { update: { sessionUpdate: "turn_completed", prompt_id: "p" } },
    });
    emit(sessionUpdate);
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.metadata).toHaveBeenCalledTimes(2));
    expect(h.metadata.mock.calls.map(([m]) => m)).toEqual([
      { direction: "in", method: "_x.example/notice", variant: "turn_completed" },
      { direction: "in", method: "session/update", variant: "agent_message_chunk" },
    ]);
    connection.close();
    end();
  });
});

describe("connectAcp with an extension", () => {
  it("routes an extra notification and merges vendor fields in order", async () => {
    const { child, emit, end } = fakeChild();
    const h = handlers();
    const seen: unknown[] = [];
    const extension: AcpExtension<WireMetadata & { vendor_id?: string }> = {
      notifications: [
        notification(
          "_x.example/notice",
          (params) => ({ parsed: params }),
          (value) => seen.push(value),
        ),
      ],
      wireFields: (message) =>
        String(message.method).startsWith("_x.example/")
          ? { vendor_id: "notice" }
          : {},
    };
    const connection = connectAcp(child, h, extension);
    emit({ method: "_x.example/notice", params: { n: 1 } });
    await vi.waitFor(() => expect(seen).toEqual([{ parsed: { n: 1 } }]));
    await vi.waitFor(() => expect(h.metadata).toHaveBeenCalledTimes(1));
    expect(Object.keys(h.metadata.mock.calls[0]![0])).toEqual([
      "direction",
      "method",
      "vendor_id",
    ]);
    connection.close();
    end();
  });

  it.each([
    ["a name without the leading underscore", "vendor/thing"],
    ["an ACP method name", "session/update"],
  ])("rejects %s", (_label, method) => {
    const { child, end } = fakeChild();
    expect(() =>
      connectAcp(child, handlers(), {
        notifications: [notification(method, (p) => p, () => {})],
      }),
    ).toThrow(/must start with "_"/);
    end();
  });

  it("accepts an underscore-prefixed name", () => {
    const { child, end } = fakeChild();
    const connection = connectAcp(child, handlers(), {
      notifications: [notification("_x.example/ok", (p) => p, () => {})],
    });
    connection.close();
    end();
  });
});

describe("connectAcp inbound line summary", () => {
  const line = (message: object) =>
    JSON.stringify({ jsonrpc: "2.0", ...message });
  const sentinel = line(sessionUpdate) + "\n";
  const sentinelSummary = {
    kind: "notification", method: "session/update", named: true,
  };

  function open(options: { throwing?: boolean } = {}) {
    const fake = fakeChild();
    const h = handlers();
    const summaries: InboundLineSummary[] = [];
    const written: string[] = [];
    fake.stdin.on("data", (data: Buffer) => written.push(data.toString()));
    const connection = connectAcp(fake.child, h, {
      onInboundLine: (summary) => {
        summaries.push(summary);
        if (options.throwing) throw new Error("observer failed");
      },
    });
    return { ...fake, h, summaries, written, connection };
  }

  it.each([
    ["a request", line({ id: 1, method: "x/other", params: {} }),
      { kind: "request", method: "x/other", named: true }],
    ["a notification", line({ method: "_x/other" }),
      { kind: "notification", method: "_x/other", named: true }],
    ["a response", line({ id: 99, result: {} }), { kind: "response" }],
    ["text that is not JSON", "not json", { kind: "malformed" }],
    ["a JSON number", "1", { kind: "malformed" }],
    ["an object without method or id", line({}), { kind: "malformed" }],
    ["an unsafe name", line({ method: "bad name!" }),
      { kind: "notification", named: true }],
    ["a method that is not a string", line({ id: 2, method: 5 }),
      { kind: "request", named: false }],
  ] as const)("summarises %s once, in wire order",
    async (_label, text, expected) => {
    const p = open();
    p.raw(text + "\n" + sentinel);
    await vi.waitFor(() => expect(p.h.update).toHaveBeenCalledTimes(1));
    expect(p.summaries).toEqual([expected, sentinelSummary]);
    p.connection.close();
    p.end();
  });

  it("summarises a line over the limit once, when it crosses", async () => {
    const p = open();
    const big = line({ id: 3, method: "x/big", params: {
      p: "x".repeat(4 * 1024 * 1024) } });
    p.raw(big.slice(0, 3 * 1024 * 1024));
    p.raw(big.slice(3 * 1024 * 1024) + "\n" + sentinel);
    await vi.waitFor(() => expect(p.h.update).toHaveBeenCalledTimes(1));
    expect(p.summaries).toEqual([{ kind: "oversized" }, sentinelSummary]);
    p.connection.close();
    p.end();
  });

  it("gives no summary for a blank line", async () => {
    const p = open();
    p.raw("\n   \r\n" + sentinel);
    await vi.waitFor(() => expect(p.h.update).toHaveBeenCalledTimes(1));
    expect(p.summaries).toEqual([sentinelSummary]);
    p.connection.close();
    p.end();
  });

  it("leaves the metadata unchanged with or without the option", async () => {
    const input = line({ method: "_x/other" }) + "\nnot json\n" + sentinel;
    const withOption = open();
    const without = fakeChild();
    const plain = handlers();
    const connection = connectAcp(without.child, plain);
    withOption.raw(input);
    without.raw(input);
    await vi.waitFor(() => expect(plain.update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(withOption.h.update).toHaveBeenCalledTimes(1));
    expect(withOption.h.metadata.mock.calls).toEqual(plain.metadata.mock.calls);
    // The SDK answers the non-JSON line with a parse error (outbound).
    expect(plain.metadata.mock.calls.map(([m]) => m)).toEqual([
      { direction: "in", method: "_x/other" },
      { direction: "in", method: "session/update",
        variant: "agent_message_chunk" },
      { direction: "out" },
    ]);
    withOption.connection.close();
    connection.close();
    withOption.end();
    without.end();
  });

  it("keeps the dispatch when the callback throws", async () => {
    const p = open({ throwing: true });
    p.raw(line({ method: "_x/other" }) + "\n" + sentinel);
    await vi.waitFor(() => expect(p.h.update).toHaveBeenCalledTimes(1));
    expect(p.summaries).toHaveLength(2);
    expect(p.h.metadata).toHaveBeenCalledTimes(2);
    p.connection.close();
    p.end();
  });

  // Pins the pinned SDK: its client closes on any array and dispatches no
  // member. A later pin that dispatches batches turns these red.
  it.each([
    ["a valid mixed batch", JSON.stringify([
      { jsonrpc: "2.0", ...sessionUpdate },
      { jsonrpc: "2.0", id: 7, method: "x/other", params: {} },
    ])],
    ["[1]", "[1]"],
  ])("records %s once and the SDK closes the connection", async (_l, text) => {
    const p = open();
    p.raw(text + "\n");
    await p.connection.closed;
    expect(p.connection.signal.reason).toMatchObject({
      message: "JSON-RPC batches are not supported on this connection",
    });
    expect(p.summaries).toEqual([{ kind: "batch" }]);
    expect(p.h.update).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.written).toEqual([]);
    p.end();
  });

  it("summarises a final notification without a newline", async () => {
    const p = open();
    p.finish(line(sessionUpdate));
    await p.connection.closed;
    expect(p.summaries).toEqual([sentinelSummary]);
    expect(p.h.update).toHaveBeenCalledTimes(1);
    p.end();
  });

  it("summarises a final request without a newline", async () => {
    const p = open();
    p.finish(line({ id: 9, method: "x/other", params: {} }));
    await p.connection.closed;
    expect(p.summaries).toEqual([
      { kind: "request", method: "x/other", named: true },
    ]);
    p.end();
  });

  it("gives no summary for a final blank line", async () => {
    const p = open();
    p.finish(sentinel + "  ");
    await p.connection.closed;
    expect(p.summaries).toEqual([sentinelSummary]);
    p.end();
  });

  it("adds no metadata for a final line, with or without the option",
    async () => {
    const withOption = open();
    const without = fakeChild();
    const plain = handlers();
    const connection = connectAcp(without.child, plain);
    withOption.finish(line(sessionUpdate));
    without.finish(line(sessionUpdate));
    await connection.closed;
    await withOption.connection.closed;
    expect(plain.update).toHaveBeenCalledTimes(1);
    expect(plain.metadata).not.toHaveBeenCalled();
    expect(withOption.h.metadata).not.toHaveBeenCalled();
    withOption.end();
    without.end();
  });
});

describe("metadataTee with a failing vendor extractor", () => {
  it("drops that line's metadata and keeps the transport and later lines", async () => {
    const seen: WireMetadata[] = [];
    const tee = metadataTee(
      "in",
      (m) => seen.push(m),
      (message) => {
        if (message.method === "boom") throw new Error("extractor failed");
        return {};
      },
    );
    const input = Buffer.from(
      JSON.stringify({ method: "boom" }) + "\n" +
        JSON.stringify({ method: "fine" }) + "\n",
    );
    const reader = tee.readable.getReader();
    const writer = tee.writable.getWriter();
    const chunks: Uint8Array[] = [];
    const read = (async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
      }
    })();
    await writer.write(input);
    await writer.close();
    await read;
    expect(Buffer.concat(chunks).equals(input)).toBe(true);
    expect(seen).toEqual([{ direction: "in", method: "fine" }]);
  });
});

describe("AcpSession.open", () => {
  function session() {
    const request = vi.fn(async (method: string) =>
      method === "session/new" ? { sessionId: "s1" } : {},
    );
    const acpSession = new AcpSession({
      agent: { request },
    } as unknown as ConstructorParameters<typeof AcpSession>[0]);
    return { acpSession, request };
  }
  it("sends the injected value as session/new _meta", async () => {
    const { acpSession, request } = session();
    await acpSession.open("/work", [], { vendor: "value" });
    expect(request).toHaveBeenLastCalledWith("session/new", {
      cwd: "/work",
      mcpServers: [],
      _meta: { vendor: "value" },
    });
  });
  it("sends no _meta when nothing is injected", async () => {
    const { acpSession, request } = session();
    await acpSession.open("/work", []);
    expect(request).toHaveBeenLastCalledWith("session/new", {
      cwd: "/work",
      mcpServers: [],
    });
  });
});

it("adapts this child's stdin with Writable.toWeb by default", () => {
  const { child, end } = fakeChild();
  const adapter = vi.spyOn(Writable, "toWeb");
  try {
    const connection = connectAcp(child, handlers());
    expect(adapter).toHaveBeenCalledWith(child.stdin);
    connection.close();
  } finally {
    adapter.mockRestore();
    end();
  }
});

async function heldPrompt(text = "hello") {
  const stdout = new PassThrough();
  let release!: (error?: Error) => void;
  let capture!: (line: { id: number; method: string }) => void;
  const written = new Promise<{ id: number; method: string }>(
    (resolve) => { capture = resolve; },
  );
  const stdin = new Writable({
    write(chunk, _encoding, cb) {
      release = cb;
      capture(JSON.parse(chunk.toString()));
    },
  });
  const child = Object.assign(new EventEmitter(), { stdout, stdin });
  const onWrite = vi.fn();
  const onWriteStart = vi.fn();
  const h = handlers();
  const conn = connectAcp(child as unknown as ChildProcessWithoutNullStreams,
    h, { onWrite, onWriteStart });
  const session = new AcpSession(conn);
  session.sessionId = "session";
  const result = session.prompt(text);
  void result.catch(() => {});
  const line = await written;
  expect(line.method).toBe("session/prompt");
  expect(onWrite).not.toHaveBeenCalled();
  return { child, stdin, stdout, conn, onWrite, onWriteStart,
    metadata: h.metadata, session, result, line, release };
}

it.each([true, false])("receives a response before callback ok=%s", async (ok) => {
  const p = await heldPrompt();
  p.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: p.line.id, result: { stopReason: "end_turn" },
  }) + "\n");
  await expect(p.result).resolves.toMatchObject({ stopReason: "end_turn" });
  expect(p.onWrite).not.toHaveBeenCalled();
  p.release(ok ? undefined : new Error("delayed failure"));
  await vi.waitFor(() => expect(p.onWrite.mock.calls).toEqual([[
    { id: p.line.id, method: p.line.method, ok },
  ]]));
  if (ok) p.conn.close();
  await p.conn.closed;
  p.stdin.destroy();
});

it.each(["callback", "stdin error", "stdin close", "child close"])(
  "closes a pending prompt on %s", async (event) => {
    const p = await heldPrompt();
    const error = new Error("deferred failure");
    if (event === "callback") p.release(error);
    if (event === "stdin error") p.stdin.destroy(error);
    if (event === "stdin close") p.stdin.destroy();
    if (event === "child close") p.child.emit("close");
    await expect(p.result).rejects.toThrow();
    await p.conn.closed;
    if (event !== "callback") p.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.onWrite.mock.calls).toEqual([[
      { id: p.line.id, method: p.line.method, ok: false },
    ]]);
    p.stdin.destroy();
  },
);

it("closes an idle connection on stdin error", async () => {
  const { child, end } = fakeChild();
  const onWrite = vi.fn();
  const conn = connectAcp(child, handlers(), { onWrite });
  let closed = false;
  void conn.closed.then(() => { closed = true; });
  try {
    child.stdin.emit("error", new Error("idle stdin failure"));
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(onWrite).not.toHaveBeenCalled();
  } finally {
    conn.close();
    end();
  }
});

it.each([
  ["normal", "hello", { direction: "out", method: "session/prompt" }],
  ["oversized", "x".repeat(4 * 1024 * 1024),
    { direction: "out", oversized_lines: 1 }],
] as const)("reports %s outbound metadata on callback writes",
  async (_kind, text, expected) => {
    const p = await heldPrompt(text);
    try {
      expect(p.metadata.mock.calls).toEqual([[expected]]);
    } finally {
      p.release();
      p.conn.close();
      p.stdin.destroy();
    }
  },
);

it.each([
  ["normal", "hello"],
  ["oversized", "x".repeat(4 * 1024 * 1024)],
] as const)("reports the start of a %s write before its callback",
  async (_kind, text) => {
    const p = await heldPrompt(text);
    try {
      expect(p.onWriteStart.mock.calls).toEqual([[
        { id: p.line.id, method: "session/prompt" },
      ]]);
    } finally {
      p.release();
      p.conn.close();
      p.stdin.destroy();
    }
  },
);

it("reports no start for a message queued behind a failed write", async () => {
  const p = await heldPrompt();
  void p.session.cancel().catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  p.release(new Error("write failed"));
  await expect(p.result).rejects.toThrow();
  await p.conn.closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(p.onWriteStart.mock.calls.map(([identity]) => identity.method))
    .toEqual(["session/prompt"]);
  expect(p.onWrite.mock.calls).toEqual([[
    { id: p.line.id, method: "session/prompt", ok: false },
  ]]);
  p.stdin.destroy();
});
