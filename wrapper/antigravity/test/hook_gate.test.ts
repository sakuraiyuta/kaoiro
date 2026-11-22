import "../../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CallVerifier, type VerificationFault } from "../src/call_verification.js";
import { askGate } from "../src/hook_client.js";
import { HookGateServer, type HookGateHandlers, type PreToolUseRequest } from "../src/hook_gate.js";
import { STOP_CONTINUE_REASON } from "../src/stop_answer.js";

const SESSION = "session-g";
const open: HookGateServer[] = [];

afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

async function start(handlers: Partial<HookGateHandlers> = {}) {
  const faults: VerificationFault[] = [];
  const verifier = new CallVerifier({ sessionId: () => SESSION, onFault: (fault) => faults.push(fault) });
  const seen: PreToolUseRequest[] = [];
  const server = await HookGateServer.listen({
    nonce: "nonce",
    verifier,
    handlers: {
      preToolUse: handlers.preToolUse ?? (async (request) => {
        seen.push(request);
        return { decision: "allow" };
      }),
      stop: handlers.stop ?? (() => ({ decision: "stop" })),
    },
  });
  open.push(server);
  return { server, verifier, faults, seen };
}

function preToolUse(callId = "c1", conversationId = SESSION, args: Record<string, unknown> = { CommandLine: "ls" }) {
  return {
    hookEventName: "PreToolUse",
    conversationId,
    stepIdx: 3,
    toolCall: { id: callId, name: "run_command", args },
  };
}

function rawLine(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { buffer += chunk; });
    socket.on("end", () => resolve(buffer));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${line}\n`));
  });
}

describe("HookGateServer: PreToolUse", () => {
  it("records H, answers through the production client, and records the decision after it was written", async () => {
    const { server, verifier, faults, seen } = await start();
    verifier.toolUpdate("c1", "run_command", { CommandLine: "ls" }, "in_progress");
    await expect(askGate(server.socketPath, server.nonce, preToolUse(), 1_000)).resolves.toEqual({ decision: "allow" });
    expect(seen).toEqual([{ conversationId: SESSION, callId: "c1", name: "run_command", args: { CommandLine: "ls" } }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    verifier.toolUpdate("c1", "run_command", { CommandLine: "ls" }, "completed");
    expect(faults).toEqual([]);
  });

  it("passes the deny reason through", async () => {
    const { server } = await start({ preToolUse: async () => ({ decision: "deny", reason: "kaoiro: no" }) });
    await expect(askGate(server.socketPath, server.nonce, preToolUse(), 1_000)).resolves.toEqual({ decision: "deny", reason: "kaoiro: no" });
  });

  it("aborts the wait and records abandoned when the hook connection closes first", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const { server, verifier, faults } = await start({
      preToolUse: async (_request, s) => {
        signal = s;
        await released;
        return { decision: "allow" };
      },
    });
    verifier.toolUpdate("c1", "run_command", { CommandLine: "ls" }, "in_progress");
    const socket: Socket = createConnection(server.socketPath);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write(`${JSON.stringify({ ...preToolUse(), nonce: "nonce" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    verifier.toolUpdate("c1", "run_command", { CommandLine: "ls" }, "completed");
    expect(faults).toEqual([{ kind: "unobserved_tool", callId: "c1", name: "run_command", status: "completed", hook: "abandoned" }]);
  });

  it("refuses a second request with the same key and reports the duplicate", async () => {
    const { server, faults } = await start();
    await askGate(server.socketPath, server.nonce, preToolUse(), 1_000);
    await expect(askGate(server.socketPath, server.nonce, preToolUse(), 1_000)).resolves.toEqual({
      decision: "deny", reason: "kaoiro: duplicate tool call",
    });
    expect(faults).toEqual([{ kind: "duplicate_hook", conversationId: SESSION, callId: "c1", name: "run_command" }]);
  });

  it("hands a request from another conversation to the same handler and keeps its own record", async () => {
    const { server, faults, seen } = await start();
    await askGate(server.socketPath, server.nonce, preToolUse("c1", "session-sub"), 1_000);
    await askGate(server.socketPath, server.nonce, preToolUse("c1", SESSION), 1_000);
    expect(seen.map((request) => request.conversationId)).toEqual(["session-sub", SESSION]);
    expect(faults).toEqual([]);
  });

  it("answers deny when the handler fails", async () => {
    const { server } = await start({ preToolUse: async () => { throw new Error("boom"); } });
    await expect(askGate(server.socketPath, server.nonce, preToolUse(), 1_000)).resolves.toEqual({
      decision: "deny", reason: "kaoiro: gate failure",
    });
  });
});

describe("HookGateServer: Stop", () => {
  it("answers continue with the reason, and stop", async () => {
    const answers = [{ decision: "continue" as const, reason: STOP_CONTINUE_REASON }, { decision: "stop" as const }];
    const requests: unknown[] = [];
    const { server, faults } = await start({
      stop: (request) => {
        requests.push(request);
        return answers.shift()!;
      },
    });
    const body = { hookEventName: "Stop", conversationId: SESSION, terminationReason: "NO_TOOL_CALL", fullyIdle: false, executionNum: 2 };
    await expect(askGate(server.socketPath, server.nonce, body, 1_000)).resolves.toEqual({ decision: "continue", reason: STOP_CONTINUE_REASON });
    await expect(askGate(server.socketPath, server.nonce, body, 1_000)).resolves.toEqual({ decision: "stop" });
    expect(requests).toEqual([
      { conversationId: SESSION, terminationReason: "NO_TOOL_CALL", fullyIdle: false },
      { conversationId: SESSION, terminationReason: "NO_TOOL_CALL", fullyIdle: false },
    ]);
    expect(faults).toEqual([]);
  });
});

describe("HookGateServer: invalid requests", () => {
  it.each([
    ["a wrong nonce", { ...preToolUse(), nonce: "other" }],
    ["no conversation ID", { ...preToolUse(), conversationId: undefined, nonce: "nonce" }],
    ["no call ID", { ...preToolUse(), toolCall: { name: "run_command", args: {} }, nonce: "nonce" }],
    ["arguments that are not an object", { ...preToolUse(), toolCall: { id: "c1", name: "run_command", args: [] }, nonce: "nonce" }],
    ["another event", { ...preToolUse(), hookEventName: "PostToolUse", nonce: "nonce" }],
  ])("denies %s without asking the handler", async (_label, body) => {
    const { server, seen } = await start();
    const answer = await rawLine(server.socketPath, JSON.stringify(body));
    expect(JSON.parse(answer)).toEqual({ decision: "deny", reason: "kaoiro: invalid gate request" });
    expect(seen).toEqual([]);
  });

  it("denies a line that is not JSON", async () => {
    const { server } = await start();
    expect(JSON.parse(await rawLine(server.socketPath, "not-json"))).toEqual({ decision: "deny", reason: "kaoiro: invalid gate request" });
  });

  it.each([
    ["null", "null"],
    ["no toolCall", JSON.stringify({ hookEventName: "PreToolUse", conversationId: SESSION, nonce: "nonce" })],
    ["a numeric tool name", JSON.stringify({ ...preToolUse(), toolCall: { id: "c1", name: 5, args: {} }, nonce: "nonce" })],
  ])("denies %s without asking the handler", async (_label, line) => {
    const { server, seen } = await start();
    expect(JSON.parse(await rawLine(server.socketPath, line))).toEqual({ decision: "deny", reason: "kaoiro: invalid gate request" });
    expect(seen).toEqual([]);
  });
});

describe("HookGateServer: framing", () => {
  it("answers one line per connection and ignores a second line", async () => {
    const { server, seen } = await start();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(server.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { buffer += chunk; });
      socket.on("end", () => resolve(buffer));
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ ...preToolUse("c1"), nonce: "nonce" })}\n${JSON.stringify({ ...preToolUse("c2"), nonce: "nonce" })}\n`);
        // A later write on the same connection is ignored too.
        setTimeout(() => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ ...preToolUse("c3"), nonce: "nonce" })}\n`);
        }, 5);
      });
    });
    expect(answer.trim().split("\n")).toHaveLength(1);
    expect(seen.map((request) => request.callId)).toEqual(["c1"]);
  });

  it("waits for the newline of a request split across writes", async () => {
    const { server, seen } = await start();
    const line = JSON.stringify({ ...preToolUse(), nonce: "nonce" });
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(server.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { buffer += chunk; });
      socket.on("end", () => resolve(buffer));
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(line.slice(0, 20));
        setTimeout(() => socket.write(`${line.slice(20)}\n`), 20);
      });
    });
    expect(JSON.parse(answer)).toEqual({ decision: "allow" });
    expect(seen).toHaveLength(1);
  });

  it("a duplicate does not change the pending original's record", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { server, verifier, faults } = await start({
      preToolUse: async () => {
        calls += 1;
        await released;
        return { decision: "allow" };
      },
    });
    verifier.toolUpdate("c1", "run_command", { CommandLine: "ls" }, "in_progress");
    const first = askGate(server.socketPath, server.nonce, preToolUse(), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(askGate(server.socketPath, server.nonce, preToolUse(), 1_000)).resolves.toEqual({
      decision: "deny", reason: "kaoiro: duplicate tool call",
    });
    release();
    await expect(first).resolves.toEqual({ decision: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(faults).toEqual([{ kind: "duplicate_hook", conversationId: SESSION, callId: "c1", name: "run_command" }]);
    verifier.toolUpdate("c1", "run_command", { CommandLine: "ls" }, "completed");
    expect(faults).toHaveLength(1);
  });
});

describe("HookGateServer: close", () => {
  it("closes pending connections and removes its directory", async () => {
    const { server } = await start({ preToolUse: () => new Promise(() => {}) });
    const pending = askGate(server.socketPath, server.nonce, preToolUse(), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.close();
    await expect(pending).rejects.toThrow("gate socket closed");
    expect(existsSync(server.socketPath)).toBe(false);
  });
});
