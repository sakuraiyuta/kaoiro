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

  it.each([
    ["null", "null"],
    ["an unknown decision with a reason", JSON.stringify({ decision: "bogus", reason: "x" })],
    ["a number", "5"],
  ])("rejects %s as a malformed answer", async (_label, line) => {
    await withServer((socket) => socket.end(`${line}\n`), async (path) => {
      await expect(askGate(path, "nonce", { hookEventName: "Stop" }, 500)).rejects.toThrow("malformed gate response");
    });
  });

  it("decodes the continue and stop answers of a Stop request", async () => {
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "continue", reason: "wait" })}\n`), async (path) => {
      await expect(askGate(path, "nonce", { hookEventName: "Stop" }, 500)).resolves.toEqual({ decision: "continue", reason: "wait" });
    });
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "stop" })}\n`), async (path) => {
      await expect(askGate(path, "nonce", { hookEventName: "Stop" }, 500)).resolves.toEqual({ decision: "stop" });
    });
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "continue" })}\n`), async (path) => {
      await expect(askGate(path, "nonce", { hookEventName: "Stop" }, 500)).rejects.toThrow("malformed gate response");
    });
  });

  async function runHook(env: Record<string, string | undefined>, payload: unknown): Promise<unknown> {
    const child = spawn(process.execPath, [kaoiroPath, "wrapper", "antigravity", "hook"], {
      env: { ...process.env, CODEX_HOME: undefined, KAOIRO_GATE_SOCKET: undefined, KAOIRO_GATE_NONCE: undefined, KAOIRO_GATE_DEADLINE_MS: undefined, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stdin.end(JSON.stringify(payload));
    const [code] = await once(child, "exit") as [number | null];
    expect(code).toBe(0);
    return JSON.parse(stdout);
  }

  const stopPayload = { hookEventName: "Stop", conversationId: "s", terminationReason: "NO_TOOL_CALL", fullyIdle: false };

  it("a Stop hook prints the gate's continue, and {} for stop, a missing gate or a broken answer", async () => {
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "continue", reason: "wait" })}\n`), async (path) => {
      expect(await runHook({ KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" }, stopPayload))
        .toEqual({ decision: "continue", reason: "wait" });
    });
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "stop" })}\n`), async (path) => {
      expect(await runHook({ KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" }, stopPayload)).toEqual({});
    });
    await withServer((socket) => socket.end("not-json\n"), async (path) => {
      expect(await runHook({ KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" }, stopPayload)).toEqual({});
    });
    expect(await runHook({}, stopPayload)).toEqual({});
  });

  it("a PreToolUse hook prints the gate's allow and deny as they are", async () => {
    const payload = { hookEventName: "PreToolUse", conversationId: "s", toolCall: { id: "c1", name: "read_file", args: {} } };
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "allow" })}\n`), async (path) => {
      expect(await runHook({ KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" }, payload))
        .toEqual({ decision: "allow" });
    });
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "deny", reason: "kaoiro: no" })}\n`), async (path) => {
      expect(await runHook({ KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" }, payload))
        .toEqual({ decision: "deny", reason: "kaoiro: no" });
    });
  });

  it("a PreToolUse hook names an unusable gate in its deny reason", async () => {
    await withServer((socket) => socket.end("not-json\n"), async (path) => {
      const answer = await runHook(
        { KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" },
        { hookEventName: "PreToolUse", conversationId: "s", toolCall: { id: "c1", name: "read_file", args: {} } },
      ) as { decision: string; reason: string };
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toMatch(/^kaoiro: gate unavailable \(/);
    });
  });

  it.each(["0", "-5", "abc", ""])("a gate deadline of %j is not configured: deny, or {} for Stop", async (deadline) => {
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "allow" })}\n`), async (path) => {
      const env = { KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: deadline };
      expect(await runHook(env, { hookEventName: "PreToolUse", conversationId: "s", toolCall: { id: "c1", name: "read_file", args: {} } }))
        .toEqual({ decision: "deny", reason: "kaoiro: gate environment is not configured" });
      expect(await runHook(env, stopPayload)).toEqual({});
    });
  });

  it.each([["null"], ["5"], ["[]"], ['"text"']])("a payload %s that is not an object is denied as malformed", async (payload) => {
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "allow" })}\n`), async (path) => {
      const child = spawn(process.execPath, [kaoiroPath, "wrapper", "antigravity", "hook"], {
        env: { ...process.env, CODEX_HOME: undefined, KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stdin.end(payload);
      await once(child, "exit");
      expect(JSON.parse(stdout)).toEqual({ decision: "deny", reason: "kaoiro: malformed hook payload" });
    });
  });

  it("a payload that is not JSON gives exactly one deny line", async () => {
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "allow" })}\n`), async (path) => {
      const child = spawn(process.execPath, [kaoiroPath, "wrapper", "antigravity", "hook"], {
        env: { ...process.env, CODEX_HOME: undefined, KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stdin.end("not-json");
      await once(child, "exit");
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout)).toEqual({ decision: "deny", reason: "kaoiro: malformed hook payload" });
    });
  });

  it("a PreToolUse hook denies a continue answer", async () => {
    await withServer((socket) => socket.end(`${JSON.stringify({ decision: "continue", reason: "wait" })}\n`), async (path) => {
      expect(await runHook(
        { KAOIRO_GATE_SOCKET: path, KAOIRO_GATE_NONCE: "nonce", KAOIRO_GATE_DEADLINE_MS: "500" },
        { hookEventName: "PreToolUse", conversationId: "s", toolCall: { id: "c1", name: "read_file", args: {} } },
      )).toMatchObject({ decision: "deny" });
    });
  });

  it("応答なしはdeadlineでsocketを閉じてrejectする", async () => {
    await withServer(() => {}, async (path) => {
      await expect(askGate(path, "nonce", { stepIdx: 1, toolCall: { name: "view_file", args: {} } }, 10)).rejects.toThrow("gate deadline exceeded");
    });
  });
});
