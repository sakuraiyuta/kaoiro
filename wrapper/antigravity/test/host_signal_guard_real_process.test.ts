import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type WrapperConfig } from "@kaoiro/agent-common";
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
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const isModels = args[0] === "models";
const pidFile = isModels ? ${JSON.stringify(modelsPid)} : ${JSON.stringify(gatePid)};
const exitFile = isModels ? ${JSON.stringify(modelsExited)} : ${JSON.stringify(gateExited)};
process.on("SIGTERM", () => {
  writeFileSync(exitFile, String(process.pid));
  process.exit(0);
});
writeFileSync(pidFile, String(process.pid));
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

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) throw new Error(`unsafe fixture PID in ${path}`);
  return pid;
}

function stopOwnChild(path: string): void {
  if (!existsSync(path)) return;
  const pid = readPid(path);
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  process.kill(pid, "SIGKILL");
}

describe.skipIf(!isLinux)("AntigravityHost default probe signal guard", () => {
  it("terminates the real models probe on timeout with no process or signal injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-signal-models-"));
    const fixture = writeProbeExecutable(root, true);
    const cfg = config(fixture.executable, 1_000);
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
    });
    try {
      await waitForFile(fixture.modelsPid);
      await waitForFile(fixture.modelsExited);
      expect(readPid(fixture.modelsExited)).toBe(readPid(fixture.modelsPid));
    } finally {
      host.close();
      stopOwnChild(fixture.modelsPid);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("terminates the real gate-registration probe on timeout with no process or signal injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-signal-gate-timeout-"));
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
      await waitForFile(fixture.gatePid);
      await waitForFile(fixture.gateExited);
      expect(readPid(fixture.gateExited)).toBe(readPid(fixture.gatePid));
      await send;
    } finally {
      host.close();
      stopOwnChild(fixture.modelsPid);
      stopOwnChild(fixture.gatePid);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["close", "interrupt"] as const)("cancels and terminates a real gate probe when the host receives %s", async (reason) => {
    const root = mkdtempSync(join(tmpdir(), `kaoiro-agy-signal-gate-${reason}-`));
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
      await waitForFile(fixture.gatePid);
      const gatePid = readPid(fixture.gatePid);
      if (reason === "close") host.close();
      else await host.interrupt();
      await waitForFile(fixture.gateExited);
      expect(readPid(fixture.gateExited)).toBe(gatePid);
      await send;
    } finally {
      host.close();
      stopOwnChild(fixture.modelsPid);
      stopOwnChild(fixture.gatePid);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
