import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { PermissionBroker } from "@kaoiro/agent-common";
import { AntigravityGate, GateServer, type AntigravityLaunchConfig } from "../src/gate.js";

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

  it("F4の9セルをread/write/shell/subagentとnetworkでtable-drivenにpinする", () => {
    const expected: Record<string, Record<"read" | "write" | "shell" | "subagent", "allow" | "ask" | "deny">> = {
      "read-only/untrusted": { read: "allow", write: "deny", shell: "deny", subagent: "deny" },
      "read-only/on-request": { read: "allow", write: "deny", shell: "deny", subagent: "deny" },
      "read-only/never": { read: "allow", write: "deny", shell: "deny", subagent: "deny" },
      "workspace-write/untrusted": { read: "allow", write: "ask", shell: "ask", subagent: "ask" },
      "workspace-write/on-request": { read: "allow", write: "allow", shell: "ask", subagent: "ask" },
      "workspace-write/never": { read: "allow", write: "allow", shell: "allow", subagent: "allow" },
      "danger-full-access/untrusted": { read: "allow", write: "ask", shell: "ask", subagent: "ask" },
      "danger-full-access/on-request": { read: "allow", write: "allow", shell: "ask", subagent: "ask" },
      "danger-full-access/never": { read: "allow", write: "allow", shell: "allow", subagent: "allow" },
    };
    for (const [cell, decisions] of Object.entries(expected)) {
      const [sandbox, approval] = cell.split("/") as [NonNullable<AntigravityLaunchConfig["sandbox"]>, NonNullable<AntigravityLaunchConfig["approval"]>];
      const { gate, root, cwd } = makeGate({ sandbox, approval, network_access: true });
      try {
        expect(gate.evaluate({ name: "view_file", args: {} }).decision, `${cell}:read`).toBe(decisions.read);
        expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: join(cwd, "a.txt") } }).decision, `${cell}:write`).toBe(decisions.write);
        expect(gate.evaluate({ name: "run_command", args: { CommandLine: "pwd", Cwd: cwd } }).decision, `${cell}:shell`).toBe(decisions.shell);
        expect(gate.evaluate({ name: "invoke_subagent", args: {} }).decision, `${cell}:subagent`).toBe(decisions.subagent);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }

    for (const networkAccess of [false, true]) {
      const { gate, root } = makeGate({ sandbox: "workspace-write", approval: "on-request", network_access: networkAccess });
      try {
        expect(gate.evaluate({ name: "search_web", args: { query: "kaoiro" } }).decision, `network=${networkAccess}`).toBe(networkAccess ? "ask" : "deny");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }

    for (const approval of ["untrusted", "on-request", "never"] as const) {
      const { gate, root } = makeGate({ approval, network_access: true });
      try {
        expect(gate.evaluate({ name: "ask_question", args: {} }).decision, `${approval}:internal`).toBe("deny");
        expect(gate.evaluate({ name: "future_vendor_tool", args: {} }).decision, `${approval}:unknown`).toBe(approval === "never" ? "deny" : "ask");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it("customization参照は常にdeny、Cwd外shellはaskにする", () => {
    const { gate, root, customizationDir } = makeGate({ approval: "never", network_access: true });
    try {
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: join(customizationDir, "x") } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: "pwd", Cwd: root } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "ask_question", args: {} })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: "pwd" } })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("F5 bridge auto-allow は字句どおりの正規形だけに限る", () => {
    const { gate, root, cwd, bridgePath } = makeGate();
    try {
      const payload = Buffer.from(JSON.stringify({}), "utf8").toString("base64url");
      const command = `${process.execPath} ${bridgePath} call whoami ${payload}`;
      const args = { CommandLine: command, Cwd: cwd, WaitMsBeforeAsync: 5000 };
      expect(gate.evaluate({ name: "run_command", args })).toEqual({ decision: "allow" });
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: `${process.execPath} ${bridgePath} list`, Cwd: cwd, WaitMsBeforeAsync: 5000 } })).toEqual({ decision: "allow" });
      for (const injection of ["; id", " && id", " | id", " $(id)", "\necho injected", " extra", ` ${Buffer.from("not-json").toString("base64url")}`]) {
        expect(gate.evaluate({ name: "run_command", args: { ...args, CommandLine: command + injection } })).toEqual({ decision: "ask" });
      }
      expect(gate.evaluate({ name: "run_command", args: { ...args, CommandLine: `${process.execPath} ${bridgePath} call whoami !!!` } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "run_command", args: { ...args, Extra: true } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "run_command", args: { ...args, WaitMsBeforeAsync: 4999 } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "run_command", args: { CommandLine: command, WaitMsBeforeAsync: 5000 } })).toEqual({ decision: "ask" });
      expect(gate.evaluate({ name: "run_command", args: { ...args, CommandLine: `${process.execPath} ${bridgePath} call unknown_tool ${payload}` } })).toEqual({ decision: "ask" });
      const nonJson = Buffer.from("not-json", "utf8").toString("base64url");
      expect(gate.evaluate({ name: "run_command", args: { ...args, CommandLine: `${process.execPath} ${bridgePath} call whoami ${nonJson}` } })).toEqual({ decision: "ask" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("writeはtarget schema、全path、symlink祖先をfail-closedにする", () => {
    const { gate, root, cwd, customizationDir } = makeGate();
    try {
      expect(gate.evaluate({ name: "write_to_file", args: {} })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: "\0bad" } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "write_to_file", args: {
        AbsolutePath: join(cwd, "inside.txt"), TargetFile: join(root, "outside.txt"),
      } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "write_to_file", args: {
        TargetFile: join(root, "workspace", "..", "custom", "nested", "x.txt"),
      } })).toMatchObject({ decision: "deny" });
      const outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(cwd, "linked"));
      expect(gate.evaluate({ name: "write_to_file", args: {
        TargetFile: join(cwd, "linked", "not-yet-created", "x.txt"),
      } })).toMatchObject({ decision: "deny" });
      expect(gate.evaluate({ name: "view_file", args: { AbsolutePath: join(customizationDir, "secret") } })).toMatchObject({ decision: "deny" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("danger-full-access/on-requestのcwd外writeはF4表どおりallowする", () => {
    const { gate, root } = makeGate({ sandbox: "danger-full-access", approval: "on-request" });
    try {
      expect(gate.evaluate({ name: "write_to_file", args: { TargetFile: join(root, "outside.txt") } })).toEqual({ decision: "allow" });
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

  it("nonce欠落はdenyし、gate socket closeはpending brokerをdeny解決する", async () => {
    const root = mkdtempSync(join(tmpdir(), "agy-gate-server-test-"));
    const cwd = join(root, "workspace");
    const customizationDir = join(root, "custom");
    mkdirSync(cwd);
    mkdirSync(customizationDir);
    let pending = false;
    const broker = new PermissionBroker({ config: config(), send: () => {}, onPendingChange: (value) => { pending = value !== null; } });
    const gate = new AntigravityGate({
      config: config(), cwd, customizationDir, nodePath: process.execPath, bridgePath: join(root, "bridge.js"), toolNames: () => new Set(), broker,
    });
    const server = await GateServer.listen({ gate, nonce: "nonce", onSocketClose: () => broker.close() });
    try {
      const missingNonce = createConnection(server.socketPath);
      const denied = new Promise<string>((resolve) => {
        missingNonce.setEncoding("utf8");
        missingNonce.once("data", (line: string) => resolve(line));
      });
      await new Promise<void>((resolve) => missingNonce.once("connect", () => resolve()));
      missingNonce.end(`${JSON.stringify({ stepIdx: 1, toolCall: { name: "run_command", args: { CommandLine: "pwd", Cwd: cwd } } })}\n`);
      await expect(denied).resolves.toContain('"decision":"deny"');

      const pendingSocket = createConnection(server.socketPath);
      await new Promise<void>((resolve) => pendingSocket.once("connect", () => resolve()));
      pendingSocket.write(`${JSON.stringify({ nonce: "nonce", stepIdx: 2, toolCall: { name: "run_command", args: { CommandLine: "pwd", Cwd: cwd } } })}\n`);
      for (let index = 0; index < 50 && !pending; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(pending).toBe(true);
      pendingSocket.destroy();
      for (let index = 0; index < 50 && pending; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(pending).toBe(false);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
