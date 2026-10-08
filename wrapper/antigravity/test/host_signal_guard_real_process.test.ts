import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type WrapperConfig } from "@kaoiro/agent-common";
import { requirePositiveSafePid } from "@kaoiro/wrapper-core";
import { embeddedPidMarkerWriter, readPidMarker } from "../../core/test/pid_marker.js";
import { AntigravityHost } from "../src/host.js";

const isLinux = process.platform === "linux";

function config(executable: string, timeoutMs: number): WrapperConfig {
  return {
    agent_id: "signal-guard.test",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: "ws://localhost:4000/wrapper",
    antigravity_cli_path: executable,
    antigravity_probe_timeout_ms: timeoutMs,
  };
}

function writeProbeExecutable(root: string, hangModels: boolean): { executable: string; modelsPid: string; modelsExited: string; gatePid: string; gateExited: string } {
  const executable = join(root, "agy-probe-fixture.mjs");
  const modelsPid = join(root, "models.pid");
  const modelsExited = join(root, "models.exited");
  const gatePid = join(root, "gate.pid");
  const gateExited = join(root, "gate.exited");
  writeFileSync(executable, `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const publishPidMarker = ${embeddedPidMarkerWriter()};
const args = process.argv.slice(2);
const isModels = args[0] === "models";
const pidFile = isModels ? ${JSON.stringify(modelsPid)} : ${JSON.stringify(gatePid)};
const exitFile = isModels ? ${JSON.stringify(modelsExited)} : ${JSON.stringify(gateExited)};
process.on("SIGTERM", () => {
  publishPidMarker(exitFile, process.pid, { writeFileSync, renameSync });
  process.exit(0);
});
publishPidMarker(pidFile, process.pid, { writeFileSync, renameSync });
if (isModels && ${hangModels ? "true" : "false"}) {
  setInterval(() => {}, 1000);
} else if (isModels) {
  process.stdout.write("fixture-model\\tFixture Model\\n");
  process.exit(0);
} else {
  setInterval(() => {}, 1000);
}
`);
  chmodSync(executable, 0o755);
  return { executable, modelsPid, modelsExited, gatePid, gateExited };
}

async function readPid(path: string, timeoutMs = 3_000): Promise<number> {
  const pid = await readPidMarker(path, timeoutMs);
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) throw new Error(`unsafe fixture PID in ${path}`);
  return pid;
}

type Signal = 0 | NodeJS.Signals;
type SignalBackend = (pid: number, signal: Signal) => unknown;

function stopOwnPid(rawPid: unknown | undefined, signal: SignalBackend = (pid, value) => process.kill(pid, value)): void {
  if (rawPid === undefined) return;
  const pid = requirePositiveSafePid(rawPid);
  if (pid < 2 || pid === process.pid) throw new Error("unsafe fixture PID");
  try {
    signal(pid, 0);
  } catch {
    return;
  }
  signal(pid, "SIGKILL");
}

async function stopOwnChild(path: string, signal: SignalBackend = (pid, value) => process.kill(pid, value)): Promise<void> {
  if (!existsSync(path)) return;
  stopOwnPid(await readPid(path), signal);
}

describe.skipIf(!isLinux)("AntigravityHost default probe signal guard", () => {
  it("terminates the real models probe on timeout with no process or signal injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-signal-test-models-"));
    const fixture = writeProbeExecutable(root, true);
    const cfg = config(fixture.executable, 1_000);
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
    });
    try {
      const modelsPid = await readPid(fixture.modelsPid);
      const exitedPid = await readPid(fixture.modelsExited);
      expect(exitedPid).toBe(modelsPid);
    } finally {
      host.close();
      await stopOwnChild(fixture.modelsPid);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("terminates the real gate-registration probe on timeout with no process or signal injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-signal-test-gate-timeout-"));
    const fixture = writeProbeExecutable(root, false);
    const cfg = config(fixture.executable, 1_000);
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
    });
    const send = host.send("start the gate probe");
    try {
      const gatePid = await readPid(fixture.gatePid);
      const exitedPid = await readPid(fixture.gateExited);
      expect(exitedPid).toBe(gatePid);
      await send;
    } finally {
      host.close();
      await stopOwnChild(fixture.modelsPid);
      await stopOwnChild(fixture.gatePid);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["close", "interrupt"] as const)("cancels and terminates a real gate probe when the host receives %s", async (reason) => {
    const root = mkdtempSync(join(tmpdir(), `kaoiro-signal-test-gate-${reason}-`));
    const fixture = writeProbeExecutable(root, false);
    const cfg = config(fixture.executable, 15_000);
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
    });
    const send = host.send("start the gate probe");
    try {
      const gatePid = await readPid(fixture.gatePid);
      if (reason === "close") host.close();
      else await host.interrupt();
      expect(await readPid(fixture.gateExited)).toBe(gatePid);
      await send;
    } finally {
      host.close();
      await stopOwnChild(fixture.modelsPid);
      await stopOwnChild(fixture.gatePid);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("PID signal helper", () => {
  it("rejects unsafe PIDs before signaling and preserves init/self exclusions", () => {
    const calls: Array<[number, Signal]> = [];
    const fakeSignal: SignalBackend = (pid, signal) => { calls.push([pid, signal]); };
    for (const invalid of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", 0, -1, 1.5, Number.NaN]) {
      expect(() => stopOwnPid(invalid, fakeSignal)).toThrow(RangeError);
      expect(calls).toEqual([]);
    }
    expect(() => stopOwnPid(1, fakeSignal)).toThrow("unsafe fixture PID");
    expect(() => stopOwnPid(process.pid, fakeSignal)).toThrow("unsafe fixture PID");
    expect(calls).toEqual([]);
    stopOwnPid(42, fakeSignal);
    expect(calls).toEqual([[42, 0], [42, "SIGKILL"]]);
  });
});
