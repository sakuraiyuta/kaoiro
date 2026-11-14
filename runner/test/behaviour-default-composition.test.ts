import "../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";

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

type Signal = 0 | NodeJS.Signals;
type SignalBackend = (pid: number, signal: Signal) => unknown;

function isAlive(rawPid: unknown, signal: SignalBackend = (pid, value) => process.kill(pid, value)): boolean {
  const pid = requirePositiveSafePid(rawPid);
  try {
    signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(
  rawPid: unknown,
  signalValue: NodeJS.Signals,
  signal: SignalBackend = (pid, value) => process.kill(pid, value),
): void {
  const pid = requirePositiveSafePid(rawPid);
  try {
    signal(pid, signalValue);
  } catch {
    // The wrapper can exit between the liveness check and cleanup signal.
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
  await waitUntil(() => ![...pids].some((pid) => isAlive(pid)), 10_000);
  const alive = [...pids].filter((pid) => isAlive(pid));
  if (alive.length === 0) return failures;
  failures.push(`wrapper pids outlived the runner: ${alive.join(",")}`);
  for (const pid of alive) {
    signalPid(pid, "SIGKILL");
  }
  if (!(await waitUntil(() => !alive.some((pid) => isAlive(pid)), 5_000))) {
    failures.push(`wrapper pids survived SIGKILL: ${alive.filter((pid) => isAlive(pid)).join(",")}`);
  }
  return failures;
}

/** The runner this test starts leads its own process group (`detached: true`),
 *  so its pgid is its pid and the group holds only its descendants that did not
 *  start a session or group themselves. Subtrees started detached on purpose
 *  (the Antigravity `agy` spawn, the Grok ACP probe) are separate groups that
 *  nothing here waits for or kills; this test starts neither. */
interface RunnerGroup {
  readonly pgid: number;
  /** True once the last probe said the group is empty (or not ours). No signal
   *  of any kind is sent to the pgid after that: the number may be reused. */
  ended: boolean;
  settling?: Promise<GroupOutcome> | undefined;
}
interface GroupOutcome {
  emptyAfterMs: number | null;
  failures: string[];
}
type GroupKill = (target: number, signal: 0 | "SIGKILL") => unknown;
interface SettleOptions {
  waitMs?: number;
  killWaitMs?: number;
  pollMs?: number;
  kill?: GroupKill;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const GROUP_WAIT_MS = 10_000;
const GROUP_KILL_WAIT_MS = 5_000;
const GROUP_POLL_MS = 25;
const defaultGroupKill: GroupKill = (target, signal) => process.kill(target, signal);

function requireGroupPid(raw: unknown): number {
  const pid = requirePositiveSafePid(raw);
  if (pid <= 1) throw new RangeError("a process group id must be greater than 1");
  return pid;
}

function openRunnerGroup(rawPid: unknown): RunnerGroup {
  return { pgid: requireGroupPid(rawPid), ended: false };
}

/** Waits for the runner's process group to empty, then SIGKILLs it at most once
 *  per call if it does not within `waitMs`. A group that still answers after
 *  that SIGKILL is not ended (it was not proven empty), so a later call may send
 *  one more; that is safe because POSIX does not reuse a process ID while a
 *  process group with that ID exists. The only target ever signalled is
 *  `-pgid`, with signal 0 or SIGKILL. ESRCH from a probe or from the SIGKILL
 *  ends it for good;
 *  any other error (EPERM) means a member is not ours, which only happens after
 *  the pgid was reused, so nothing is killed. Accepted residual: the group can
 *  empty and its number be reused between a successful probe and the SIGKILL.
 *  A zombie member answers signal 0; orphans were reaped within about 20 ms
 *  where this was measured. Calls on an ended group make no signal calls, and a
 *  call made while another is running joins it. */
function settleRunnerGroup(group: RunnerGroup, options: SettleOptions = {}): Promise<GroupOutcome> {
  if (group.settling !== undefined) return group.settling;
  const run = runSettle(group, options).finally(() => {
    if (!group.ended) group.settling = undefined;
  });
  group.settling = run;
  return run;
}

async function runSettle(group: RunnerGroup, options: SettleOptions): Promise<GroupOutcome> {
  const pgid = requireGroupPid(group.pgid);
  const kill = options.kill ?? defaultGroupKill;
  const now = options.now ?? Date.now;
  const nap = options.sleep ?? sleep;
  const waitMs = options.waitMs ?? GROUP_WAIT_MS;
  const killWaitMs = options.killWaitMs ?? GROUP_KILL_WAIT_MS;
  const pollMs = options.pollMs ?? GROUP_POLL_MS;
  const started = now();
  const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
  const done = (failures: string[], empty: boolean): GroupOutcome => {
    group.ended = true;
    return { emptyAfterMs: empty ? now() - started : null, failures };
  };
  const notOurs = `runner process group ${pgid} is not owned by this test; nothing was killed`;
  let killedAt: number | undefined;
  for (;;) {
    try {
      kill(-pgid, 0);
    } catch (error) {
      if (codeOf(error) !== "ESRCH") return done([notOurs], false);
      return done(
        killedAt === undefined
          ? []
          : ["runner process group members survived the wait and were SIGKILLed"],
        true,
      );
    }
    if (killedAt !== undefined) {
      if (now() - killedAt >= killWaitMs) {
        return { emptyAfterMs: null, failures: ["runner process group members survived SIGKILL"] };
      }
    } else if (now() - started >= waitMs) {
      killedAt = now();
      try {
        kill(-pgid, "SIGKILL");
      } catch (error) {
        if (codeOf(error) === "ESRCH") return done([], true);
        return done([notOurs], false);
      }
      continue;
    }
    await nap(pollMs);
  }
}

/** Removes the fixture only after the runner's process group is gone, so no
 *  descendant can write into it. `rmSync` retries only its last `rmdir` and never
 *  re-scans, so retrying cannot stand in for the wait. */
async function removeFixtureAfterGroup(
  root: string,
  group: RunnerGroup,
  options: SettleOptions = {},
): Promise<GroupOutcome> {
  const outcome = await settleRunnerGroup(group, options);
  const failures = [...outcome.failures];
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    failures.push(`fixture removal failed: ${String(error)}`);
  }
  return { emptyAfterMs: outcome.emptyAfterMs, failures };
}

// An aborted body (Vitest timeout, an escaping error) never reaches its own
// cleanup. A hard kill of the worker or a SIGINT that skips this hook still
// leaves the runner, wrappers and CLI running; that is an accepted residual for
// local aborts. The checks are outside the helper on purpose.
let liveGroup: RunnerGroup | undefined;
afterAll(async () => {
  const group = liveGroup;
  if (group === undefined || group.ended) return;
  await settleRunnerGroup(group, { waitMs: 0 });
});

describe("default composition (issue #469)", () => {
  it(
    "a config-only runner relays file settings that the real Claude, Codex and Antigravity wrappers' consumers report they received",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ao-469-gate-"));
      const configPath = join(root, "runner.config.json");
      let output = "";
      let runner: ChildProcess | undefined;
      let runnerGroup: RunnerGroup | undefined;
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
            detached: true,
          },
        );
        runner = started;
        if (started.pid !== undefined) runnerGroup = liveGroup = openRunnerGroup(started.pid);
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
          const pid = requirePositiveSafePid(found[1]);
          if (pid > 1) wrapperPids.add(pid);
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
        const pid = requirePositiveSafePid(match[1]);
        if (pid > 1) wrapperPids.add(pid);
      }
      failures.push(...(await verifyWrappersGone(wrapperPids)));
      for (const socket of endpoint.sockets) socket.destroy();
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      let groupNote = "";
      if (runnerGroup !== undefined) {
        const removed = await removeFixtureAfterGroup(root, runnerGroup);
        failures.push(...removed.failures);
        groupNote =
          removed.emptyAfterMs === null
            ? ""
            : `; runner process group empty after ${removed.emptyAfterMs} ms`;
      } else {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          failures.push(`fixture removal failed: ${String(error)}`);
        }
      }
      const report =
        failures.length === 0
          ? `[cleanup] runner closed; wrapper pids [${[...wrapperPids].join(",")}] gone${groupNote}`
          : `[cleanup] ${failures.join("; ")}`;
      if (primary !== undefined) {
        if (primary instanceof Error) primary.message += `\n${report}`;
        throw primary;
      }
      expect(failures, report).toEqual([]);
      console.info(report);
    },
    180_000,
  );
});

describe("PID signal helpers", () => {
  it("rejects invalid observed PIDs before a signal backend is called", () => {
    const calls: Array<[number, Signal]> = [];
    const fakeSignal: SignalBackend = (pid, signal) => { calls.push([pid, signal]); };
    for (const invalid of ["", "  ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => isAlive(invalid, fakeSignal)).toThrow(RangeError);
      expect(() => signalPid(invalid, "SIGKILL", fakeSignal)).toThrow(RangeError);
      expect(calls).toEqual([]);
    }
    expect(isAlive("42", fakeSignal)).toBe(true);
    signalPid("42", "SIGKILL", fakeSignal);
    expect(calls).toEqual([[42, 0], [42, "SIGKILL"]]);
  });
});

describe("runner group signal helper (fake backend)", () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const PG = 4242;
  function scripted(behaviour: { afterKill?: "gone" | "alive" | "EPERM"; first?: "alive" | "EPERM"; kill?: "ok" | "ESRCH" | "EPERM" } = {}) {
    const calls: Array<[number, 0 | "SIGKILL"]> = [];
    let killed = false;
    const kill: GroupKill = (target, signal) => {
      calls.push([target, signal]);
      if (signal === "SIGKILL") {
        killed = true;
        if (behaviour.kill === "ESRCH") throw errno("ESRCH");
        if (behaviour.kill === "EPERM") throw errno("EPERM");
        return;
      }
      if (!killed && behaviour.first === "EPERM") throw errno("EPERM");
      if (killed && behaviour.afterKill === "gone") throw errno("ESRCH");
      if (killed && behaviour.afterKill === "EPERM") throw errno("EPERM");
    };
    let clock = 0;
    return { calls, options: { kill, now: () => clock, sleep: async (ms: number) => { clock += ms; }, waitMs: 100, killWaitMs: 100, pollMs: 50 } };
  }
  const sigkills = (calls: Array<[number, 0 | "SIGKILL"]>) => calls.filter(([, signal]) => signal === "SIGKILL").length;

  it("rejects group ids that could reach the caller's own group or init before any signal", async () => {
    for (const bad of [0, 1, -1, Number.NaN, undefined, null, "12abc", "", 1.5, 2 ** 53]) {
      expect(() => openRunnerGroup(bad), String(bad)).toThrow(RangeError);
      const fake = scripted();
      await expect(settleRunnerGroup({ pgid: bad as number, ended: false }, fake.options), String(bad)).rejects.toThrow(RangeError);
      expect(fake.calls).toEqual([]);
    }
    expect(openRunnerGroup(2).pgid).toBe(2);
  });

  it("returns without a kill when the group empties on its own", async () => {
    const fake = scripted({ afterKill: "gone" });
    let probes = 0;
    const kill: GroupKill = (target, signal) => {
      fake.calls.push([target, signal]);
      if (++probes === 3) throw errno("ESRCH");
    };
    const outcome = await settleRunnerGroup(openRunnerGroup(PG), { ...fake.options, kill });
    expect(fake.calls).toEqual([[-PG, 0], [-PG, 0], [-PG, 0]]);
    expect(outcome).toEqual({ emptyAfterMs: 100, failures: [] });
  });

  it("SIGKILLs once at the deadline, then stops at the first ESRCH", async () => {
    const fake = scripted({ afterKill: "gone" });
    const group = openRunnerGroup(PG);
    const outcome = await settleRunnerGroup(group, fake.options);
    expect(fake.calls).toEqual([[-PG, 0], [-PG, 0], [-PG, 0], [-PG, "SIGKILL"], [-PG, 0]]);
    expect(outcome.failures).toEqual(["runner process group members survived the wait and were SIGKILLed"]);
    expect(group.ended).toBe(true);
  });

  it("reports members that survive the SIGKILL and sends it only once per call", async () => {
    const fake = scripted({ afterKill: "alive" });
    const group = openRunnerGroup(PG);
    const outcome = await settleRunnerGroup(group, fake.options);
    expect(sigkills(fake.calls)).toBe(1);
    expect(outcome.failures).toEqual(["runner process group members survived SIGKILL"]);
    expect(group.ended).toBe(false);
  });

  it("treats EPERM as not ours: no kill, one failure", async () => {
    const first = scripted({ first: "EPERM" });
    const a = await settleRunnerGroup(openRunnerGroup(PG), first.options);
    expect(first.calls).toEqual([[-PG, 0]]);
    expect(a.failures).toHaveLength(1);
    expect(a.failures[0]).toMatch(/not owned/);
    const late = scripted({ afterKill: "EPERM" });
    const b = await settleRunnerGroup(openRunnerGroup(PG), late.options);
    expect(sigkills(late.calls)).toBe(1);
    expect(late.calls.at(-1)).toEqual([-PG, 0]);
    expect(b.failures).toHaveLength(1);
    expect(b.failures[0]).toMatch(/not owned/);
    const refused = scripted({ kill: "EPERM" });
    const c = await settleRunnerGroup(openRunnerGroup(PG), refused.options);
    expect(sigkills(refused.calls)).toBe(1);
    expect(refused.calls.at(-1)).toEqual([-PG, "SIGKILL"]);
    expect(c.failures[0]).toMatch(/not owned/);
  });

  it("ends at an ESRCH from the SIGKILL itself with nothing sent after it", async () => {
    const fake = scripted({ kill: "ESRCH" });
    const group = openRunnerGroup(PG);
    const outcome = await settleRunnerGroup(group, fake.options);
    expect(fake.calls.at(-1)).toEqual([-PG, "SIGKILL"]);
    expect(sigkills(fake.calls)).toBe(1);
    expect(outcome.failures).toEqual([]);
    expect(group.ended).toBe(true);
  });

  it("makes no signal call on an ended group and joins a running call", async () => {
    const fake = scripted({ afterKill: "gone" });
    const group = openRunnerGroup(PG);
    const [one, two] = await Promise.all([settleRunnerGroup(group, fake.options), settleRunnerGroup(group, fake.options)]);
    expect(two).toBe(one);
    const before = fake.calls.length;
    expect(await settleRunnerGroup(group, fake.options)).toBe(one);
    expect(fake.calls).toHaveLength(before);
    expect(sigkills(fake.calls)).toBe(1);
  });
});

describe("runner group cleanup with real processes", () => {
  // The leader leads its own group (detached) and exits at once; the grandchild it
  // leaves behind stays in the group as an orphan, like the Claude CLI does.
  const LEADER = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" });
    process.stdout.write(String(child.pid) + "\\n");
    child.unref();
    process.exit(0);
  `;
  const LATE_WRITER = `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const root = process.argv[1];
    const end = Date.now() + 1500;
    let n = 0;
    const timer = setInterval(() => {
      if (Date.now() > end) return clearInterval(timer);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "late-" + n++), "x");
    }, 10);
  `;
  const NEVER_EXITS = "setInterval(() => {}, 1000);";

  async function orphanedGroup(grandchildSource: string, root: string): Promise<{ group: RunnerGroup; grandchild: number }> {
    const leader = spawn(process.execPath, ["-e", LEADER, grandchildSource, root], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    leader.stdout?.on("data", (chunk) => (out += String(chunk)));
    await new Promise<void>((resolve) => leader.once("close", () => resolve()));
    return { group: openRunnerGroup(leader.pid), grandchild: requirePositiveSafePid(out.trim()) };
  }

  it("waits out an orphaned late writer before removing the fixture, and nothing recreates it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ao-752-late-"));
    try {
      const { group } = await orphanedGroup(LATE_WRITER, root);
      const removed = await removeFixtureAfterGroup(root, group);
      expect(removed.failures).toEqual([]);
      expect(removed.emptyAfterMs).not.toBeNull();
      expect(existsSync(root)).toBe(false);
      await sleep(500);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("SIGKILLs the group at the deadline and reports exactly one failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ao-752-stuck-"));
    let group: RunnerGroup | undefined;
    try {
      const orphan = await orphanedGroup(NEVER_EXITS, root);
      group = orphan.group;
      const removed = await removeFixtureAfterGroup(root, group, { waitMs: 300 });
      expect(removed.failures).toEqual(["runner process group members survived the wait and were SIGKILLed"]);
      expect(group.ended).toBe(true);
      expect(isAlive(orphan.grandchild)).toBe(false);
    } finally {
      if (group !== undefined && !group.ended) await settleRunnerGroup(group, { waitMs: 0 });
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
