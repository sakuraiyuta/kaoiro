import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { createHarnessHost, type HarnessAgy } from "./host_test_harness.js";

function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error("timed out waiting for the harness host"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("shared Antigravity host-test harness", () => {
  it("keeps constructor and first gate-probe lifecycle on fake children", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-harness-marker-"));
    const executable = join(root, "missing-agy");
    const config: WrapperConfig = {
      agent_id: "harness.test",
      persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P",
      server_url: "ws://localhost:4000/wrapper",
      antigravity_cli_path: executable,
    };
    const logs: Envelope[] = [];
    let gateProbeSpawns = 0;
    let modelsProbeSpawns = 0;
    const host = createHarnessHost(config, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config, send: () => {} }),
      onState: () => {},
      onLog: (envelope) => logs.push(envelope),
      runtimeAssetsAvailable: () => true,
      agyPath: executable,
    }, {
      onGateProbeSpawn: () => { gateProbeSpawns += 1; },
      onModelsProbeSpawn: () => { modelsProbeSpawns += 1; },
    });
    try {
      const send = host.send("probe harness defaults");
      await waitFor(() => logs.some((envelope) => envelope.type === "result"));
      expect(logs.at(-1)?.payload).toMatchObject({ error_detail: expect.stringContaining("spawn_failure") });
      await send;
      expect(gateProbeSpawns).toBe(1);
      expect(modelsProbeSpawns).toBe(1);
    } finally {
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses a fake epoch child for the first turn by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-harness-epoch-"));
    const executable = join(root, "agy-marker.mjs");
    const marker = join(root, "was-executed");
    writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));
process.exit(0);
`);
    chmodSync(executable, 0o755);
    const config: WrapperConfig = {
      agent_id: "harness.epoch.test",
      persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P",
      server_url: "ws://localhost:4000/wrapper",
      antigravity_cli_path: executable,
    };
    let child: HarnessAgy | undefined;
    const host = createHarnessHost(config, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config, send: () => {} }),
      onState: () => {},
      runtimeAssetsAvailable: () => true,
      verifyGate: async () => true,
      agyPath: executable,
    }, {
      onAgySpawn: (value) => { child = value; },
    });
    try {
      const send = host.send("exercise the fake epoch");
      await waitFor(() => child !== undefined || existsSync(marker));
      expect(existsSync(marker)).toBe(false);
      expect(child).toBeDefined();
      child!.finish();
      await send;
    } finally {
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps a completed harness turn on the injected fake usage probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-harness-usage-"));
    const executable = join(root, "agy-marker.mjs");
    const usageMarker = join(root, "usage-was-spawned");
    writeFileSync(executable, `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(usageMarker)}, process.argv.slice(2).join(" "));
process.exit(0);
`);
    chmodSync(executable, 0o755);
    const config: WrapperConfig = {
      agent_id: "harness.usage.test",
      persona: { id: "p", name: "P", sprite_set: "p" },
      display_name: "P",
      server_url: "ws://localhost:4000/wrapper",
      antigravity_cli_path: executable,
      model: "gemini-2.5-pro",
    };
    let child: HarnessAgy | undefined;
    let terminalTurnEnded = false;
    let usageProbeSpawns = 0;
    const host = createHarnessHost(config, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config, send: () => {} }),
      onState: () => {},
      onTurnEnd: ({ terminal }) => { terminalTurnEnded ||= terminal; },
      runtimeAssetsAvailable: () => true,
      verifyGate: async () => true,
      agyPath: executable,
      warn: () => {},
    }, {
      onAgySpawn: (value) => { child = value; },
      onUsageProbeSpawn: () => { usageProbeSpawns += 1; },
    });
    try {
      const send = host.send("complete a harness turn");
      await waitFor(() => child !== undefined);
      (child!.stdout as PassThrough).write(`${JSON.stringify({ event: "result", result: { response: "ok" } })}\n`);
      child!.finish();
      await send;
      await waitFor(() => terminalTurnEnded);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(usageMarker)).toBe(false);
      expect(usageProbeSpawns).toBe(1);
    } finally {
      await host.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
