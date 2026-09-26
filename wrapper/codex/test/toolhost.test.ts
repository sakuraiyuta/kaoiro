import { createConnection, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "@kaoiro/agent-common";
import { ToolHost } from "../src/toolhost.js";

const ECHO: ToolDescriptor = {
  name: "echo",
  description: "echoes input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  handler: async (input) => ({
    content: [{ type: "text", text: String(input.text ?? "") }],
  }),
};

async function request(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

describe("ToolHost", () => {
  it("list_tools が descriptor 一覧を返す", async () => {
    const host = await ToolHost.listen([ECHO]);
    try {
      const response = await request(host.socketPath, {
        id: 1,
        method: "list_tools",
      });
      expect(response.id).toBe(1);
      expect(response.tools).toEqual([
        {
          name: "echo",
          description: "echoes input",
          inputSchema: ECHO.inputSchema,
        },
      ]);
    } finally {
      host.close();
    }
  });

  it("call_tool が handler を実行し結果を返す", async () => {
    const host = await ToolHost.listen([ECHO]);
    try {
      const response = await request(host.socketPath, {
        id: 2,
        method: "call_tool",
        name: "echo",
        input: { text: "こんにちは" },
      });
      expect(response.result).toEqual({
        content: [{ type: "text", text: "こんにちは" }],
      });
    } finally {
      host.close();
    }
  });

  it("未知 tool は error を返す", async () => {
    const host = await ToolHost.listen([ECHO]);
    try {
      const response = await request(host.socketPath, {
        id: 3,
        method: "call_tool",
        name: "nope",
      });
      expect(response.error).toMatch(/unknown tool/);
    } finally {
      host.close();
    }
  });
});

/** A handler that parks until its context signal aborts, recording what it
 *  was handed (issue #347 M2). */
function parkingDescriptor(): {
  descriptor: ToolDescriptor;
  signals: AbortSignal[];
  aborted: Promise<string>;
} {
  const signals: AbortSignal[] = [];
  let resolveAborted!: (reason: string) => void;
  const aborted = new Promise<string>((resolve) => {
    resolveAborted = resolve;
  });
  const descriptor: ToolDescriptor = {
    name: "park",
    description: "waits for its signal",
    inputSchema: { type: "object", properties: {} },
    handler: (_input, context) =>
      new Promise((resolve) => {
        const signal = context?.signal;
        if (signal === undefined) {
          resolve({ content: [{ type: "text", text: "no signal" }] });
          return;
        }
        signals.push(signal);
        const done = (): void => {
          resolveAborted("aborted");
          resolve({ content: [{ type: "text", text: "aborted" }], isError: true });
        };
        if (signal.aborted) done();
        else signal.addEventListener("abort", done, { once: true });
      }),
  };
  return { descriptor, signals, aborted };
}

function openCall(
  socketPath: string,
  name: string,
): Promise<{ socket: Socket; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 9, method: "call_tool", name })}\n`);
      resolve({ socket, closed });
    });
    socket.once("error", reject);
  });
}

describe("ToolHost — call lifetime signal (issue #347)", () => {
  it("aborts the handler's signal when the bridge connection closes", async () => {
    const { descriptor, signals, aborted } = parkingDescriptor();
    const host = await ToolHost.listen([descriptor]);
    try {
      const { socket } = await openCall(host.socketPath, "park");
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]!.aborted).toBe(false);
      socket.destroy();
      await expect(aborted).resolves.toBe("aborted");
    } finally {
      host.close();
    }
  });

  it("aborts the handler's signal when the active turn's signal aborts, connection still open", async () => {
    const { descriptor, signals, aborted } = parkingDescriptor();
    const turn = new AbortController();
    const host = await ToolHost.listen([descriptor], {
      turnSignal: () => turn.signal,
    });
    try {
      const { socket } = await openCall(host.socketPath, "park");
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      turn.abort();
      await expect(aborted).resolves.toBe("aborted");
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    } finally {
      host.close();
    }
  });

  it("hands an already-aborted signal to a call that arrives with no active turn", async () => {
    const { descriptor, signals, aborted } = parkingDescriptor();
    const host = await ToolHost.listen([descriptor], { turnSignal: () => null });
    try {
      const { socket } = await openCall(host.socketPath, "park");
      await expect(aborted).resolves.toBe("aborted");
      expect(signals[0]!.aborted).toBe(true);
      socket.destroy();
    } finally {
      host.close();
    }
  });

  it("close() aborts live calls and destroys their sockets, not only the listener", async () => {
    const { descriptor, signals, aborted } = parkingDescriptor();
    const host = await ToolHost.listen([descriptor]);
    const { socket, closed } = await openCall(host.socketPath, "park");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    host.close();
    await expect(aborted).resolves.toBe("aborted");
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});

it.each(["success", "disconnect", "serialize"])("result ownership follows the real socket boundary: %s", async scenario => {
  const { bindToolResultHandoff } = await import("@kaoiro/agent-common");
  const commit = vi.fn(), rollback = vi.fn(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }); let entered = false;
  const host = await ToolHost.listen([{ ...ECHO, name: "send_to_agent", handler: async () => {
    entered = true; await gate;
    const result = { content: [{ type: "text" as const, text: "complete recovery body" }] };
    if (scenario === "serialize") Object.assign(result, { cycle: result });
    return bindToolResultHandoff(result, { live: () => true, commit, rollback });
  } }]);
  const socket = createConnection(host.socketPath); let frame = "";
  socket.setEncoding("utf8"); socket.on("data", data => { frame += data; });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(JSON.stringify({ id: 1, method: "call_tool", name: "send_to_agent", input: {} }) + "\n");
    await vi.waitFor(() => expect(entered).toBe(true));
    if (scenario === "disconnect") { socket.destroy(); await new Promise<void>(r => socket.once("close", r)); }
    release();
    if (scenario === "success") {
      await vi.waitFor(() => expect(frame).toContain("\n"));
      expect(JSON.parse(frame).result.content[0].text).toBe("complete recovery body"); expect(commit).toHaveBeenCalledOnce(); expect(rollback).not.toHaveBeenCalled();
    } else { await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce()); expect(commit).not.toHaveBeenCalled(); }
  } finally { release(); socket.destroy(); host.close(); }
});
