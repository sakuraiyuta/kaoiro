// @vitest-environment node
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost } from "../src/host.js";

const isLinux = process.platform === "linux";

function config(): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "p", name: "P", sprite_set: "p" },
    display_name: "P",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
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

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe.skipIf(!isLinux)("real usage probe subprocess termination on host.close() (M4, S2)", () => {
  it("terminates real usage probe child on host.close() with no injected spawn", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "usage-probe-real-"));
    const fixtureBin = join(scratch, "fake-agy.mjs");
    const pidFile = join(scratch, "probe.pid");
    const readyFile = join(scratch, "probe.ready");

    writeFileSync(
      fixtureBin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("gemini-2.5-pro\\tGemini 2.5 Pro\\n");
  process.exit(0);
} else if (args.includes("/usage")) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  writeFileSync(${JSON.stringify(readyFile)}, "");
  // Keep running until killed
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`,
    );
    chmodSync(fixtureBin, 0o755);

    let probePid: number | undefined;
    const cfg = config();
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(),
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      agyPath: fixtureBin,
      customizationBaseDir: scratch,
      runtimeAssetsAvailable: () => true,
      verifyGate: async () => true,
    });

    try {
      // 1. Wait for probe child to spawn and announce its PID
      await waitFor(() => existsSync(readyFile), 3_000);
      probePid = Number(readFileSync(pidFile, "utf8").trim());
      expect(isAlive(probePid)).toBe(true);

      // 2. Close host — must terminate the in-flight probe process
      await host.close();

      // 3. Confirm probe child is dead
      await waitFor(() => !isAlive(probePid!), 3_000);
      expect(isAlive(probePid)).toBe(false);
    } finally {
      forceKill(probePid);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
