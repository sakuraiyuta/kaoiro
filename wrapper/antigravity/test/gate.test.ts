import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "@kaoiro/agent-common";
import { AntigravityGate, type AntigravityLaunchConfig } from "../src/gate.js";

function config(overrides: Partial<AntigravityLaunchConfig> = {}): AntigravityLaunchConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    display_name: "もも",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    approval: "on-request",
    network_access: false,
    ...overrides,
  };
}

function makeGate(overrides: Partial<AntigravityLaunchConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agy-gate-test-"));
  const cwd = join(root, "workspace");
  const customizationDir = join(root, "custom");
  mkdirSync(cwd);
  mkdirSync(customizationDir);
  const bridgePath = join(root, "bridge.js");
  writeFileSync(bridgePath, "");
  const warnings: string[] = [];
  const gate = new AntigravityGate({
    config: config(overrides),
    cwd,
    customizationDir,
    nodePath: process.execPath,
    bridgePath,
    toolNames: () => new Set(["whoami"]),
    broker: new PermissionBroker({ config: config(overrides), send: () => {} }),
    warn: (message) => warnings.push(message),
  });
  return { gate, root, cwd, customizationDir, bridgePath, warnings };
}

describe("AntigravityGate", () => {
  it("F4の既定セルでread/write/shell/networkを導出する", () => {
    const { gate, root, cwd } = makeGate();
    try {
      expect(gate.evaluate({ name: "view_file", args: {} })).toEqual({ decision: "allow" });
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: join(cwd, "a.txt") } })).toEqual({ decision: "allow" });
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: "pwd", Cwd: cwd } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "search_web", args: { query: "kaoiro" } })).toEqual({ decision: "deny", reason: "kaoiro: network access is disabled" });
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: join(root, "outside.txt") } })).toEqual({ decision: "deny", reason: "kaoiro: write is outside the permitted workspace" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("customization参照は常にdeny、Cwd外shellはaskにする", () => {
    const { gate, root, customizationDir } = makeGate({ approval: "never", network_access: true });
    try {
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: join(customizationDir, "x") } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: "pwd", Cwd: root } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "ask_question", args: {} })).toMatchObject({ decision: "deny" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("F5 bridge auto-allow は字句どおりの正規形だけに限る", () => {
    const { gate, root, cwd, bridgePath } = makeGate();
    try {
      const payload = Buffer.from(JSON.stringify({}), "utf8").toString("base64url");
      const command = `${process.execPath} ${bridgePath} call whoami ${payload}`;
      const args = { CommandLine: command, Cwd: cwd, WaitMsBeforeAsync: 5000 };
      expect(gate.evaluate({ name: "run_command", args })).toEqual({ decision: "allow" });
      for (const injection of ["; id", " && id", " | id", " $(id)", "\necho injected", " extra", ` ${Buffer.from("not-json").toString("base64url")}`]) {
        expect(gate.evaluate({ name: "run_command", args: { ...args, CommandLine: command + injection } })).toEqual({ decision: "ask" });
      }
      expect(gate.evaluate({ name: "run_command", args: { ...args, CommandLine: `${process.execPath} ${bridgePath} call whoami !!!` } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "run_command", args: { ...args, Extra: true } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "run_command", args: { ...args, WaitMsBeforeAsync: 4999 } })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("F4bは実測済みclassのcompleted toolにgate相関を要求する", () => {
    const { gate, root, warnings } = makeGate();
    try {
      expect(gate.observeCompletedTool(2, "run_command")).toBe(false);
      gate.observeGateRequest(2);
      expect(gate.observeCompletedTool(2, "run_command")).toBe(true);
      expect(gate.observeCompletedTool(3, "future_vendor_tool")).toBe(true);
      expect(warnings).toContain("antigravity: unclassified completed tool: future_vendor_tool");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
