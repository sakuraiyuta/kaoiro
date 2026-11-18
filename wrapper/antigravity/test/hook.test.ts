import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askGate } from "../src/hook_client.js";
import { runAntigravityHook } from "../src/hook.js";

const kaoiroPath = fileURLToPath(new URL("../../../runner/dist/kaoiro.js", import.meta.url));

async function withServer(
  serve: (socket: Socket) => void,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agy-hook-test-"));
  const path = join(dir, "gate.sock");
  const server = createServer();
  server.on("connection", serve);
  await new Promise<void>((resolve, reject) => server.listen(path, () => resolve()).once("error", reject));
  try {
    await run(path);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("hook gate client", () => {
  it("exports runAntigravityHook without running on import", () => {
    expect(typeof runAntigravityHook).toBe("function");
  });

  it("malformed responseはkaoiro wrapper antigravity hook経路でもdenyしてexitする", async () => {
    await withServer((socket) => socket.end("not-json\n"), async (path) => {
      const child = spawn(process.execPath, [kaoiroPath, "wrapper", "antigravity", "hook"], {
        env: { ...process.env, CODEX_HOME: undefined, KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stdin.end(JSON.stringify({ stepIdx: 1, toolCall: { name: "view_file", args: {} } }));
      const [code] = await once(child, "exit") as [number | null];
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ decision: "deny" });
    });
  });

  it("malformedなwrapper応答をproduction client経路でdenyへ倒せるrejectにする", async () => {
    await withServer((socket) => socket.end("not-json\n"), async (path) => {
      await expect(askGate(path, "nonce", { stepIdx: 1, toolCall: { name: "view_file", args: {} } }, 500)).rejects.toThrow("malformed gate response");
    });
  });

  it("応答なしはdeadlineでsocketを閉じてrejectする", async () => {
    await withServer(() => {}, async (path) => {
      await expect(askGate(path, "nonce", { stepIdx: 1, toolCall: { name: "view_file", args: {} } }, 10)).rejects.toThrow("gate deadline exceeded");
    });
  });
});
