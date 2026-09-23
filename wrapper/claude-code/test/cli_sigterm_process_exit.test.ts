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
// This test spawns the REAL wrapper CLI as its own OS process (via tsx,
// since the package ships TypeScript sources) with a REAL `ServerLink` (no
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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

const isLinux = process.platform === "linux";
const testDir = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(testDir, "..", "node_modules", ".bin", "tsx");
const cliSrcPath = join(testDir, "..", "src", "cli.ts");
const hostSrcPath = join(testDir, "..", "src", "host.ts");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone -- fine.
  }
}

/** SIGTERM-cooperative fixture, same shape as the one in
 *  cli_sigterm_abort_real_process.test.ts's grace-path pin. */
function writeFixture(root: string): { executable: string; pidFile: string } {
  const executable = join(root, "claude-fixture.mjs");
  const pidFile = join(root, "fixture.pid");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
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
 *  hangs and the test's own timeout catches it. */
function writeRunnerScript(
  root: string,
  fixtureExecutablePathEnvVar: string,
  wireUrl: string,
): string {
  const script = join(root, "runner.mts");
  writeFileSync(
    script,
    `import { runClaudeCli } from ${JSON.stringify(cliSrcPath)};
import { AgentHost } from ${JSON.stringify(hostSrcPath)};

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
    const runnerScript = writeRunnerScript(root, envVar, wire.url);
    const child = spawn(tsxBin, [runnerScript], {
      env: { ...process.env, [envVar]: fixtureExecutable },
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
      // for the fixture pid, in that order.
      await waitFor(() => wire.joins >= 1, 15_000);
      wire.push("persona_prompt", { prompt: "system prompt" });
      await waitFor(() => existsSync(fixturePidFile), 15_000);
      fixturePid = Number(readFileSync(fixturePidFile, "utf8").trim());
      expect(isAlive(fixturePid)).toBe(true);
      expect(child.exitCode).toBeNull();

      const t0 = performance.now();
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
      // code === 0 is the actual discriminator here: the process ended by
      // its own event loop emptying, not an explicit process.exit() racing
      // teardown. `signal` is NOT reliable evidence through tsx (issue #391
      // round2 nit) -- a mutation that removed the SIGTERM handler entirely
      // was observed to exit as {code: 143, signal: null}, because tsx's
      // loader relays and swallows the terminating signal rather than
      // reporting it on `child_process`'s own `signal` field. Assert code
      // first so a future regression's failure message leads with the
      // discriminator that actually caught it.
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
});
