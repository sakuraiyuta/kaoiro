import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Default-composition gate for issue #469 (design: docs/plans/
// issue-469-runner-config-migration.md, section 3). It injects nothing: the
// real runner entrypoint reads a config file with no KAOIRO_* variables in its
// environment, a test-owned endpoint speaks just enough Phoenix v2 to accept
// the runner join and push one `spawn`, and the runner launches the built
// Claude wrapper through the real launcher. The assertion is on what the
// wrapper's own startup line reports it will use.

const runnerRoot = fileURLToPath(new URL("../", import.meta.url));
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeText(text: string): Buffer {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x81, length])
      : length < 65536
        ? Buffer.from([0x81, 126, length >> 8, length & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(length), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

/** Pops complete client frames (always masked) off `buffer`. */
function takeFrames(state: { buffer: Buffer }): Array<{ opcode: number; text: string }> {
  const frames: Array<{ opcode: number; text: string }> = [];
  for (;;) {
    const b = state.buffer;
    if (b.length < 2) break;
    const opcode = b[0]! & 0x0f;
    let length = b[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) break;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) break;
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    if (b.length < offset + 4 + length) break;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
    frames.push({ opcode, text: payload.toString("utf8") });
    state.buffer = b.subarray(offset + 4 + length);
  }
  return frames;
}

interface Endpoint {
  server: Server;
  port: number;
  sockets: Set<Duplex>;
}

async function startEndpoint(
  onRunnerJoined: (send: (frame: unknown[]) => void, topic: string) => void,
): Promise<Endpoint> {
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const key = String(request.headers["sec-websocket-key"] ?? "");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WS_GUID).digest("base64")}\r\n\r\n`,
    );
    const path = String(request.url ?? "");
    if (!path.startsWith("/runner")) return; // the wrapper side is not served
    const send = (frame: unknown[]) => socket.write(encodeText(JSON.stringify(frame)));
    const state = { buffer: Buffer.alloc(0) };
    socket.on("data", (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const { opcode, text } of takeFrames(state)) {
        if (opcode === 8) {
          socket.end();
          return;
        }
        if (opcode !== 1) continue;
        const [joinRef, ref, topic, event] = JSON.parse(text) as [
          string | null,
          string | null,
          string,
          string,
        ];
        if (ref !== null) {
          send([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
        }
        if (event === "phx_join" && topic.startsWith("runner:")) {
          onRunnerJoined(send, topic);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, sockets };
}

function waitFor(
  read: () => string,
  pattern: RegExp,
  child: ChildProcess,
  ms: number,
): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = pattern.exec(read());
      if (match !== null) {
        clearInterval(timer);
        resolve(match);
      } else if (child.exitCode !== null || Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error(`no ${pattern} in runner output:\n${read()}`));
      }
    }, 50);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("default composition (issue #469)", () => {
  it(
    "a config-only runner relays claude_code keys that the real wrapper reports it will use",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ao-469-gate-"));
      const configPath = join(root, "runner.config.json");
      let output = "";
      let runner: ChildProcess | undefined;
      let wrapperPid: number | undefined;
      const endpoint = await startEndpoint((send, topic) => {
        send([
          null,
          null,
          topic,
          "spawn",
          {
            version: "0",
            agent_id: "gate.agent",
            persona: { id: "p", name: "P", sprite_set: "p" },
            cwd: root,
            engine: "claude-code",
          },
        ]);
      });
      try {
        writeFileSync(
          configPath,
          JSON.stringify({
            host_id: "gate-host",
            server_url: `ws://127.0.0.1:${endpoint.port}/runner`,
            cwd_allowlist: [root],
            capabilities: ["claude-code"],
            claude_code: { folds_per_turn: 5, urgent_overtake_limit: 3 },
          }),
        );
        // Nothing but PATH and a private HOME: no KAOIRO_* variable at all.
        runner = spawn(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", configPath],
          {
            cwd: runnerRoot,
            env: { PATH: process.env.PATH ?? "", HOME: root },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        runner.stdout?.on("data", (chunk) => (output += String(chunk)));
        runner.stderr?.on("data", (chunk) => (output += String(chunk)));

        const line = await waitFor(
          () => output,
          /\[claude scheduler\] pid=(\d+) ([^\n]*)\n/,
          runner,
          60_000,
        );
        wrapperPid = Number(line[1]);
        expect(line[2]).toBe(
          "yield_claim_timeout_ms=default pending_receipt_root_timeout_ms=default " +
            "urgent_overtake_limit=3 folds_per_turn=5",
        );
      } finally {
        // Controlled stop: SIGTERM to the runner this test started; its
        // shutdown stops its tracked wrappers. `close` means the runner ended
        // and its stdio closed, so wrapper termination is checked by the pid
        // the wrapper reported (existence check only), never by pattern.
        if (runner !== undefined && runner.exitCode === null) {
          const closed = new Promise<void>((resolve) => runner!.once("close", () => resolve()));
          runner.kill("SIGTERM");
          await Promise.race([closed, new Promise((r) => setTimeout(r, 15_000))]);
          if (runner.exitCode === null) runner.kill("SIGKILL");
        }
        for (const socket of endpoint.sockets) socket.destroy();
        await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
      // Wrapper must be gone shortly after the runner closes.
      if (wrapperPid !== undefined) {
        const deadline = Date.now() + 10_000;
        while (isAlive(wrapperPid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const alive = isAlive(wrapperPid);
        if (alive) process.kill(wrapperPid, "SIGKILL"); // our own descendant, by pid
        expect(alive, `wrapper pid ${wrapperPid} outlived the runner`).toBe(false);
      }
    },
    120_000,
  );
});
