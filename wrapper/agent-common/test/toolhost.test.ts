import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindToolResultHandoff,
  type ToolDescriptor,
} from "../src/index.js";
import { readBoundedBody, ToolHost } from "../src/toolhost.js";

const rawHttp = fileURLToPath(
  new URL("./fixtures/raw-http.mjs", import.meta.url),
);
const MiB = 1024 * 1024;

interface Raw {
  status: number | null;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
  timedOut?: boolean;
  refused?: boolean;
  closed?: boolean;
}

/** One raw HTTP request, sent from a separate process. */
function rawRequest(spec: {
  port: number;
  head: string;
  body?: string;
  bodyRepeat?: { char: string; count: number };
  chunked?: boolean;
  leaveOpen?: boolean;
  timeoutMs?: number;
}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rawHttp], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify(spec));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0
        ? resolve(JSON.parse(out) as Raw)
        : reject(new Error(`raw-http exited ${code}: ${err}`)),
    );
  });
}

/** What the host hands to ACP, read back as a client would use it. */
function entryOf(host: ToolHost): { port: number; token: string } {
  const entry = host.mcpServer();
  const token = /^Bearer (.+)$/.exec(entry.headers[0]!.value)![1]!;
  return { port: Number(new URL(entry.url).port), token };
}

interface Overrides {
  /** Undefined: the listener's own authority. Null: no Host header. */
  host?: string | null;
  /** Undefined: the host's token. Null: no Authorization header. */
  token?: string | null;
  origin?: string;
  path?: string;
  method?: string;
  length?: number;
  chunked?: boolean;
}

function head(host: ToolHost, over: Overrides = {}): string {
  const { port, token } = entryOf(host);
  const lines = [`${over.method ?? "POST"} ${over.path ?? "/mcp"} HTTP/1.1`];
  if (over.host !== null) lines.push(`Host: ${over.host ?? `127.0.0.1:${port}`}`);
  lines.push(
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
    "Connection: close",
  );
  if (over.token !== null) lines.push(`Authorization: Bearer ${over.token ?? token}`);
  if (over.origin !== undefined) lines.push(`Origin: ${over.origin}`);
  if (over.length !== undefined) lines.push(`Content-Length: ${over.length}`);
  if (over.chunked) lines.push("Transfer-Encoding: chunked");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const callBody = (args: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "probe", arguments: args },
  });

const hosts: ToolHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
});

function counting() {
  const calls: Record<string, unknown>[] = [];
  const descriptor: ToolDescriptor = {
    name: "probe",
    description: "Return a probe value",
    inputSchema: { type: "object" },
    handler: async (input) => {
      calls.push(input);
      return { content: [{ type: "text", text: "TOOL_RESULT_MARKER" }] };
    },
  };
  return { calls, descriptor };
}

async function listen(
  descriptors: ToolDescriptor[],
  options: Parameters<typeof ToolHost.listen>[1] = {},
) {
  const host = await ToolHost.listen(descriptors, options);
  hosts.push(host);
  return host;
}

describe("request validation, from another process (issue #604)", () => {
  const cases: [string, Overrides, number][] = [
    ["correct token, no Origin, exact Host (positive control)", {}, 200],
    ["correct token with a foreign Origin", { origin: "https://untrusted.invalid" }, 403],
    ["correct token with Origin: null", { origin: "null" }, 403],
    ["correct token with Host: evil.example", { host: "evil.example" }, 403],
    ["correct token with Host: localhost:<port>", { host: "localhost:PORT" }, 403],
    ["no token, no Origin", { token: null }, 401],
    ["no token with a foreign Origin (403 comes first)", { token: null, origin: "https://untrusted.invalid" }, 403],
    ["a wrong token of the same length", { token: "x".repeat(43) }, 401],
    ["a wrong token of another length", { token: "x" }, 401],
    ["an empty token", { token: "" }, 401],
  ];

  describe.each([
    ["tools/list", LIST],
    ["tools/call", callBody()],
  ])("%s", (method, body) => {
    it.each(cases)("%s", async (_name, over, status) => {
      const { calls, descriptor } = counting();
      const host = await listen([descriptor]);
      const { port } = entryOf(host);
      const spec = {
        ...over,
        ...(over.host === "localhost:PORT" ? { host: `localhost:${port}` } : {}),
        length: Buffer.byteLength(body),
      };
      const result = await rawRequest({ port, head: head(host, spec), body });
      expect(result.status).toBe(status);
      const accepted = status === 200;
      expect(calls).toHaveLength(accepted && method === "tools/call" ? 1 : 0);
      expect(host.stats().authenticatedLists).toBe(
        accepted && method === "tools/list" ? 1 : 0,
      );
      if (accepted) expect(result.body).toContain(
        method === "tools/call" ? "TOOL_RESULT_MARKER" : '"probe"',
      );
      if (status === 401) expect(result.headers["www-authenticate"]).toBe("Bearer");
    });
  });

  it("answers other methods and paths only after the token", async () => {
    const host = await listen([counting().descriptor]);
    const { port } = entryOf(host);
    const status = async (over: Overrides) =>
      (await rawRequest({ port, head: head(host, over), body: "" })).status;
    expect(await status({ method: "GET", length: 0 })).toBe(405);
    expect(await status({ path: "/other", length: 0 })).toBe(404);
    expect(await status({ method: "GET", token: null, length: 0 })).toBe(401);
    expect(await status({ path: "/other", token: null, length: 0 })).toBe(401);
  });

  it("refuses connections after close()", async () => {
    const host = await listen([counting().descriptor]);
    const { port } = entryOf(host);
    host.close();
    const result = await rawRequest({
      port,
      head: head(host),
      body: LIST,
      timeoutMs: 2000,
    });
    expect(result.refused).toBe(true);
  });
});

describe("rejected requests are not read (issue #604)", () => {
  it("answers an unauthenticated request before its body arrives", async () => {
    const { calls, descriptor } = counting();
    let reads = 0;
    const host = await listen([descriptor], {
      bodyReader: (request, limit) => {
        reads += 1;
        return readBoundedBody(request, limit);
      },
    });
    const { port } = entryOf(host);
    // The head promises 1000 bytes and the body never comes.
    const missing = await rawRequest({
      port,
      head: head(host, { token: null, length: 1000 }),
      leaveOpen: true,
      timeoutMs: 2000,
    });
    expect(missing.status).toBe(401);
    expect(missing.elapsedMs).toBeLessThan(500);
    const origin = await rawRequest({
      port,
      head: head(host, { origin: "https://untrusted.invalid", length: 1000 }),
      leaveOpen: true,
      timeoutMs: 2000,
    });
    expect(origin.status).toBe(403);
    expect(origin.elapsedMs).toBeLessThan(500);
    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
    // Positive control: an authenticated request is read.
    const ok = await rawRequest({
      port,
      head: head(host, { length: Buffer.byteLength(LIST) }),
      body: LIST,
    });
    expect(ok.status).toBe(200);
    expect(reads).toBe(1);
  });
});

describe("token rotation (issue #604)", () => {
  it("refuses the previous host's token and port", async () => {
    const first = counting();
    const second = counting();
    const hostA = await listen([first.descriptor]);
    const hostB = await listen([second.descriptor]);
    const a = entryOf(hostA);
    const b = entryOf(hostB);
    expect(a.token).not.toBe(b.token);
    expect(a.port).not.toBe(b.port);
    const body = callBody();
    const send = (port: number, token: string) =>
      rawRequest({
        port,
        head: head(hostB, { token, length: Buffer.byteLength(body) }),
        body,
      });
    // A's token against B's listener.
    expect((await send(b.port, a.token)).status).toBe(401);
    expect(second.calls).toHaveLength(0);
    // Positive control: B's own token.
    expect((await send(b.port, b.token)).status).toBe(200);
    expect(second.calls).toHaveLength(1);
    // A's port after A is closed.
    hostA.close();
    const closed = await rawRequest({
      port: a.port,
      head: head(hostA),
      body: LIST,
      timeoutMs: 2000,
    });
    expect(closed.refused).toBe(true);
    expect(first.calls).toHaveLength(0);
  });
});

describe("the body size limit (issue #604)", () => {
  it("answers 413 for a declared Content-Length over 1 MiB, before reading", async () => {
    const { calls, descriptor } = counting();
    let reads = 0;
    const host = await listen([descriptor], {
      bodyReader: (request, limit) => {
        reads += 1;
        return readBoundedBody(request, limit);
      },
    });
    const { port } = entryOf(host);
    const result = await rawRequest({
      port,
      head: head(host, { length: MiB + 1 }),
      leaveOpen: true,
      timeoutMs: 2000,
    });
    expect(result.status).toBe(413);
    expect(result.elapsedMs).toBeLessThan(500);
    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("answers 413 for a chunked body that passes 1 MiB while it is read", async () => {
    const { calls, descriptor } = counting();
    let reads = 0;
    const host = await listen([descriptor], {
      bodyReader: (request, limit) => {
        reads += 1;
        return readBoundedBody(request, limit);
      },
    });
    const { port } = entryOf(host);
    const result = await rawRequest({
      port,
      head: head(host, { chunked: true }),
      bodyRepeat: { char: "x", count: MiB + 1 },
      chunked: true,
      timeoutMs: 8000,
    });
    expect(result.status).toBe(413);
    expect(reads).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("still accepts a large request under the limit (positive control)", async () => {
    const { calls, descriptor } = counting();
    const host = await listen([descriptor]);
    const { port } = entryOf(host);
    const body = callBody({ text: "y".repeat(200 * 1024) });
    const result = await rawRequest({
      port,
      head: head(host, { length: Buffer.byteLength(body) }),
      body,
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

/** A call on the real HTTP path from this process, which the test can drop. */
function startCall(host: ToolHost, name: string) {
  const { port, token } = entryOf(host);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name, arguments: {} },
  });
  const request = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/mcp",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    },
  });
  const done = new Promise<{ status: number; body: string } | "closed">(
    (resolve) => {
      request.on("response", (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (d) => (text += d));
        response.on("end", () => resolve({ status: response.statusCode!, body: text }));
        response.on("error", () => resolve("closed"));
      });
      request.on("error", () => resolve("closed"));
      request.on("close", () => resolve("closed"));
    },
  );
  request.end(body);
  return { request, done };
}

function parkingDescriptor() {
  const signals: AbortSignal[] = [];
  const descriptor: ToolDescriptor = {
    name: "park",
    description: "Waits until its signal aborts",
    inputSchema: { type: "object" },
    handler: (_input, context) =>
      new Promise((resolve) => {
        const signal = context!.signal!;
        signals.push(signal);
        const done = () =>
          resolve({ content: [{ type: "text", text: "late result" }] });
        if (signal.aborted) done();
        else signal.addEventListener("abort", done, { once: true });
      }),
  };
  return { descriptor, signals };
}

describe("call lifetime (issue #347, over HTTP)", () => {
  it("aborts the handler's signal when the request's connection closes", async () => {
    const { descriptor, signals } = parkingDescriptor();
    const host = await listen([descriptor]);
    const { request } = startCall(host, "park");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    request.destroy();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });

  it("aborts the handler's signal when the active turn ends, connection still open", async () => {
    const { descriptor, signals } = parkingDescriptor();
    const turn = new AbortController();
    const host = await listen([descriptor], { turnSignal: () => turn.signal });
    const { request } = startCall(host, "park");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    turn.abort();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    expect(request.destroyed).toBe(false);
    request.destroy();
  });

  it("hands an already-aborted signal to a call that arrives with no active turn", async () => {
    const { descriptor, signals } = parkingDescriptor();
    const host = await listen([descriptor], { turnSignal: () => null });
    startCall(host, "park").request.on("error", () => {});
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(true);
  });

  it("close() aborts live calls and writes no result", async () => {
    const commit = vi.fn();
    const rollback = vi.fn();
    const signals: AbortSignal[] = [];
    const host = await listen([
      {
        name: "park",
        description: "Waits until its signal aborts",
        inputSchema: { type: "object" },
        handler: (_input, context) =>
          new Promise((resolve) => {
            signals.push(context!.signal!);
            context!.signal!.addEventListener(
              "abort",
              () =>
                resolve(
                  bindToolResultHandoff(
                    { content: [{ type: "text", text: "after close" }] },
                    { live: () => true, commit, rollback },
                  ),
                ),
              { once: true },
            );
          }),
      },
    ]);
    const { done } = startCall(host, "park");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    host.close();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    // The connection is severed with no answer, and the result is rolled back.
    expect(await done).toBe("closed");
    await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("result ownership at the HTTP boundary", () => {
  function handoffTool(scenario: string) {
    const commit = vi.fn();
    const rollback = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const descriptor: ToolDescriptor = {
      name: "send_to_agent",
      description: "Hands a result over",
      inputSchema: { type: "object" },
      handler: async () => {
        entered = true;
        await gate;
        const result = {
          content: [{ type: "text" as const, text: "complete recovery body" }],
        };
        if (scenario === "serialize") Object.assign(result, { cycle: result });
        return bindToolResultHandoff(result, {
          live: () => true,
          commit,
          rollback,
        });
      },
    };
    return { descriptor, commit, rollback, release, entered: () => entered };
  }

  it("commits once when the answer is delivered", async () => {
    const t = handoffTool("success");
    const host = await listen([t.descriptor]);
    const { done } = startCall(host, "send_to_agent");
    await vi.waitFor(() => expect(t.entered()).toBe(true));
    t.release();
    const answer = await done;
    expect(answer).not.toBe("closed");
    expect((answer as { body: string }).body).toContain("complete recovery body");
    expect(t.commit).toHaveBeenCalledOnce();
    expect(t.rollback).not.toHaveBeenCalled();
  });

  it("rolls back when the client is gone before the result", async () => {
    const t = handoffTool("disconnect");
    const host = await listen([t.descriptor]);
    const { request } = startCall(host, "send_to_agent");
    await vi.waitFor(() => expect(t.entered()).toBe(true));
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.release();
    await vi.waitFor(() => expect(t.rollback).toHaveBeenCalledOnce());
    expect(t.commit).not.toHaveBeenCalled();
  });

  it("rolls back a result that cannot be serialized", async () => {
    const t = handoffTool("serialize");
    const host = await listen([t.descriptor]);
    const { done } = startCall(host, "send_to_agent");
    await vi.waitFor(() => expect(t.entered()).toBe(true));
    t.release();
    await done;
    await vi.waitFor(() => expect(t.rollback).toHaveBeenCalledOnce());
    expect(t.commit).not.toHaveBeenCalled();
  });

  it("answers stale_tool_call for a send_to_agent whose turn ended", async () => {
    const t = handoffTool("success");
    const turn = new AbortController();
    const host = await listen([t.descriptor], { turnSignal: () => turn.signal });
    const { done } = startCall(host, "send_to_agent");
    await vi.waitFor(() => expect(t.entered()).toBe(true));
    turn.abort();
    t.release();
    const answer = await done;
    expect((answer as { body: string }).body).toContain("stale_tool_call");
    expect(t.rollback).toHaveBeenCalledOnce();
    expect(t.commit).not.toHaveBeenCalled();
  });
});
