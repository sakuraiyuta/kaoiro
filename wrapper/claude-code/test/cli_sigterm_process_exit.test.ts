// issue #391 M2: the pins in cli_sigterm_abort_real_process.test.ts fire
// `process.emit("SIGTERM")` inside the SAME vitest process and only assert
// that `runClaudeCli()`'s returned promise settles -- that proves close()
// tears down the real SDK child, but NOT that the wrapper process itself
// ever exits. Node's event loop only empties when every timer/handle is
// gone; a promise resolving is not evidence of that. Unlike antigravity
// (issue #379), whose in-process pin is justified because the agy child's
// own stdio keeps the loop alive regardless, the Claude Agent SDK's
// escalation timers are `.unref()`'d -- the opposite situation, so the same
// shortcut is not justified here.
//
// This test spawns the REAL wrapper CLI as its own OS process (plain node with
// tsx's ESM loader, since the package ships TypeScript sources) with a REAL `ServerLink` (no
// `createServerLink` stub -- the runner script omits the option entirely,
// so `runClaudeCli` falls back to its own default, `new ServerLink(...)`)
// backed by a Phoenix-loopback peer (issue #391 round2 K5, mirroring
// Codex's `cli_sigterm_process_exit.integration.test.ts`), and a fixture
// `claude` binary that honors SIGTERM. It sends the process a real OS
// SIGTERM and asserts on the child_process `exit` event: `code === 0` (the
// process ended by its event loop emptying, not by an explicit
// `process.exit()` call racing teardown) within the runner's reset grace,
// and that the real link's `disconnect_intent` reached the wire -- proving
// the exit path drains the link's own teardown (flushInterAgentRetirements,
// reportDisconnectIntent, socket close), not just the SDK child.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { embeddedPidMarkerWriter, readPidMarker } from "../../core/test/pid_marker.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const isLinux = process.platform === "linux";
const testDir = dirname(fileURLToPath(import.meta.url));
// The runner is started by plain node with tsx's ESM loader, not the tsx CLI.
// The CLI relays SIGTERM to its child on a 30 ms reply window and exits 143
// when the child answers late (see the first test). Production starts node on
// the built dist/cli.js directly (runner/src/spawn.ts:79), so the loader is
// the only tsx code in this test's launch path, and the signal goes straight
// to the process that owns the handler. The tsx CLI's dev path (KAOIRO_WRAPPER_DEV,
// `tsx watch`, runner/src/spawn.ts:65-77) has the same relay; it is not used here.
const tsxEsmUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const cliSrcPath = join(testDir, "..", "src", "cli.ts");
const hostSrcPath = join(testDir, "..", "src", "host.ts");

type Signal = 0 | NodeJS.Signals;
type SignalBackend = (pid: number, signal: Signal) => unknown;

function isAlive(rawPid: unknown, signal: SignalBackend = (pid, signal) => process.kill(pid, signal)): boolean {
  const pid = requirePositiveSafePid(rawPid);
  try {
    signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// issue #391 round2 S2: monotonic, not wall-clock -- a WSL2 clock step (or
// any NTP/VM-suspend adjustment) can move Date.now() by seconds without any
// time actually elapsing, producing both a false timeout here and a false
// pass/fail on the elapsedMs bound below.
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function forceKill(rawPid: unknown, signal: SignalBackend = (pid, value) => process.kill(pid, value)): void {
  if (rawPid === undefined) return;
  const pid = requirePositiveSafePid(rawPid);
  try {
    signal(pid, "SIGKILL");
  } catch {
    // Already gone -- fine.
  }
}

/** Injected load: SIGSTOP `rawPid` now and SIGCONT it after `ms`. The PID is
 *  validated first, and it must be a process this test spawned. While stopped
 *  the process cannot answer anything, so a relay that waits for an answer
 *  gives up on it; a process that owns SIGTERM handles it once resumed. */
function pauseFor(rawPid: unknown, ms: number): Promise<void> {
  const pid = requirePositiveSafePid(rawPid);
  process.kill(pid, "SIGSTOP");
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // Already gone -- fine.
      }
      resolve();
    }, ms);
  });
}

/** SIGTERM-cooperative fixture, same shape as the one in
 *  cli_sigterm_abort_real_process.test.ts's grace-path pin. */
function writeFixture(root: string): { executable: string; pidFile: string } {
  const executable = join(root, "claude-fixture.mjs");
  const pidFile = join(root, "fixture.pid");
  writeFileSync(executable, `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const publishPidMarker = ${embeddedPidMarkerWriter()};
process.on("SIGTERM", () => process.exit(0));
publishPidMarker(${JSON.stringify(pidFile)}, process.pid, { writeFileSync, renameSync });
setInterval(() => {}, 1_000);
`);
  chmodSync(executable, 0o755);
  return { executable, pidFile };
}

function writeIgnoringFixture(root: string): { executable: string; pidFile: string } {
  const executable = join(root, "claude-ignoring-fixture.mjs");
  const pidFile = join(root, "ignoring-fixture.pid");
  writeFileSync(executable, `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const publishPidMarker = ${embeddedPidMarkerWriter()};
process.on("SIGTERM", () => {});
publishPidMarker(${JSON.stringify(pidFile)}, process.pid, { writeFileSync, renameSync });
setInterval(() => {}, 1_000);
`);
  chmodSync(executable, 0o755);
  return { executable, pidFile };
}

/** Runner script driving the REAL runClaudeCli() with NO `createServerLink`
 *  override -- it falls back to `runClaudeCli`'s own default, the REAL
 *  `ServerLink` from `@kaoiro/wrapper-core`, pointed at the Phoenix-loopback
 *  peer via `server_url` (issue #391 round2 K5). Only the `claude`
 *  executable is substituted, via the existing `createHost` seam. No
 *  `process.exit()` call anywhere in this file. If the SDK/CLI/link clean
 *  up every timer and handle, Node's event loop empties on its own and the
 *  process exits with code 0 by itself; if anything leaks, this script
 *  hangs and the test's own timeout catches it. It also publishes its own
 *  PID, so the test can stop and signal the process that owns SIGTERM whatever
 *  the spawn command is. */
function writeRunnerScript(
  root: string,
  fixtureExecutablePathEnvVar: string,
  wireUrl: string,
  runnerPidFile: string,
): string {
  const script = join(root, "runner.mts");
  writeFileSync(
    script,
    `import { renameSync, writeFileSync } from "node:fs";
import { runClaudeCli } from ${JSON.stringify(cliSrcPath)};
import { AgentHost } from ${JSON.stringify(hostSrcPath)};
const publishPidMarker = ${embeddedPidMarkerWriter()};
publishPidMarker(${JSON.stringify(runnerPidFile)}, process.pid, { writeFileSync, renameSync });

const executable = process.env[${JSON.stringify(fixtureExecutablePathEnvVar)}];
const config = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: ${JSON.stringify(wireUrl)},
};

await runClaudeCli({
  parseCliArgs: () => ({ configPath: "test", prompt: "first instruction", resume: undefined }),
  loadConfig: () => config,
  createHost: (cfg, options) =>
    new AgentHost(cfg, {
      ...options,
      queryOptions: { ...options.queryOptions, pathToClaudeCodeExecutable: executable },
    }),
});
`,
  );
  return script;
}

describe.skipIf(!isLinux)("Claude CLI process actually exits after SIGTERM, no process.exit() (issue #391 M2, Linux-only)", () => {
  it("the spawned wrapper process exits with code 0, within the runner's reset grace, and reports disconnect_intent to the real link", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-claude-cli-m2-"));
    const { executable: fixtureExecutable, pidFile: fixturePidFile } = writeFixture(root);
    const envVar = "KAOIRO_TEST_FIXTURE_CLAUDE_EXECUTABLE";
    const wire = await phoenixLoopback();
    const runnerPidFile = join(root, "runner.pid");
    const runnerScript = writeRunnerScript(root, envVar, wire.url, runnerPidFile);
    const child = spawn(process.execPath, ["--import", tsxEsmUrl, runnerScript], {
      env: { ...process.env, CODEX_HOME: undefined, [envVar]: fixtureExecutable },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let fixturePid: number | undefined;
    try {
      // host.run() -- and so the fixture `claude` spawn -- only starts once
      // the real link's join round-trip resolves and delivers the persona
      // prompt (see `onPersonaPrompt` in cli.ts): join, THEN push, THEN wait
      // for the fixture pid, in that order. That wait is the readiness gate:
      // cli.ts installs its SIGTERM handler before host.run(), and the fixture
      // writes its marker only after the SDK query has spawned it. A SIGTERM
      // sent before the handler is installed takes the default disposition
      // and ends the process without code 0 (verified: 143 under the tsx CLI,
      // a signal exit under plain node), so the wait must stay.
      await waitFor(() => wire.joins >= 1, 15_000);
      wire.push("persona_prompt", { prompt: "system prompt" });
      fixturePid = await readPidMarker(fixturePidFile, 15_000);
      expect(isAlive(fixturePid)).toBe(true);
      expect(child.exitCode).toBeNull();
      const runnerPid = await readPidMarker(runnerPidFile, 15_000);

      const t0 = performance.now();
      // Injected load (the regression control): the process that owns SIGTERM
      // is stopped for 300 ms right after the signal, so its loop cannot answer
      // a relay in time. With the direct spawn it still exits 0 once resumed.
      const resumed = pauseFor(runnerPid, 300);
      // A real OS signal to a real separate process -- not process.emit().
      child.kill("SIGTERM");
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("wrapper process did not exit within 8000ms")), 8_000);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, elapsedMs: performance.now() - t0 });
          });
        },
      );
      await resumed;
      // code === 0 is the actual discriminator here: the process ended by
      // its own event loop emptying, not an explicit process.exit() racing
      // teardown. `signal` is not evidence here (issue #391 round2 nit).
      // The 143 that the tsx CLI produced for this test has two sources, both
      // in tsx itself, not in the wrapper. (1) A SIGTERM before the handler
      // exists: tsx's child-side hidden handler exits 128+15 when no app
      // listener is present. (2) A late child: the tsx parent waits 30 ms for
      // the child's signal report, resends SIGTERM, waits 30 ms more, then
      // SIGKILLs the child and exits 128+15 whatever the child's own exit
      // code would have been. Case (2) is what the injected pause above
      // reproduces. Assert code first so a future regression's failure message
      // leads with the discriminator that caught it.
      expect(outcome.code, `stderr: ${stderr}`).toBe(0);
      expect(outcome.signal, `stderr: ${stderr}`).toBeNull();
      expect(outcome.elapsedMs).toBeLessThan(5_000);
      await waitFor(() => !isAlive(fixturePid!), 2_000);
      // The real link's own teardown ran to completion (issue #391 round2
      // K5): cli.ts's finally block calls reportDisconnectIntent() after
      // close() settles host.run()'s promise, which the real ServerLink
      // pushes onto the wire -- not just the SDK child dying.
      expect(wire.received.map((m) => m.event)).toContain("disconnect_intent");
    } finally {
      forceKill(fixturePid);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await wire.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 20_000);

  it("keeps the wrapper alive until its stubborn direct child is killed before runner reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-claude-cli-401-"));
    const { executable, pidFile } = writeIgnoringFixture(root);
    const envVar = "KAOIRO_TEST_FIXTURE_CLAUDE_EXECUTABLE";
    const wire = await phoenixLoopback();
    const runnerPidFile = join(root, "runner.pid");
    const runnerScript = writeRunnerScript(root, envVar, wire.url, runnerPidFile);
    const child = spawn(process.execPath, ["--import", tsxEsmUrl, runnerScript], {
      env: { ...process.env, CODEX_HOME: undefined, [envVar]: executable },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    let fixturePid: number | undefined;
    try {
      // Same readiness gate as the first test: the fixture pid exists only
      // after cli.ts has installed its SIGTERM handler.
      await waitFor(() => wire.joins >= 1, 15_000);
      wire.push("persona_prompt", { prompt: "system prompt" });
      fixturePid = await readPidMarker(pidFile, 15_000);
      expect(isAlive(fixturePid)).toBe(true);
      const runnerPid = await readPidMarker(runnerPidFile, 15_000);

      const t0 = performance.now();
      // Injected load, as in the first test: 300 ms of pause on the process
      // that owns SIGTERM. The pause adds to elapsedMs, and the bounds below
      // leave room for it.
      const resumed = pauseFor(runnerPid, 300);
      child.kill("SIGTERM");
      const outcome = await new Promise<{ code: number | null; elapsedMs: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`wrapper still alive: ${stderr}`)), 8_000);
        child.once("exit", (code) => {
          clearTimeout(timeout);
          resolve({ code, elapsedMs: performance.now() - t0 });
        });
      });
      await resumed;
      expect(outcome.code, `stderr: ${stderr}`).toBe(0);
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(3_500);
      expect(outcome.elapsedMs).toBeLessThan(5_000);
      await waitFor(() => !isAlive(fixturePid!), 1_000);
      expect(wire.received.map((m) => m.event)).toContain("disconnect_intent");
    } finally {
      forceKill(fixturePid);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await wire.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 20_000);
});

describe("PID signal helpers", () => {
  it("rejects invalid observed PIDs before either signal backend is called", () => {
    const calls: Array<[number, Signal]> = [];
    const fakeSignal: SignalBackend = (pid, signal) => { calls.push([pid, signal]); };
    for (const invalid of ["", "  ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => isAlive(invalid, fakeSignal)).toThrow(RangeError);
      expect(() => forceKill(invalid, fakeSignal)).toThrow(RangeError);
      expect(calls).toEqual([]);
    }
    expect(isAlive(42, fakeSignal)).toBe(true);
    forceKill(42, fakeSignal);
    expect(calls).toEqual([[42, 0], [42, "SIGKILL"]]);
    expect(() => forceKill(undefined, fakeSignal)).not.toThrow();
    expect(calls).toHaveLength(2);
  });
});
