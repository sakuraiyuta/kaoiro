import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  /** Join params of every wrapper channel, by topic. */
  wrapperJoins: Map<string, Record<string, unknown>>;
}

/** Serves both sockets: the runner's (`/runner`, joined on `runner:*`) and the
 *  wrappers' (any other path, joined on `wrapper:*`). A wrapper join is
 *  answered with the `persona_prompt` push the real server sends after join,
 *  which is what lets each wrapper construct its host and watchdog. */
async function startEndpoint(
  onRunnerJoined: (send: (frame: unknown[]) => void, topic: string) => void,
): Promise<Endpoint> {
  const sockets = new Set<Duplex>();
  const wrapperJoins = new Map<string, Record<string, unknown>>();
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
    const isRunner = path.startsWith("/runner");
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
        const [joinRef, ref, topic, event, payload] = JSON.parse(text) as [
          string | null,
          string | null,
          string,
          string,
          Record<string, unknown>,
        ];
        if (ref !== null) {
          send([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
        }
        if (event === "phx_join" && isRunner && topic.startsWith("runner:")) {
          onRunnerJoined(send, topic);
        }
        if (event === "phx_join" && !isRunner && topic.startsWith("wrapper:")) {
          wrapperJoins.set(topic, payload);
          send([joinRef, null, topic, "persona_prompt", { version: "0", prompt: "gate persona prompt" }]);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, sockets, wrapperJoins };
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RUNNER_CLOSE_DEADLINE_MS = 15_000;

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(100);
  return done();
}

/** Stops the runner this test started: SIGTERM to the held child, SIGKILL
 *  only once the close deadline has passed. Returns every way the stop fell
 *  short, so a slow or stuck shutdown fails the test instead of passing. */
async function stopRunner(
  runner: ChildProcess,
  closed: Promise<void>,
  hasClosed: () => boolean,
): Promise<string[]> {
  const failures: string[] = [];
  if (hasClosed()) return failures;
  runner.kill("SIGTERM");
  await Promise.race([closed, sleep(RUNNER_CLOSE_DEADLINE_MS)]);
  if (hasClosed()) return failures;
  failures.push(`runner did not close within ${RUNNER_CLOSE_DEADLINE_MS}ms of SIGTERM`);
  runner.kill("SIGKILL");
  await Promise.race([closed, sleep(5_000)]);
  if (!hasClosed()) failures.push("runner did not close after SIGKILL");
  return failures;
}

/** Every wrapper pid the test saw must be gone once the runner has closed.
 *  Survivors are SIGKILLed by pid (they are descendants of the runner this
 *  test started, named by their own startup lines) and awaited. */
async function verifyWrappersGone(pids: Set<number>): Promise<string[]> {
  const failures: string[] = [];
  await waitUntil(() => ![...pids].some(isAlive), 10_000);
  const alive = [...pids].filter(isAlive);
  if (alive.length === 0) return failures;
  failures.push(`wrapper pids outlived the runner: ${alive.join(",")}`);
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone between the check and the signal
    }
  }
  if (!(await waitUntil(() => !alive.some(isAlive), 5_000))) {
    failures.push(`wrapper pids survived SIGKILL: ${alive.filter(isAlive).join(",")}`);
  }
  return failures;
}

describe("default composition (issue #469)", () => {
  it(
    "a config-only runner relays file settings that the real Claude, Codex and Antigravity wrappers' consumers report they received",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ao-469-gate-"));
      const configPath = join(root, "runner.config.json");
      let output = "";
      let runner: ChildProcess | undefined;
      let runnerClosed = false;
      let closed: Promise<void> = Promise.resolve();
      let primary: unknown;
      const wrapperPids = new Set<number>();
      const endpoint = await startEndpoint((send, topic) => {
        for (const engine of ["claude-code", "codex", "antigravity"]) {
          send([
            null,
            null,
            topic,
            "spawn",
            {
              version: "0",
              agent_id: `gate.${engine}`,
              persona: { id: "p", name: "P", sprite_set: "p" },
              cwd: root,
              engine,
            },
          ]);
        }
      });
      try {
        // A stand-in `agy` so the runner accepts an Antigravity launch.
        const agy = join(root, "agy");
        writeFileSync(agy, "#!/bin/sh\nexit 0\n");
        chmodSync(agy, 0o755);
        writeFileSync(
          configPath,
          JSON.stringify({
            host_id: "gate-host",
            server_url: `ws://127.0.0.1:${endpoint.port}/runner`,
            cwd_allowlist: [root],
            capabilities: ["claude-code", "codex", "antigravity"],
            permission_timeout_ms: 7000,
            claude_code: {
              yield_claim_timeout_ms: 1500,
              pending_receipt_root_timeout_ms: 2500,
              urgent_overtake_limit: 3,
              folds_per_turn: 5,
              turn_watchdog_inactivity_ms: 120_000,
              turn_watchdog_abort_grace_ms: 4000,
              phase2_delivery: true,
            },
            codex: {
              auth_mode: "chatgpt",
              chatgpt_plan: "pro",
              backend: "app-server",
              operator_steer: true,
              approval_axis: true,
              turn_watchdog_inactivity_ms: 90_000,
              turn_watchdog_abort_grace_ms: 3000,
            },
            antigravity: {
              cli_path: agy,
              turn_watchdog_inactivity_ms: 80_000,
              turn_watchdog_abort_grace_ms: 5000,
              tool_timeout_ms: 2000,
              epoch_idle_ms: 3000,
            },
          }),
        );
        // Nothing but PATH and a private HOME: no KAOIRO_* variable at all.
        const started = spawn(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", configPath],
          {
            cwd: runnerRoot,
            env: { PATH: process.env.PATH ?? "", HOME: root },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        runner = started;
        closed = new Promise<void>((resolve) =>
          started.once("close", () => {
            runnerClosed = true;
            resolve();
          }),
        );
        started.stdout?.on("data", (chunk) => (output += String(chunk)));
        started.stderr?.on("data", (chunk) => (output += String(chunk)));

        const lineFor = async (pattern: RegExp): Promise<RegExpExecArray> =>
          waitFor(() => output, pattern, started, 60_000);
        // "consumers" lines are printed by each wrapper after it has completed
        // the join handshake and constructed its host, watchdog and permission
        // broker, from the values those objects hold. "behaviour" lines are the
        // resolver's own output and carry each value's source.
        const claude = await lineFor(/\[kaoiro\] claude consumers: pid=(\d+) ([^\n]*)\n/);
        const codex = await lineFor(/\[kaoiro\] codex consumers: pid=(\d+) ([^\n]*)\n/);
        const antigravity = await lineFor(
          /\[kaoiro\] antigravity consumers: pid=(\d+) ([^\n]*)\n/,
        );
        for (const found of [claude, codex, antigravity]) {
          wrapperPids.add(Number(found[1]));
        }
        expect(claude[2]).toBe(
          "yield_claim_timeout_ms=1500 pending_receipt_root_timeout_ms=2500 " +
            "urgent_overtake_limit=3 folds_per_turn=5 " +
            "turn_watchdog_inactivity_ms=120000 turn_watchdog_abort_grace_ms=4000 " +
            "permission_broker_timeout_ms=7000",
        );
        expect(codex[2]).toBe(
          "turn_watchdog_inactivity_ms=90000 turn_watchdog_abort_grace_ms=3000 " +
            "permission_broker_timeout_ms=7000 operator_steer=on approval_axis=on " +
            "approval_deadline_ms=7000 approval_inactivity_limit_ms=90000",
        );
        expect(antigravity[2]).toBe(
          "turn_watchdog_inactivity_ms=80000 turn_watchdog_abort_grace_ms=5000 " +
            "tool_timeout_ms=2000 host_abort_grace_ms=5000 epoch_idle_ms=3000 " +
            "permission_broker_timeout_ms=7000",
        );

        // The flags are consumed by what each wrapper advertises at join: the
        // echo that the real server acts on.
        expect(endpoint.wrapperJoins.get("wrapper:gate.claude-code")?.inter_agent_delivery_modes)
          .toEqual({ version: "v1", early: "fold", yield: "tool_boundary", stage_reports: true });
        expect(endpoint.wrapperJoins.get("wrapper:gate.codex")?.operator_input_modes)
          .toEqual({ version: "v1", early: "steer" });

        const claudeBehaviour = await lineFor(
          /\[kaoiro\] claude behaviour: pid=\d+ ([^\n]*)\n/,
        );
        const codexBehaviour = await lineFor(/\[kaoiro\] codex behaviour: pid=\d+ ([^\n]*)\n/);
        const antigravityBehaviour = await lineFor(
          /\[kaoiro\] antigravity behaviour: pid=\d+ ([^\n]*)\n/,
        );
        expect(claudeBehaviour[1]).toBe(
          "turn_watchdog_inactivity_ms=120000(config) turn_watchdog_abort_grace_ms=4000(config) " +
            "permission_timeout_ms=7000",
        );
        expect(codexBehaviour[1]).toBe(
          "turn_watchdog_inactivity_ms=90000(config) turn_watchdog_abort_grace_ms=3000(config) " +
            "permission_timeout_ms=7000",
        );
        expect(antigravityBehaviour[1]).toBe(
          "turn_watchdog_inactivity_ms=80000(config) turn_watchdog_abort_grace_ms=5000(config) " +
            "permission_timeout_ms=7000 tool_timeout_ms=2000(config) epoch_idle_ms=3000(config)",
        );
      } catch (error) {
        primary = error;
      }
      // Cleanup runs on success and on assertion failure alike. Wrapper pids
      // come only from the wrappers' own startup lines.
      const failures: string[] = [];
      if (runner !== undefined) {
        failures.push(...(await stopRunner(runner, closed, () => runnerClosed)));
      }
      for (const match of output.matchAll(
        /\[kaoiro\] (?:claude|codex|antigravity) (?:behaviour|consumers): pid=(\d+) /g,
      )) {
        const pid = Number(match[1]);
        if (Number.isInteger(pid) && pid > 1) wrapperPids.add(pid);
      }
      failures.push(...(await verifyWrappersGone(wrapperPids)));
      for (const socket of endpoint.sockets) socket.destroy();
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
      const report =
        failures.length === 0
          ? `[cleanup] runner closed; wrapper pids [${[...wrapperPids].join(",")}] gone`
          : `[cleanup] ${failures.join("; ")}`;
      if (primary !== undefined) {
        if (primary instanceof Error) primary.message += `\n${report}`;
        throw primary;
      }
      expect(failures, report).toEqual([]);
    },
    180_000,
  );
});
