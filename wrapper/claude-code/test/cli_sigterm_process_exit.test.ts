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
// since the package ships TypeScript sources) with a stub ServerLink (no
// network dependency) and a fixture `claude` binary that honors SIGTERM,
// sends that process a real OS SIGTERM, and asserts on the child_process
// `exit` event: `signal === null` (Node's own SIGTERM default action never
// fired -- the registered handler ran instead) and `code === 0` (the
// process ended by its event loop emptying, not by an explicit
// `process.exit()` call racing teardown), within the runner's reset grace.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

/** Runner script driving the REAL runClaudeCli() with a stub ServerLink
 *  (no network) and the fixture claude executable, then does nothing else
 *  -- no process.exit() call anywhere in this file. If the SDK/CLI clean
 *  up every timer and handle, Node's event loop empties on its own and the
 *  process exits with code 0 by itself; if anything leaks, this script
 *  hangs and the test's own timeout catches it. */
function writeRunnerScript(root: string, fixtureExecutablePathEnvVar: string): string {
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
  server_url: "ws://unused",
};

await runClaudeCli({
  parseCliArgs: () => ({ configPath: "test", prompt: "first instruction", resume: undefined }),
  loadConfig: () => config,
  createServerLink: (_url, _agentId, options) => {
    queueMicrotask(() => {
      options.onPersonaPrompt?.("system prompt");
      options.onInterAgentDeliveryStatus?.({ issued_seq: 0, acked_seq: 0 });
    });
    return {
      close: () => {},
      currentSessionId: () => null,
      setSessionId: () => {},
      send: () => {},
      reportSessionLifecycle: () => {},
      acknowledgeInterAgentDelivery: () => {},
      flushInterAgentRetirements: async () => {},
      reportDisconnectIntent: async () => {},
    };
  },
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
  it("the spawned wrapper process exits with code 0 and no signal, within the runner's reset grace", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-claude-cli-m2-"));
    const { executable: fixtureExecutable, pidFile: fixturePidFile } = writeFixture(root);
    const envVar = "KAOIRO_TEST_FIXTURE_CLAUDE_EXECUTABLE";
    const runnerScript = writeRunnerScript(root, envVar);
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
      await waitFor(() => existsSync(fixturePidFile), 15_000);
      fixturePid = Number(readFileSync(fixturePidFile, "utf8").trim());
      expect(isAlive(fixturePid)).toBe(true);
      expect(child.exitCode).toBeNull();

      const t0 = Date.now();
      // A real OS signal to a real separate process -- not process.emit().
      child.kill("SIGTERM");
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("wrapper process did not exit within 8000ms")), 8_000);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, elapsedMs: Date.now() - t0 });
          });
        },
      );
      // signal === null means Node's own default SIGTERM action (which
      // would report the terminating signal here) never fired -- the
      // registered handler ran and the process ended through its own
      // event loop emptying instead.
      expect(outcome.signal, `stderr: ${stderr}`).toBeNull();
      expect(outcome.code, `stderr: ${stderr}`).toBe(0);
      expect(outcome.elapsedMs).toBeLessThan(5_000);
      await waitFor(() => !isAlive(fixturePid!), 2_000);
    } finally {
      forceKill(fixturePid);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  }, 20_000);
});
