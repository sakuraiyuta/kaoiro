import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { PermissionSelection, WrapperPermissionLifecycleMessage } from "@kaoiro/protocol";
import { GrokProcess } from "../src/grok/process.js";
import * as grokEvents from "../src/grok/events.js";
import * as acpConnection from "../src/acp/connection.js";
import { GrokHost, type GrokHostOptions } from "../src/host.js";
import type { GrokWireMetadata } from "../src/grok/wire.js";
const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const config: WrapperConfig = { agent_id: "switch-fixture", display_name: "Switch", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" }, sandbox: "workspace-write", network_access: true };
const choose = (revision: number, sandbox: PermissionSelection["requested"]["sandbox"] = "read-only", network_access = false) =>
  ({ revision, requested: { sandbox, network_access } });
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function started(extra: Partial<GrokHostOptions> = {}) {
  const root = mkdtempSync(join(homedir(), ".kaoiro-grok-switch-")); scratch.push(root);
  const path = join(root, "events.jsonl");
  const envelopes: Envelope[] = [];
  const lifecycle: WrapperPermissionLifecycleMessage[] = [];
  const host = new GrokHost({ config: { ...config }, cwd: root, personaPrompt: "fixture", executable,
    permissionSyncSupported: true, permissionGateTimeoutMs: 150,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: path },
    send: e => envelopes.push(e), onPermissionLifecycle: e => lifecycle.push(e),
    decidePermission: async () => ({ allow: false }), ...extra });
  hosts.push(host);
  const run = host.run(); void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 5000 });
  const events = () => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { host, run, envelopes, lifecycle, events, root };
}
describe("permission switch at the queued head boundary", () => {
  it.each([
    ["workspace-write", true, "workspace", true],
    ["read-only", true, "read-only", false],
    ["danger-full-access", false, "off", true],
  ] as const)("projects the %s profile before its first observation after negotiation", async (sandbox, network, profile, effective) => {
    const { host } = await started({ config: { ...config, sandbox, network_access: network }, permissionSyncSupported: false });
    host.setPermissionSyncSupported(true);
    const projection = () => {
      expect(host.statusExtSnapshot()).toMatchObject({
        permission: { sandbox, approval: "on-request" },
        effective: { sandbox, network_access: effective },
        permission_policy: { grok_sandbox_env: profile },
      });
      if (profile === "off") expect(host.statusExtSnapshot().permission).not.toHaveProperty("enforcement");
      else expect(host.statusExtSnapshot().permission).toHaveProperty("enforcement", "os");
    };
    projection();
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "pending" });
    const turn = host.send("sleep"); void turn.catch(() => {});
    await vi.waitFor(() => expect(host.state).toBe("tool_running"), { timeout: 5000 });
    projection();
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "applying" });
    await host.interrupt(); await turn;
  });
  it("projects the current generation when the first prompt changes profile", async () => {
    const { host } = await started();
    await host.setPermission(choose(1));
    expect(host.statusExtSnapshot().permission).toMatchObject({ sandbox: "workspace-write" });
    const turn = host.send("sleep"); void turn.catch(() => {});
    await vi.waitFor(() => expect(host.state).toBe("tool_running"), { timeout: 5000 });
    expect(host.statusExtSnapshot()).toMatchObject({ permission: { sandbox: "read-only" },
      effective: { sandbox: "read-only", network_access: false } });
    await host.interrupt(); await turn;
    await host.send("no-prompt-id");
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "unknown" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission");
    // The model fields still persist; only the permission stays unknown.
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["sandbox"]));
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["network_access"]));
  });
  it("retires the old group before load, drops replay and sends one observed turn", async () => {
    const decide = vi.fn(async () => ({ allow: false }));
    const starts: string[] = [], ends: string[] = [];
    const { host, events, envelopes, lifecycle } = await started({ decidePermission: decide,
      onTurnStart: t => starts.push(t.turnToken), onTurnEnd: t => ends.push(t.turnToken) });
    const old = host.processId!;
    const first = host.send("sleep");
    await vi.waitFor(() => expect(host.state).toBe("tool_running"));
    await host.setPermission(choose(1));
    expect(host.processId).toBe(old);
    await host.interrupt(); await first;
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "pending" });
    await host.send("fresh");
    const rows = events();
    const second = rows.findIndex(r => r.event === "spawn" && r.profile === "read-only");
    expect(second).toBeGreaterThan(rows.findIndex(r => r.event === "exit" && r.pid === old));
    expect(() => process.kill(old, 0)).toThrow();
    expect(rows).toContainEqual(expect.objectContaining({ event: "session/load", sessionId: "fixture-session" }));
    expect(rows).toContainEqual(expect.objectContaining({ event: "replay-permission-response", outcome: "cancelled" }));
    expect(JSON.stringify(envelopes)).not.toContain("REPLAY_ONLY");
    expect(decide).not.toHaveBeenCalled();
    expect(lifecycle).toContainEqual(expect.objectContaining({ kind: "permission_applied",
      details: expect.objectContaining({ revision: 1, session_id: "fixture-session", turn_id: expect.any(String) }) }));
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "applied" });
    expect(starts).toHaveLength(2); expect(ends).toHaveLength(2);
  });
  it("blocks a missing observation, times out queued input, and recovers at a newer revision", async () => {
    const { host, envelopes, events } = await started();
    await host.send("no-prompt-id");
    expect(host.statusExtSnapshot().permission_gate).toMatchObject({ reason: "observation_unavailable" });
    await expect(host.send("never-sent")).rejects.toThrow("permission_gate_blocked");
    expect(events().filter(r => r.event === "session/prompt")).toHaveLength(1);
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
      .map(e => e.payload.text)).toEqual(["no-prompt-id"]);
    await host.setPermission(choose(1, "workspace-write", true));
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission_gate");
    await host.send("recovered");
    expect(envelopes.filter(e => e.type === "log" && e.payload.kind === "user")
      .map(e => e.payload.text)).toEqual(["no-prompt-id", "recovered"]);
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "applied", revision: 1 });
  });
  it("publishes no launch projection once the first observation is lost", async () => {
    const { host } = await started();
    // Sanity: before any observation the launch profile is projected, so the
    // absence checked below is not vacuous.
    expect(host.statusExtSnapshot()).toHaveProperty("permission");
    await host.send("no-prompt-id");
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "unknown" });
    expect(host.statusExtSnapshot().permission_gate).toMatchObject({ reason: "observation_unavailable" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission");
    // The model fields still persist; only the permission stays unknown.
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["sandbox"]));
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["network_access"]));
  });
  it("keeps the launch projection off across a refused successor after a first loss", async () => {
    const { host } = await started();
    expect(host.statusExtSnapshot()).toHaveProperty("permission");
    await host.send("no-prompt-id");
    await host.setPermission(choose(1, "workspace-write", false));
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "failed" });
    expect(host.statusExtSnapshot().permission_gate).toMatchObject({ revision: 0, reason: "observation_unavailable" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission");
    // The model fields still persist; only the permission stays unknown.
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["sandbox"]));
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["network_access"]));
  });
  it("keeps the launch projection off across a refused successor after a later loss", async () => {
    const { host } = await started();
    await host.send("observed-baseline");
    await host.send("no-prompt-id");
    await host.setPermission(choose(1, "workspace-write", false));
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "failed" });
    expect(host.statusExtSnapshot().permission_gate).toMatchObject({ revision: 0, reason: "observation_unavailable" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission");
    // The model fields still persist; only the permission stays unknown.
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["sandbox"]));
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["network_access"]));
  });
  it("restores both display fields once a later observation is confirmed after a refused successor", async () => {
    const { host } = await started();
    await host.send("no-prompt-id");
    await host.setPermission(choose(1, "workspace-write", false));
    await host.setPermission(choose(2, "workspace-write", true));
    await host.send("recovered");
    expect(host.statusExtSnapshot()).toMatchObject({
      permission: { sandbox: "workspace-write", approval: "on-request" },
      effective: { sandbox: "workspace-write", network_access: true },
      permission_control: { revision: 2, status: "applied" },
    });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission_gate");
  });
  it("publishes no launch projection over a synced unknown control", async () => {
    // A fresh host has no captured execution, so only the newest control can
    // suppress the projection here. The sanity check keeps the absence honest.
    const { host } = await started();
    expect(host.statusExtSnapshot()).toHaveProperty("permission");
    const selection = choose(1, "workspace-write", true);
    host.applyPermissionSync({ version: "0", next: selection,
      control: { ...selection, status: "unknown", reason: "observation_unavailable",
        submitted: { ...selection, execution_id: "exec-sync" },
        constraints: { approval: "on-request", enforcement: "os" } } });
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "unknown" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission");
    // The model fields still persist; only the permission stays unknown.
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["sandbox"]));
    expect(Object.keys(host.statusExtSnapshot().effective ?? {})).not.toEqual(
      expect.arrayContaining(["network_access"]));
  });
  it("retains next after a refused raw toggle instead of capturing latest", async () => {
    const { host } = await started({ config: { ...config, sandbox: "danger-full-access", network_access: false } });
    await host.setPermission(choose(1, "danger-full-access", true));
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "failed" });
    await host.send("authorized-baseline");
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "failed" });
  });
  it("normalizes a read-only raw toggle without restarting the child", async () => {
    const { host } = await started({ config: { ...config, sandbox: "read-only", network_access: true } });
    const pid = host.processId;
    await host.setPermission(choose(1, "read-only", false));
    await host.send("same-profile");
    expect(host.processId).toBe(pid);
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "applied",
      requested: { network_access: false }, effective: { network_access: false } });
  });
  it("refuses a read-only final gate with an always-writable cwd", async () => {
    const cwd = mkdtempSync("/tmp/kogane591-cwd-gate-"); scratch.push(cwd);
    const { host } = await started({ cwd });
    const pid = host.processId;
    await host.setPermission(choose(1));
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "failed",
      reason: "unsupported_permission_pair" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission_gate");
    await host.send("keeps-authorized-workspace");
    expect(host.processId).toBe(pid);
    expect(host.statusExtSnapshot().permission_control).not.toHaveProperty("submitted");
  });
  it("keeps raw toggles without restarting inside one profile", async () => {
    const { host } = await started({ config: { ...config, sandbox: "danger-full-access" } });
    const pid = host.processId;
    await host.setPermission(choose(1, "danger-full-access", false));
    await host.send("observe");
    expect(host.processId).toBe(pid);
    expect(host.statusExtSnapshot().permission_control).toMatchObject({
      constraints: { approval: "on-request", enforcement: "os" },
      requested: { network_access: false }, effective: { network_access: true } });
    expect(host.statusExtSnapshot().permission).not.toHaveProperty("enforcement");
  });
  it.each(["plain", "accepted", "refused"].flatMap(kind =>
    (["inspect", "spawn", "initialize", "load", "readiness", "promotion"] as const).map(step => [kind, step] as const)))
    ("leaves a failed lane unsent with %s successor at %s", async (kind, target) => {
    let fail = true;
    let host!: GrokHost;
    const starts: string[] = [], ends: string[] = [];
    const startedHost = await started({ onLaneStep: async step => {
      if (step !== target || !host || !fail) return;
      fail = false;
      if (kind === "accepted") await host.setPermission(choose(2, "workspace-write", true));
      if (kind === "refused") await host.setPermission(choose(2, "workspace-write", false));
      throw new Error("test lane failure");
    }, onTurnStart: t => starts.push(t.turnToken), onTurnEnd: t => ends.push(t.turnToken) });
    host = startedHost.host;
    await host.setPermission(choose(1));
    const turn = host.send("head"); void turn.catch(() => {});
    if (kind === "accepted") {
      await turn;
      expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
      expect(startedHost.events().filter(r => r.event === "session/prompt")).toHaveLength(1);
      expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 2, status: "applied" });
    } else {
      await expect(turn).rejects.toThrow("permission_gate_blocked");
      expect(starts).toHaveLength(0); expect(ends).toHaveLength(1);
      expect(startedHost.events().filter(r => r.event === "session/prompt")).toHaveLength(0);
      expect(host.statusExtSnapshot().permission_gate).toMatchObject({ reason: "awaiting_server_next", revision: 1, step: target === "promotion" ? "loading_exit" : target });
      expect(host.statusExtSnapshot().permission_control).not.toHaveProperty("submitted");
      expect(host.statusExtSnapshot().permission_control).not.toHaveProperty("rolled_back_to");
      if (kind === "refused") {
        host.applyPermissionSync({ version: "0", next: choose(1),
          control: { ...choose(2, "workspace-write", false), status: "failed",
            reason: "unsupported_permission_pair", rolled_back_to: choose(1).requested,
            constraints: { approval: "on-request", enforcement: "os" } } });
      } else await host.setPermission(choose(3, "workspace-write", true));
      await host.send("next");
      expect(starts).toHaveLength(1);
      expect(host.statusExtSnapshot()).not.toHaveProperty("permission_gate");
    }
    expect(startedHost.envelopes.some(e => e.type === "state_change" &&
      e.ext?.permission_control?.revision === 1 && e.ext.permission_control.status === "applying")).toBe(false);
  });
});

describe("lane cancellation and failure boundaries", () => {
  it("omits the wire step when stopping fails before retirement", async () => {
    let armed = false;
    const { host, events, envelopes } = await started({ onLaneStep: step => {
      if (armed && step === "stopping") throw new Error("fixture stopping failure");
    } });
    const old = host.processId!;
    armed = true;
    await host.setPermission(choose(1));
    await expect(host.send("unsent")).rejects.toThrow("permission_gate_blocked");
    expect(host.processId).toBe(old);
    expect(() => process.kill(old, 0)).not.toThrow();
    expect(events().filter(r => r.event === "session/prompt")).toHaveLength(0);
    const gate = host.statusExtSnapshot().permission_gate;
    expect(gate).toMatchObject({ status: "blocked", reason: "awaiting_server_next", revision: 1 });
    expect(gate).not.toHaveProperty("step");
    const sent = envelopes.filter(e => e.type === "state_change" && e.ext?.permission_gate).at(-1);
    expect(sent?.ext?.permission_gate).toEqual(gate);
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "failed", reason: "restart_failed" });
  });
  for (const target of ["stopping", "inspect", "spawn", "initialize", "load", "readiness", "promotion"] as const) {
    it(`close wins at ${target} and waits for every owned group`, async () => {
      let host: GrokHost | undefined;
      const pids: number[] = [];
      let closedAt = false;
      const { host: built, run, events, lifecycle } = await started({ onLaneStep: async (step, pid) => {
        if (pid && !pids.includes(pid)) pids.push(pid);
        if (host && step === target) { closedAt = true; host.close(); }
        if (closedAt && step === "spawn" && target !== "spawn") throw new Error("spawn after close");
      } });
      host = built; pids.push(host.processId!);
      const connections = vi.spyOn(acpConnection, "connectAcp");
      await host.setPermission(choose(1));
      await expect(host.send("must-not-start")).rejects.toThrow("closed");
      await host.closed; await run;
      expect(closedAt).toBe(true);
      expect(lifecycle.filter(e => e.kind === "permission_failed")).toHaveLength(0);
      expect(connections).toHaveBeenCalledTimes(["stopping", "inspect", "spawn"].includes(target) ? 0 : 1);
      for (const pid of new Set(pids)) expect(() => process.kill(pid, 0)).toThrow();
      expect(events().filter(r => r.event === "session/prompt")).toHaveLength(0);
    });
  }
  for (const [method, expectedStep] of [["initialize", "initialize"], ["session/load", "load"], ["readiness", "readiness"]]) {
    for (const fault of ["exit", "close"]) {
      it(`loading ${fault} at ${expectedStep} fails only its lane`, async () => {
        let host: GrokHost | undefined;
        const env = { ...process.env };
        const root = mkdtempSync(join(homedir(), ".kaoiro-grok-switch-fault-")); scratch.push(root);
        const eventPath = join(root, "events");
        env.KAOIRO_TEST_GROK_EVENTS = eventPath;
        if (expectedStep !== "readiness") env.KAOIRO_TEST_GROK_SWITCH_FAULT = `${method}:${fault}`;
        else env.KAOIRO_TEST_GROK_SWITCH_FAULT = `readiness:${fault}`;
        const startedHost = await started({ env, mcpReadyTimeoutMs: 500 });
        host = startedHost.host;
        await host.setPermission(choose(1));
        await expect(host.send("unsent")).rejects.toThrow("permission_gate_blocked");
        expect(host.statusExtSnapshot().permission_gate).toMatchObject({ step: expectedStep, revision: 1 });
        expect(host.state).toBe("waiting_input");
        const records = readFileSync(eventPath, "utf8").trim().split("\n").map(x => JSON.parse(x));
        expect(records.filter(r => r.event === "session/prompt")).toHaveLength(0);
        await host.setPermission(choose(2, "workspace-write", true));
        await host.send("recovered");
      });
    }
  }
  it("checks failure again between readiness and promotion", async () => {
    let host: GrokHost | undefined;
    const { host: built, events } = await started({ onLaneStep: async (step, pid) => {
      if (host && step === "promotion") {
        process.kill(pid!, "SIGTERM");
        await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
      }
    } });
    host = built;
    await host.setPermission(choose(1));
    await expect(host.send("unsent")).rejects.toThrow("permission_gate_blocked");
    expect(host.statusExtSnapshot().permission_gate).toMatchObject({ step: "loading_exit" });
    expect(events().filter(r => r.event === "session/prompt")).toHaveLength(0);
  });
  it("waits for rejoin sync before dispatching any queued prompt", async () => {
    let release!: () => void;
    let pending = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const { host, events } = await started({ waitForPermissionSync: () => pending ? barrier : Promise.resolve() });
    pending = true;
    const turn = host.send("wait-for-sync");
    await new Promise(resolve => setImmediate(resolve));
    expect(events().filter(r => r.event === "session/prompt")).toHaveLength(0);
    release(); await turn;
    expect(events().filter(r => r.event === "session/prompt")).toHaveLength(1);
  });
  it("refuses unsupported persisted sync before stopping the resident child", async () => {
    const steps: string[] = [];
    const { host, events, lifecycle } = await started({ onLaneStep: step => { steps.push(step); } });
    steps.length = 0;
    const old = host.processId!;
    const selection = choose(1, "workspace-write", false);
    host.applyPermissionSync({ version: "0", next: selection,
      control: { ...selection, status: "pending", constraints: { approval: "on-request", enforcement: "os" } } });
    await expect(host.send("unsent")).rejects.toThrow("permission_gate_blocked");
    expect(() => process.kill(old, 0)).not.toThrow();
    expect(host.processId).toBe(old);
    expect(steps).toEqual([]);
    expect(events().filter(r => r.event === "session/prompt")).toHaveLength(0);
    expect(host.statusExtSnapshot().permission_gate).toMatchObject({ revision: 1, reason: "awaiting_server_next" });
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 1, status: "failed", reason: "unsupported_permission_pair" });
    expect(host.statusExtSnapshot().permission_control).not.toHaveProperty("submitted");
    expect(lifecycle.at(-1)?.details).toMatchObject({ revision: 1, reason: "unsupported_permission_pair" });
    // Recover to read-only, not to the launch pair: the launch pair needs no
    // restart, so recovering to it would leave the restart path untested.
    await host.setPermission(choose(2, "read-only", false));
    await host.send("authorized-recovery");
    expect(host.processId).not.toBe(old);
    expect(() => process.kill(old, 0)).toThrow();
  });
  it("fails a prompt without observation closed to later dispatch", async () => {
    const { host } = await started();
    await expect(host.send("fail-turn")).rejects.toThrow();
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "unknown" });
    await expect(host.send("blocked")).rejects.toThrow("permission_gate_blocked");
  });
  it("retains an observation when operator rejection makes the turn fail", async () => {
    const { host } = await started();
    await expect(host.send("permission")).rejects.toThrow("permission rejected");
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ status: "applied" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission_gate");
  });
  it("refuses final-gate violations without stopping the existing selection", async () => {
    const { host, lifecycle } = await started(); const pid = host.processId;
    await host.setPermission(choose(1, "danger-full-access", true));
    expect(lifecycle.at(-1)?.details).toMatchObject({ reason: "exceeds_launch_ceiling" });
    await host.setPermission(choose(2, "workspace-write", false));
    expect(lifecycle.at(-1)?.details).toMatchObject({ reason: "unsupported_permission_pair" });
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission_gate");
    await host.send("still-on-launch");
    expect(host.processId).toBe(pid);
    expect(host.statusExtSnapshot().permission_control).toMatchObject({ revision: 2, status: "failed" });
  });
  it("keeps the legacy off-platform launch display and rejects switching", async () => {
    const { host } = await started({ platform: "darwin", config: { ...config, sandbox: "danger-full-access", network_access: false } });
    expect(host.statusExtSnapshot()).toMatchObject({
      permission: { sandbox: "danger-full-access", approval: "on-request" },
      effective: { sandbox: "danger-full-access", network_access: true },
      permission_policy: { grok_sandbox_env: "off" },
      session_capabilities: { supports_permission_switch: false, supports_permission_mode_switch: false },
    });
    expect(host.statusExtSnapshot().permission).not.toHaveProperty("enforcement");
    expect(host.statusExtSnapshot()).not.toHaveProperty("permission_control");
    await expect(host.setPermission(choose(1))).rejects.toThrow("fixed");
  });
});

describe("metadata of a loading generation (issue #633)", () => {
  const isStart = (m: GrokWireMetadata) => m.hook_event === "session_start";
  const isOut = (method: string) => (m: GrokWireMetadata) => m.direction === "out" && m.method === method;
  it("publishes a promoted load's session_start and never the load replay", async () => {
    const metadata: GrokWireMetadata[] = [];
    const { host } = await started({ onMetadata: m => metadata.push(m) });
    await host.setPermission(choose(1));
    await host.send("fresh");
    expect(metadata.filter(isStart)).toHaveLength(2);
    const load = metadata.findIndex(isOut("session/load"));
    const prompt = metadata.findIndex((m, i) => i > load && isOut("session/prompt")(m));
    expect(load).toBeGreaterThan(-1);
    const window = metadata.slice(load, prompt);
    expect(window.some(isStart)).toBe(true);
    expect(window.some(m => m.method === "session/update")).toBe(false);
    expect(window.some(m => m.method === "_x.ai/session/update")).toBe(false);
  });
  it("calls onMetadata with session_start before onSessionId at startup and at a switch", async () => {
    const order: string[] = [];
    const { host } = await started({
      onMetadata: m => { if (isStart(m)) order.push("start"); },
      onSessionId: () => { order.push("session"); },
    });
    expect(order).toEqual(["start", "session"]);
    await host.setPermission(choose(1));
    await host.send("fresh");
    expect(order).toEqual(["start", "session", "start", "session"]);
  });
  for (const fault of ["exit", "close"]) {
    it(`drops the metadata of a generation that fails at readiness (${fault})`, async () => {
      const metadata: GrokWireMetadata[] = [];
      const root = mkdtempSync(join(homedir(), ".kaoiro-grok-switch-fault-")); scratch.push(root);
      const env = { ...process.env, KAOIRO_TEST_GROK_EVENTS: join(root, "events"),
        KAOIRO_TEST_GROK_SWITCH_FAULT: `readiness:${fault}` };
      const { host } = await started({ env, mcpReadyTimeoutMs: 500, onMetadata: m => metadata.push(m) });
      await host.setPermission(choose(1));
      await expect(host.send("unsent")).rejects.toThrow("permission_gate_blocked");
      expect(metadata.filter(isStart)).toHaveLength(1);
      expect(metadata.some(isOut("session/load"))).toBe(false);
      await host.setPermission(choose(2, "workspace-write", true));
      await host.send("recovered");
      expect(metadata.filter(isStart)).toHaveLength(2);
      expect(metadata.filter(isOut("session/load"))).toHaveLength(1);
    });
  }
  it("drops held metadata when close wins while loading", async () => {
    const metadata: GrokWireMetadata[] = [];
    let host: GrokHost | undefined;
    const { host: built, run } = await started({ onMetadata: m => metadata.push(m),
      onLaneStep: step => { if (host && step === "readiness") host.close(); } });
    host = built;
    await host.setPermission(choose(1));
    await expect(host.send("must-not-start")).rejects.toThrow("closed");
    await host.closed; await run;
    expect(metadata.filter(isStart)).toHaveLength(1);
    expect(metadata.some(isOut("session/load"))).toBe(false);
  });
});

it("never spawns until the old owned group close has settled", async () => {
  const { host } = await started();
  const original = GrokProcess.prototype.close;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  vi.spyOn(GrokProcess.prototype, "close").mockImplementation(async function (this: GrokProcess) {
    entered = true;
    await barrier;
    await original.call(this);
  });
  let spawning = false;
  const spawn = vi.spyOn(acpConnection, "connectAcp");
  await host.setPermission(choose(1));
  const turn = host.send("after-close"); void turn.catch(() => {});
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    // Inspect completes well inside this interval; an unawaited close lets
    // the next real fixture connect while the retained group is still alive.
    await new Promise(resolve => setTimeout(resolve, 800));
    spawning = spawn.mock.calls.length > 0;
  } finally { release(); }
  await turn;
  expect(spawning).toBe(false);
});

it.each(["loading", "current"])("ignores a retired connection's delayed callbacks while the successor is %s", async phase => {
  const original = acpConnection.connectAcp;
  type Call = Parameters<typeof original>;
  let first: Call | undefined;
  let releaseClosed!: () => void;
  const delayed = new Promise<void>(resolve => { releaseClosed = resolve; });
  vi.spyOn(acpConnection, "connectAcp").mockImplementation(((...args: Call) => {
    const connection = original(...args);
    if (first) return connection;
    first = args;
    return new Proxy(connection, { get(target, property) {
      if (property === "closed") return delayed;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }) as typeof original);
  let host: GrokHost | undefined;
  const metadata: unknown[] = [];
  const decide = vi.fn(async () => ({ allow: false }));
  const startedHost = await started({ decidePermission: decide, onMetadata: value => metadata.push(value),
    onLaneStep: step => { if (host && phase === "loading" && step === "load") releaseClosed(); } });
  host = startedHost.host;
  await host.setPermission(choose(1)); await host.send("new-generation");
  if (phase === "current") releaseClosed();
  await new Promise(resolve => setImmediate(resolve));
  expect(host.processId).toBeDefined();
  const turn = host.send("sleep");
  await vi.waitFor(() => expect(host!.state).toBe("tool_running"));
  const callbacks = first![1];
  const before = startedHost.envelopes.length;
  const completions = vi.spyOn(grokEvents, "turnCompletion");
  callbacks.update({ sessionId: "fixture-session", update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RETIRED_ONLY" } } });
  callbacks.metadata({ direction: "in", method: "retired-marker" });
  first![2]?.notifications?.[0]?.handle({ sessionId: "fixture-session", update: {
    sessionUpdate: "turn_completed", prompt_id: "retired-only" } });
  const response = await callbacks.permission({ sessionId: "fixture-session",
    toolCall: { toolCallId: "retired", title: "retired" }, options: [] }, new AbortController().signal);
  expect(response.outcome.outcome).toBe("cancelled");
  expect(completions).not.toHaveBeenCalled();
  expect(decide).not.toHaveBeenCalled();
  expect(startedHost.envelopes.length).toBe(before);
  expect(JSON.stringify(metadata)).not.toContain("retired-marker");
  await host.interrupt(); await turn;
  await host.send("still-open");
});
