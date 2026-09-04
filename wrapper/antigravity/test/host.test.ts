import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PermissionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, initialStatusExt, isGateRegistered, type SpawnedAgy } from "../src/host.js";
import type { AntigravityLaunchConfig } from "../src/gate.js";

class FakeAgy extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killed: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal;
    return true;
  }

  finish(): void {
    this.stdout.end();
    this.emit("exit", 0, null);
  }
}

function config(): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    display_name: "もも",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for host");
}

function hostHarness(options: { resumeSessionId?: string; dangerouslySkipPermissions?: boolean; verifyGate?: boolean } = {}) {
  const states: Envelope[] = [];
  const logs: Envelope[] = [];
  const calls: { command: string; args: string[]; child: FakeAgy }[] = [];
  const cfg = config();
  const broker = new PermissionBroker({ config: cfg, send: () => {} });
  const host = new AntigravityHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: broker,
    onState: (envelope) => states.push(envelope),
    onLog: (envelope) => logs.push(envelope),
    verifyGate: async () => options.verifyGate ?? true,
    runtimeAssetsAvailable: () => true,
    ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
    ...(options.dangerouslySkipPermissions === undefined ? {} : { dangerouslySkipPermissions: options.dangerouslySkipPermissions }),
    spawn: (command, args) => {
      const child = new FakeAgy();
      calls.push({ command, args, child });
      return child as unknown as SpawnedAgy;
    },
  });
  return { host, states, logs, calls };
}

describe("AntigravityHost", () => {
  it("on-failure approvalはspawn前に拒否する", () => {
    const cfg: AntigravityLaunchConfig = { ...config(), approval: "on-failure" };
    const broker = new PermissionBroker({ config: cfg, send: () => {} });
    expect(() => new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: broker,
      onState: () => {}, runtimeAssetsAvailable: () => true,
    })).toThrow("antigravity approval=on-failure is unsupported");
  });

  it("permission enforcementをadvisoryとしてstatus extにstampする", () => {
    expect(initialStatusExt(config() as AntigravityLaunchConfig)).toMatchObject({
      permission: { enforcement: "advisory" },
    });
  });

  it("F4b smoke probeはexpected sourceのgateをちょうど一つ要求する", () => {
    expect(isGateRegistered({ hooks: [{ source: "/pkg/dist/hook.js" }] }, "/pkg/dist/hook.js")).toBe(true);
    expect(isGateRegistered({ hooks: [] }, "/pkg/dist/hook.js")).toBe(false);
    expect(isGateRegistered({ hooks: [{ source: "/pkg/dist/hook.js" }, { source: "/pkg/dist/hook.js" }] }, "/pkg/dist/hook.js")).toBe(false);
  });

  it("F2のspawn引数、closed stdin、init session idとresultを結ぶ", async () => {
    const { host, states, logs, calls } = hostHarness();
    const sessionIds: string[] = [];
    const onSessionHost = new AntigravityHost(config(), {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: config(), send: () => {} }),
      onState: (envelope) => states.push(envelope), onLog: (envelope) => logs.push(envelope), onSessionId: (id) => sessionIds.push(id),
      verifyGate: async () => true, runtimeAssetsAvailable: () => true,
      spawn: (command, args) => { const child = new FakeAgy(); calls.push({ command, args, child }); return child as unknown as SpawnedAgy; },
    });
    await onSessionHost.send("hello");
    await waitFor(() => calls.length === 1);
    const call = calls[0]!;
    expect(call.command).toBe("agy");
    expect(call.args).toEqual(expect.arrayContaining(["--print", "hello", "--output-format", "stream-json", "--print-timeout", "24h", "--disable-slash-commands", "--dangerously-skip-permissions", "--add-dir", process.cwd()]));
    expect(call.child.stdin.writableEnded).toBe(true);
    call.child.stdout.write('{"event":"init","conversation_id":"cid-1","init":{"tools":[]}}\n');
    call.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    call.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(sessionIds).toEqual(["cid-1"]);
    expect(states.map((envelope) => envelope.state)).toContain("done");
    onSessionHost.close();
    host.close();
  });

  it("resumeではconversationを渡し、flagを設定で止められる", async () => {
    const { host, calls } = hostHarness({ resumeSessionId: "resume-1", dangerouslySkipPermissions: false });
    await host.send("next");
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--conversation", "resume-1"]));
    expect(calls[0]!.args).not.toContain("--dangerously-skip-permissions");
    calls[0]!.child.finish();
    host.close();
  });

  it("result無しexitはagy_exit_without_resultとしてerrorにする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ is_error: true, error_detail: "agy_exit_without_result" });
    host.close();
  });

  it("F4bの未観測tool完了はchildをSIGTERMしてsessionをerrorにする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"init","conversation_id":"cid","init":{"tools":["run_command"]}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"error":{"message":"denied"}}}}\n');
    await waitFor(() => child.killed === "SIGTERM");
    child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool" });
    host.close();
  });
});
