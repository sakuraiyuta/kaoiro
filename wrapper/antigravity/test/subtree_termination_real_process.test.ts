// @vitest-environment node
// issue #379: real-OS-process pins. Everything else in this package is
// unit-tested against fake children/timers; these specifically exercise
// `#defaultSpawn`'s `detached: true` + `signalSubtree`'s `process.kill(-pid,
// signal)` against REAL processes, because that boundary cannot be faked --
// a fake child has no real process group to prove a signal reached.
//
// Shared-host safety: every pid this test creates is tracked and force-
// killed by EXACT pid in `finally` (never a pattern-based kill). Linux-only:
// `process.kill(-pid, signal)` process-group semantics are a POSIX/Linux
// guarantee here (issue #379); skip elsewhere with the reason in the
// describe name.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PermissionBroker, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, type AntigravityHostOptions } from "../src/host.js";

const isLinux = process.platform === "linux";

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
    ...overrides,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(() => existsSync(path), 2_000);
}

function readPidFile(path: string): number {
  return Number(readFileSync(path, "utf8").trim());
}

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone -- fine.
  }
}

/** A fixture "agy" that spawns a real grandchild which always ignores
 *  SIGTERM, writes both pids to files as soon as it is ready, then streams
 *  ACTIVE progress forever (never resolves) so the turn stays open until
 *  interrupted. `ignoreOwnSigterm` controls whether the LEADER itself also
 *  ignores SIGTERM. */
function writeFixture(
  root: string,
  options: { ignoreOwnSigterm: boolean },
): { executable: string; selfPidFile: string; grandchildPidFile: string; grandchildReadyFile: string } {
  const executable = join(root, "agy-fixture.mjs");
  const selfPidFile = join(root, "self.pid");
  const grandchildPidFile = join(root, "grandchild.pid");
  const grandchildReadyFile = join(root, "grandchild.ready");
  // The grandchild script writes its OWN ready marker right after
  // registering the SIGTERM handler -- registering that handler is not
  // instantaneous with the OS-level fork/exec `spawn()` returns from, so
  // the test must wait for this file (not just the pid file) before
  // sending SIGTERM, or the signal can race a not-yet-registered handler
  // and kill the grandchild via Node's default behavior instead of
  // exercising the ignore-SIGTERM path this fixture means to test.
  const grandchildScript = join(root, "grandchild.mjs");
  writeFileSync(grandchildScript, `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(grandchildReadyFile)}, "");
setInterval(() => {}, 1_000);
`);
  chmodSync(grandchildScript, 0o755);
  writeFileSync(executable, `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "--print") {
  line({ event: "init", conversation_id: "cid-subtree", init: { tools: ["run_command"] } });
  const grandchild = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));
  writeFileSync(${JSON.stringify(selfPidFile)}, String(process.pid));
  ${options.ignoreOwnSigterm ? "process.on('SIGTERM', () => {});" : ""}
  // issue #379 pin 5 / #377: a run_command tool step that stays ACTIVE
  // forever, exactly like a promoted background task whose completion the
  // real agy stream waits on -- the grandchild above stands in for that
  // background task's own process tree.
  setInterval(() => line({ event: "step_update", step_update: { conversation_id: "cid-subtree", step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 1000" } } } }), 50);
} else {
  process.exitCode = 2;
}
`);
  chmodSync(executable, 0o755);
  return { executable, selfPidFile, grandchildPidFile, grandchildReadyFile };
}

function hostHarness(
  agyPath: string,
  options: { abortGraceMs?: number; spawn?: AntigravityHostOptions["spawn"] } = {},
) {
  const cfg = config();
  const host = new AntigravityHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
    onState: () => {},
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => true, // gate self-verification (F4b) is out of scope here
    agyPath,
    ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  } satisfies AntigravityHostOptions);
  return { host };
}

describe.skipIf(!isLinux)("Antigravity subtree termination against real processes (issue #379, Linux-only)", () => {
  it("interrupt() terminates a real parent + grandchild that both ignore SIGTERM, as a group, after grace, during a promoted run_command background task (pins 1 + 5)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-subtree-"));
    const { executable, selfPidFile, grandchildPidFile, grandchildReadyFile } =
      writeFixture(root, { ignoreOwnSigterm: true });
    const { host } = hostHarness(executable, { abortGraceMs: 300 });
    let selfPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      void host.send("run the fixture");
      await waitForFile(selfPidFile);
      await waitForFile(grandchildPidFile);
      await waitForFile(grandchildReadyFile);
      selfPid = readPidFile(selfPidFile);
      grandchildPid = readPidFile(grandchildPidFile);
      expect(isAlive(selfPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      await host.interrupt();
      // Both ignore SIGTERM, so nothing should die before the grace elapses.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isAlive(selfPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);
      // After the grace, the group SIGKILL must reach both.
      await waitFor(() => !isAlive(selfPid!) && !isAlive(grandchildPid!), 2_000);
    } finally {
      forceKill(selfPid);
      forceKill(grandchildPid);
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("negative control: WITHOUT a detached spawn, the grandchild survives the leader's death (proves the assertion depends on the process group)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-subtree-negctl-"));
    const { executable, selfPidFile, grandchildPidFile, grandchildReadyFile } =
      writeFixture(root, { ignoreOwnSigterm: false });
    // Pre-#379 behavior: no `detached`, so the fixture shares THIS worker
    // process's group, and `signalSubtree`'s pid-based group path is never
    // reachable through this spawn -- it exercises the single-process
    // fallback instead, which is the actual old behavior this negative
    // control targets.
    const { host } = hostHarness(executable, {
      abortGraceMs: 300,
      spawn: (command, args, opts) =>
        spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }) as never,
    });
    let selfPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      void host.send("run the fixture");
      await waitForFile(selfPidFile);
      await waitForFile(grandchildPidFile);
      await waitForFile(grandchildReadyFile);
      selfPid = readPidFile(selfPidFile);
      grandchildPid = readPidFile(grandchildPidFile);

      await host.interrupt();
      // The leader accepts a plain SIGTERM here (ignoreOwnSigterm: false),
      // so it exits promptly without ever needing the SIGKILL escalation.
      await waitFor(() => !isAlive(selfPid!), 2_000);
      // The grandchild was never in a group `signalSubtree` could target
      // (no detached spawn) and was never itself signalled -- it survives.
      expect(isAlive(grandchildPid)).toBe(true);
    } finally {
      forceKill(selfPid);
      forceKill(grandchildPid);
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("a child that exits on SIGTERM never receives a SIGKILL (pin 2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-subtree-clean-"));
    const executable = join(root, "agy-fixture-clean.mjs");
    const readyFile = join(root, "ready");
    writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "--print") {
  line({ event: "init", conversation_id: "cid-clean", init: { tools: [] } });
  writeFileSync(${JSON.stringify(readyFile)}, "");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => line({ event: "step_update", step_update: { conversation_id: "cid-clean", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "." } }), 50);
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    const { host } = hostHarness(executable, { abortGraceMs: 300 });
    // SIGKILL is uncatchable, so the fixture cannot self-report receiving
    // one; a passthrough spy on the real `process.kill` is the only vantage
    // point that can observe whether host.ts's `exit`/`close` cancellation
    // wiring actually suppressed the escalation against a REAL child's real
    // exit timing (the timer math itself is already unit-tested against
    // fake timers in subtree_termination.test.ts).
    const killSpy = vi.spyOn(process, "kill");
    try {
      const sent = host.send("run the fixture");
      await waitForFile(readyFile);
      await host.interrupt();
      await sent;
      // Give the (should-not-fire) escalation timer a chance to prove it
      // stayed silent -- well past the 300ms grace.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const sigkillCalls = killSpy.mock.calls.filter((call) => call[1] === "SIGKILL");
      expect(sigkillCalls).toEqual([]);
    } finally {
      killSpy.mockRestore();
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 10_000);
});
