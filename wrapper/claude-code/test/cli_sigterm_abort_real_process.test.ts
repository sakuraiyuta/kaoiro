// issue #391 M1: without a handler, Node's default SIGTERM behavior kills
// this process immediately (no close(), no AbortController.abort(), no SDK
// escalation). This test proves the registered handler's FULL effect
// end to end through the REAL `@anthropic-ai/claude-agent-sdk` (not a fake
// queryFn): SIGTERM -> host.close() -> #abort.abort() -> the SDK's own
// ProcessTransport escalation (stdin EOF already ignored by the fixture,
// then SIGTERM, then SIGKILL) actually terminates a real OS child process
// that ignores both stdin EOF and SIGTERM, and `runClaudeCli()`'s own async
// lifecycle winds down cleanly afterward (no explicit process.exit()).
//
// `process.emit("SIGTERM")` (synthetic, in-process) stands in for a real OS
// signal, mirroring antigravity's `cli_sigterm_subtree_termination.test.ts`
// (issue #379): it invokes the registered listener directly, so it does not
// re-prove "registering a listener suppresses Node's default kill" (settled
// Node behavior) but DOES prove everything this repo's code owns: the
// handler exists, calls close(), close() aborts the AbortController wired
// into Options, and the SDK's real ProcessTransport actually kills the real
// child that never cooperates on its own.
//
// The fixture is spawned via `queryOptions.pathToClaudeCodeExecutable`, the
// SDK's own documented seam for swapping the `claude` binary — this drives
// the real `@anthropic-ai/claude-agent-sdk` code path, not a substitute.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import { AgentHost } from "../src/host.js";

const isLinux = process.platform === "linux";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

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

/** Real "claude" stand-in: ignores stdin (never reads it, so EOF alone
 *  proves nothing) and SIGTERM, writes its own pid once ready, and stays
 *  alive forever. Only the SDK's own SIGKILL escalation (fired by
 *  ProcessTransport.close() after AbortController.abort()) can end it. */
function writeFixture(root: string): { executable: string; pidFile: string } {
  const executable = join(root, "claude-fixture.mjs");
  const pidFile = join(root, "fixture.pid");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1_000);
`);
  chmodSync(executable, 0o755);
  return { executable, pidFile };
}

describe.skipIf(!isLinux)("Claude CLI SIGTERM -> abort() real-process escalation (issue #391 M1, Linux-only)", () => {
  it("SIGTERM triggers close() -> abort() -> the real child is killed (queue empty)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-claude-cli-sigterm-"));
    const { executable, pidFile } = writeFixture(root);
    let fixturePid: number | undefined;
    let linkOptions!: Record<string, any>;
    const run = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "first instruction", resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => {
          linkOptions.onPersonaPrompt?.("system prompt");
          linkOptions.onInterAgentDeliveryStatus?.({ issued_seq: 0, acked_seq: 0 });
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
        } as never;
      },
      createHost: (cfg, options) =>
        new AgentHost(cfg, {
          ...options,
          queryOptions: {
            ...options.queryOptions,
            pathToClaudeCodeExecutable: executable,
          },
        }),
    });
    // Observe early failures while assertions are waiting; cleanup below
    // still awaits the original promise and propagates its rejection.
    void run.catch(() => {});
    try {
      await waitFor(() => existsSync(pidFile), 10_000);
      fixturePid = Number(readFileSync(pidFile, "utf8").trim());
      expect(isAlive(fixturePid)).toBe(true);

      // The SIGTERM handler this test exists to cover is registered on the
      // real `process` object by `runClaudeCli` itself -- fire it the same
      // way the OS would deliver the signal, in-process (see file header).
      process.emit("SIGTERM" as never);

      // The fixture ignores both stdin EOF and SIGTERM, so only the SDK's
      // own ~7000ms (2000ms SIGTERM grace + 5000ms SIGKILL grace,
      // `ProcessTransport.close()`, both `.unref()`'d) escalation can end
      // it. Bound well above that.
      await waitFor(() => !isAlive(fixturePid!), 10_000);
      // The CLI's own async lifecycle (host.run(), the outer finally, link
      // teardown) must complete on its own -- no process.exit() needed.
      await run;
    } finally {
      forceKill(fixturePid);
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("SIGTERM still kills the real child when a second turn is queued (issue #391 S4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-claude-cli-sigterm-queued-"));
    const { executable, pidFile } = writeFixture(root);
    let fixturePid: number | undefined;
    let host!: AgentHost;
    const run = runClaudeCli({
      parseCliArgs: () => ({ configPath: "test", prompt: "first instruction", resume: undefined }),
      loadConfig: () => ({ ...config }),
      createServerLink: (_url, _agentId, options) => {
        const linkOptions = options as unknown as Record<string, any>;
        queueMicrotask(() => {
          linkOptions.onPersonaPrompt?.("system prompt");
          linkOptions.onInterAgentDeliveryStatus?.({ issued_seq: 0, acked_seq: 0 });
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
        } as never;
      },
      createHost: (cfg, options) => {
        host = new AgentHost(cfg, {
          ...options,
          queryOptions: {
            ...options.queryOptions,
            pathToClaudeCodeExecutable: executable,
          },
        });
        return host;
      },
    });
    void run.catch(() => {});
    try {
      await waitFor(() => existsSync(pidFile), 10_000);
      fixturePid = Number(readFileSync(pidFile, "utf8").trim());
      expect(isAlive(fixturePid)).toBe(true);

      // host.ts's close() takes a different branch (does not call
      // #wakeTurnBoundary()) when the queue is non-empty (host.ts:1299).
      // Queue a second turn so this pin exercises that branch too, proving
      // #abort.abort() (unlike the return-path EOF) does not depend on
      // queue state.
      await host.send("second instruction");

      process.emit("SIGTERM" as never);
      await waitFor(() => !isAlive(fixturePid!), 10_000);
      await run;
    } finally {
      forceKill(fixturePid);
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);
});
