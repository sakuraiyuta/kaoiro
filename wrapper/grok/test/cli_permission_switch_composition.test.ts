import "../../../scripts/test/fixtures/test-isolation.mjs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { phoenixLoopback } from "../../../runner/test/fixtures/phoenix_loopback.js";
const scratch: string[] = [];
const cwd = () => { const path = mkdtempSync(join(homedir(), ".kaoiro-grok-composition-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("negotiates, switches and publishes observations and stops on the actual ServerLink wire", async () => {
  const server = await phoenixLoopback(() => ({ permission_sync: true,
    inter_agent_delivery_incarnation: "fixture-incarnation",
    inter_agent_delivery: { issued_seq: 1, acked_seq: 0 } }));
  let host: GrokHost | undefined;
  let failLoad = false;
  const statuses = () => server.received.filter(x => x.event === "envelope" && x.payload.type === "state_change")
    .map(x => x.payload.ext as Record<string, any>);
  const control = () => statuses().at(-1)?.permission_control;
  const pushSelection = (revision: number, sandbox: string, network_access: boolean) =>
    server.push("set_permission", { version: "0", revision, sandbox, network_access });
  const work = runGrokCli({
    cwd: cwd(),
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ agent_id: "composition.grok", display_name: "Grok",
      server_url: server.url, sandbox: "danger-full-access", network_access: true,
      persona: { id: "default", name: "Default", sprite_set: "default" } }),
    loadWrapperBuildInfo: () => ({ revision: "unknown", dirty: false, built_at: "unknown", version: "unknown", channel: "dev" }),
    createHost: options => new GrokHost({ ...options,
      executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
      permissionGateTimeoutMs: 250,
      onLaneStep: step => { if (failLoad && step === "load") { failLoad = false; throw new Error("load failure"); } },
    }),
    onHostCreated: value => { host = value; },
  });
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    expect(server.received.find(x => x.event === "phx_join")?.payload.permission_sync).toEqual({ engine: "grok" });
    server.push("permission_sync", { version: "0", control: null, next: null });
    server.push("persona_prompt", { prompt: "Fixture persona" });
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5000 });
    await vi.waitFor(() => expect(control()).toMatchObject({ revision: 0, status: "pending",
      constraints: { approval: "on-request", enforcement: "os" } }));
    expect(statuses().at(-1)?.session_capabilities.supports_permission_switch).toBe(true);
    for (const [revision, sandbox] of [[1, "workspace-write"], [2, "danger-full-access"]] as const) {
      pushSelection(revision, sandbox, true);
      await vi.waitFor(() => expect(control()).toMatchObject({ revision, status: "pending" }));
      server.push("instruction", { version: "0", text: "observe" });
      await vi.waitFor(() => expect(control()).toMatchObject({ revision, status: "applied" }), { timeout: 5000 });
      expect(statuses().some(x => x.permission_control?.revision === revision && x.permission_control.status === "applying")).toBe(true);
      expect(control().constraints).toEqual({ approval: "on-request", enforcement: "os" });
      await vi.waitFor(() => expect(server.received.some(x => x.event === "session_lifecycle" &&
        x.payload.kind === "permission_applied" && (x.payload.details as any).revision === revision &&
        typeof (x.payload.details as any).turn_id === "string")).toBe(true));
    }
    pushSelection(3, "workspace-write", false);
    await vi.waitFor(() => expect(control()).toMatchObject({ revision: 3, status: "failed", reason: "unsupported_permission_pair" }));
    expect(statuses().at(-1)).not.toHaveProperty("permission_gate");
    failLoad = true;
    pushSelection(4, "read-only", false);
    await vi.waitFor(() => expect(control()?.revision).toBe(4));
    server.push("envelope", { version: "0", type: "inter_agent_message", agent_id: "peer",
      display_name: "Peer", persona: { id: "default", name: "Default", sprite_set: "default" },
      ts: new Date().toISOString(), state: "idle", delivery_seq: 1,
      payload: { to: "composition.grok", conversation_id: "head-recovery", turn_number: 1,
        kind: "request", body: "Reply", meta: { done: false, propose_next: "" } } });
    await vi.waitFor(() => expect(statuses().at(-1)?.permission_gate).toMatchObject({ reason: "awaiting_server_next", revision: 4 }), { timeout: 5000 });
    expect(control()).not.toHaveProperty("submitted");
    expect(server.received.filter(x => x.event === "delivery_ack")).toHaveLength(0);
    pushSelection(5, "workspace-write", true);
    await vi.waitFor(() => expect(control()).toMatchObject({ revision: 5, status: "applied" }), { timeout: 5000 });
    expect(statuses().at(-1)).not.toHaveProperty("permission_gate");
    await vi.waitFor(() => expect(server.received.filter(x => x.event === "delivery_ack")).toHaveLength(1));
    expect(server.received.filter(x => x.event === "envelope" && x.payload.type === "log" &&
      (x.payload.payload as any).kind === "user")
      .map(x => (x.payload.payload as any).text)).toEqual(["observe", "observe"]);
    server.push("instruction", { version: "0", text: "no-prompt-id" });
    await vi.waitFor(() => expect(control()).toMatchObject({ revision: 5, status: "unknown" }));
    expect(statuses().at(-1)?.permission_gate).toMatchObject({ reason: "observation_unavailable" });
    server.drop();
    await vi.waitFor(() => expect(server.joins).toBe(2), { timeout: 5000 });
    server.push("permission_sync", { version: "0", control: control(),
      next: { revision: 5, requested: { sandbox: "workspace-write", network_access: true } } });
    await vi.waitFor(() => expect(statuses().at(-1)?.permission_gate).toMatchObject({ reason: "observation_unavailable" }));
  } finally { host?.close(); await work; await server.close(); }
}, 30_000);

it.each(["darwin", "linux"] as const)("keeps the %s join and raw launch ceiling on the wire", async platform => {
  const server = await phoenixLoopback(() => ({ permission_sync: platform === "linux" }));
  let host: GrokHost | undefined;
  const work = runGrokCli({ platform, cwd: cwd(),
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => ({ agent_id: "composition.ceiling", display_name: "Fixture", server_url: server.url,
      sandbox: "danger-full-access", network_access: false,
      persona: { id: "default", name: "Default", sprite_set: "default" } }),
    createHost: options => new GrokHost({ ...options, executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)) }),
    onHostCreated: value => { host = value; },
  });
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    const join = server.received.find(x => x.event === "phx_join")!.payload;
    if (platform === "linux") {
      expect(join.permission_sync).toEqual({ engine: "grok" });
      server.push("permission_sync", { version: "0", control: null, next: null });
    } else server.push("set_permission", { version: "0", revision: 1, sandbox: "read-only", network_access: false });
    server.push("persona_prompt", { prompt: "Fixture" });
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5000 });
    const pid = host!.processId;
    if (platform === "darwin") expect(join).not.toHaveProperty("permission_sync");
    if (platform === "linux") {
      server.push("set_permission", { version: "0", revision: 1, sandbox: "danger-full-access", network_access: true });
      await vi.waitFor(() => expect(server.received.some(x => x.event === "session_lifecycle" &&
        x.payload.kind === "permission_failed" && (x.payload.details as any).reason === "exceeds_launch_ceiling")).toBe(true));
      expect(host!.statusExtSnapshot()).not.toHaveProperty("permission_gate");
    } else {
      expect(host!.statusExtSnapshot()).not.toHaveProperty("permission_control");
      await expect(host!.setPermission({ revision: 1, requested: { sandbox: "read-only", network_access: false } })).rejects.toThrow("fixed");
      const failures = () => server.received.filter(x => x.event === "envelope" && x.payload.type === "log" &&
        (x.payload.payload as any).text === "grok permission switching failed");
      await vi.waitFor(() => expect(failures()).toHaveLength(1));
      server.push("set_permission", { version: "0", revision: 2, sandbox: "read-only", network_access: false });
      await vi.waitFor(() => expect(failures()).toHaveLength(2));
    }
    expect(host!.processId).toBe(pid);
  } finally { host?.close(); await work; await server.close(); }
}, 10000);
