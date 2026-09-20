// issue #379 M1: without a handler, Node's default SIGTERM behavior kills
// this process immediately (no close(), no group signal, no escalation).
// This test proves the registered handler's FULL effect end to end: SIGTERM
// -> host.close() -> the real agy subtree (leader + grandchild) actually
// terminates, and `runAntigravityCli()`'s own async lifecycle winds down
// cleanly afterward (the in-process analog of "the wrapper process exits").
//
// `process.emit("SIGTERM")` (synthetic, in-process) stands in for a real OS
// signal: this repo has no existing fake-server harness for spawning the
// real CLI as its own OS process (that would need a Phoenix-channel-
// compatible WS stub), and `runAntigravityCli`'s own dependency injection
// (`createServerLink`, `onHostCreated`) already lets a test drive the REAL
// production code path without one -- the same pattern
// `tool_timeout_composition.test.ts` uses. `process.emit` invokes the
// registered listener directly (no OS default-action involved), so it does
// not re-prove "registering a listener suppresses Node's default kill"
// (well-established Node behavior, not this repo's code) but DOES prove
// everything this repo's code is responsible for: the handler exists, calls
// close(), and close() actually cleans up a real subtree.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";

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

/** Real "agy": spawns a real grandchild that ignores SIGTERM, writes both
 *  pids once the grandchild's own SIGTERM handler is registered (avoiding
 *  the same startup race `subtree_termination_real_process.test.ts` guards
 *  against), and streams ACTIVE forever so the turn stays open. */
function writeFixture(root: string): {
  executable: string;
  selfPidFile: string;
  grandchildPidFile: string;
  grandchildReadyFile: string;
} {
  const executable = join(root, "agy-fixture.mjs");
  const selfPidFile = join(root, "self.pid");
  const grandchildPidFile = join(root, "grandchild.pid");
  const grandchildReadyFile = join(root, "grandchild.ready");
  const grandchildScript = join(root, "grandchild.mjs");
  writeFileSync(grandchildScript, `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(grandchildReadyFile)}, "");
setInterval(() => {}, 1_000);
`);
  chmodSync(grandchildScript, 0o755);
  const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
  writeFileSync(executable, `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  line({ event: "init", conversation_id: "cid-cli-sigterm", init: { tools: [] } });
  const grandchild = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));
  writeFileSync(${JSON.stringify(selfPidFile)}, String(process.pid));
  // Ignores SIGTERM itself too, so only the grace-bounded SIGKILL ends it.
  process.on("SIGTERM", () => {});
  setInterval(() => line({ event: "step_update", step_update: { conversation_id: "cid-cli-sigterm", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "." } }), 50);
} else {
  process.exitCode = 2;
}
`);
  chmodSync(executable, 0o755);
  return { executable, selfPidFile, grandchildPidFile, grandchildReadyFile };
}

function inbound(deliverySeq: number, body: string): Envelope {
  return {
    version: "0",
    agent_id: "peer.agent",
    persona: { id: "peer", name: "Peer", sprite_set: "peer" },
    display_name: "Peer",
    ts: "2026-09-21T00:00:00Z",
    type: "inter_agent_message",
    state: "thinking",
    payload: {
      to: config.agent_id,
      conversation_id: `c-${deliverySeq}`,
      turn_number: 1,
      kind: "request",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
    delivery_seq: deliverySeq,
  } as unknown as Envelope;
}

describe.skipIf(!isLinux)("Antigravity CLI SIGTERM subtree termination (issue #379 M1, Linux-only)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("SIGTERM triggers close() and terminates the real subtree instead of Node's default immediate death", async () => {
    // The Host's abortGraceMs rides the CLI's resolved TurnWatchdog abort
    // grace (issue #379 wiring); shorten it so this test does not wait out
    // the 60s production default.
    vi.stubEnv("KAOIRO_ANTIGRAVITY_TURN_WATCHDOG_ABORT_GRACE_MS", "300");
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-cli-sigterm-"));
    const { executable, selfPidFile, grandchildPidFile, grandchildReadyFile } = writeFixture(root);
    const configPath = join(root, "wrapper.config.json");
    writeFileSync(configPath, JSON.stringify({
      ...config,
      antigravity_cli_path: executable,
      antigravity_probe_timeout_ms: 45_000,
    }));
    let selfPid: number | undefined;
    let grandchildPid: number | undefined;
    let options!: Record<string, any>;
    const run = runAntigravityCli({
      parseCliArgs: () => ({ configPath, prompt: undefined, resume: undefined }),
      probeSshAgentIdentities: async () => "unknown",
      onHostCreated: () => {
        queueMicrotask(() => {
          void (options.onInterAgentMessage as (envelope: Envelope) => Promise<void>)(
            inbound(1, "run the fixture"),
          );
        });
      },
      createServerLink: (_url, _agentId, createdOptions) => {
        options = createdOptions as unknown as Record<string, any>;
        queueMicrotask(() => {
          options.onPersonaPrompt("persona");
          options.onInterAgentDeliveryStatus({ acked_seq: 0 });
        });
        return {
          close: () => {},
          setSessionId: () => {},
          acknowledgeInterAgentDelivery: () => {},
          send: () => {},
        } as never;
      },
    });
    try {
      await waitFor(() => existsSync(selfPidFile), 5_000);
      await waitFor(() => existsSync(grandchildPidFile), 5_000);
      await waitFor(() => existsSync(grandchildReadyFile), 5_000);
      selfPid = Number(readFileSync(selfPidFile, "utf8").trim());
      grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      expect(isAlive(selfPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      // The SIGTERM handler this test exists to cover is registered on the
      // real `process` object by `runAntigravityCli` itself -- fire it the
      // same way the OS would deliver the signal, in-process (see file
      // header for why this is `emit`, not a real `process.kill`).
      process.emit("SIGTERM" as never);

      // Both the fixture and its grandchild ignore SIGTERM, so the 300ms
      // group SIGKILL escalation must eventually reach both.
      await waitFor(() => !isAlive(selfPid!) && !isAlive(grandchildPid!), 5_000);
      // The CLI's own async lifecycle (host.run(), the outer finally, link
      // teardown) must complete on its own -- the in-process analog of "the
      // real process exits naturally, no process.exit() needed" (M1 point 3).
      await run;
    } finally {
      forceKill(selfPid);
      forceKill(grandchildPid);
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);
});
