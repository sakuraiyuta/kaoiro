import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
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
