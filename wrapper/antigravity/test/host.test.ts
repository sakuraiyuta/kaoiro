import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PermissionBroker, QuestionBroker, type Envelope, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, initialStatusExt, isGateRegistered, type GateProbe, type SpawnedAgy } from "../src/host.js";
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
    this.emit("close", 0, null);
  }
}

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
    display_name: "もも",
    server_url: "ws://localhost:4000",
    sandbox: "workspace-write",
    network_access: false,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for host");
}

function hostHarness(options: {
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  verifyGate?: boolean | (() => Promise<boolean>);
  config?: WrapperConfig;
} = {}) {
  const states: Envelope[] = [];
  const logs: Envelope[] = [];
  const calls: { command: string; args: string[]; child: FakeAgy }[] = [];
  const cfg = options.config ?? config();
  const broker = new PermissionBroker({ config: cfg, send: () => {} });
  const host = new AntigravityHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: broker,
    onState: (envelope) => states.push(envelope),
    onLog: (envelope) => logs.push(envelope),
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => typeof options.verifyGate === "function" ? options.verifyGate() : options.verifyGate ?? true,
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
    expect(initialStatusExt({
      ...config(), model: "gemini-3.6-flash-low", model_source: "env", effort: "high", effort_source: "config",
    } as AntigravityLaunchConfig)).toMatchObject({
      model: "gemini-3.6-flash-low",
      model_source: "env",
      effort: "high",
      effort_source: "config",
      permission: { enforcement: "advisory" },
    });
  });

  it("effective snapshotにapprovalを含める (ADR-0057 F4c, resume drift検出に必要)", () => {
    const cfg: AntigravityLaunchConfig = { ...config(), approval: "never" };
    expect(initialStatusExt(cfg)).toMatchObject({
      effective: { approval: "never" },
    });
  });

  it("approval省略時はeffective snapshotでon-requestにfallbackする", () => {
    expect(initialStatusExt(config() as AntigravityLaunchConfig)).toMatchObject({
      effective: { approval: "on-request" },
    });
  });

  // issue #292 (phase-34 Stage B6): antigravity_extra_models (relayed from
  // runner.config.json's antigravity.extra_models) merges into the pinned
  // snapshot before ext.models is stamped, mirroring the codex adapter's
  // codex_extra_models (wrapper/codex/src/host.ts).
  it("appends a new antigravity_extra_models model to ext.models (issue #292)", () => {
    const cfg = {
      ...config(),
      antigravity_extra_models: [
        { value: "gemini-4-nova", display_name: "Gemini 4 Nova" },
      ],
    } as AntigravityLaunchConfig;
    const initial = initialStatusExt(cfg);
    expect(
      (initial.models as { value: string }[]).map((m) => m.value),
    ).toContain("gemini-4-nova");
  });

  it("antigravity_extra_models overrides an existing snapshot value (issue #292)", () => {
    const cfg = {
      ...config(),
      antigravity_extra_models: [
        { value: "gemini-3.6-flash-high", display_name: "overridden" },
      ],
    } as AntigravityLaunchConfig;
    const initial = initialStatusExt(cfg);
    const flash = (
      initial.models as { value: string; display_name: string }[]
    ).find((m) => m.value === "gemini-3.6-flash-high");
    expect(flash?.display_name).toBe("overridden");
  });

  it("the constructor's own catalog reflects antigravity_extra_models before any live probe resolves (issue #292)", () => {
    const cfg = {
      ...config(),
      antigravity_extra_models: [
        { value: "gemini-4-nova", display_name: "Gemini 4 Nova" },
      ],
    };
    const { host } = hostHarness({ config: cfg });
    // Synchronous, before any await: #refreshCatalog's probe cannot have
    // resolved yet, so this observes the constructor's OWN merge line
    // (this.#catalog = mergeExtraModels(...)), not a live-probed catalog.
    const snapshot = host.statusExtSnapshot();
    expect(
      (snapshot.models as { value: string }[]).map((m) => m.value),
    ).toContain("gemini-4-nova");
    host.close();
  });

  it("F4b smoke probeは実機形hooks.json内の期待action一件だけを受け入れる", () => {
    const source = "/tmp/kaoiro-agy-x/.agents/hooks.json";
    const command = "/usr/bin/node /pkg/dist/hook.js";
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/hooks.json", import.meta.url), "utf8")
      .replace("__HOOKS_JSON__", source).replace("__HOOK_COMMAND__", command)) as unknown;
    const expected = { source, command, timeoutSeconds: 3600 };
    expect(isGateRegistered(fixture, expected)).toBe(true);
    expect(isGateRegistered({ hooks: [] }, expected)).toBe(false);
    expect(isGateRegistered({ hooks: [{ source, actions: [{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }, { event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }] }] }, expected)).toBe(false);
  });

  it("default verifier control-flowが実機形fixtureを通してspawnする", async () => {
    const calls: { command: string; args: string[]; child: FakeAgy }[] = [];
    const cfg = config();
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {}, runtimeAssetsAvailable: () => true,
      probeSpawn: (_command, args) => {
        const child = new FakeAgy();
        const source = join(args[args.lastIndexOf("--add-dir") + 1]!, ".agents", "hooks.json");
        const command = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify({ hooks: [{ source, actions: [{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }] }] }));
          child.emit("exit", 0, null);
        });
        return child as unknown as GateProbe;
      },
      spawn: (command, args) => { const child = new FakeAgy(); calls.push({ command, args, child }); return child as unknown as SpawnedAgy; },
    });
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.finish();
    host.close();
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
    expect(call.args).toEqual(expect.arrayContaining(["--print", "hello", "--output-format", "stream-json", "--print-timeout", "24h", "--disable-slash-commands", "--dangerously-skip-permissions"]));
    const addDirIndexes = call.args.flatMap((arg, index) => arg === "--add-dir" ? [index] : []);
    expect(addDirIndexes).toHaveLength(2);
    expect(addDirIndexes.map((index) => call.args[index + 1])).toEqual([process.cwd(), expect.stringMatching(/kaoiro-agy-/)]);
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

  it("coalesces three assistant text deltas into one log entry on DONE", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"one "}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"two "}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"three"}}\n');
    expect(logs.filter((envelope) => envelope.type === "log" && envelope.payload.kind === "assistant")).toEqual([
      expect.objectContaining({ payload: { kind: "assistant", text: "one two three" } }),
    ]);
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"one two three"}}\n');
    child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.filter((envelope) => envelope.type === "log" && envelope.payload.kind === "assistant")).toHaveLength(1);
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ text: "one two three" });
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
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool:run_command" });
    host.close();
  });

  it("F4bはtool_info.nameをidentityに使い、未観測DONEをfail-closedにする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"init","conversation_id":"cid","init":{"tools":["run_command"]}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_info":{"name":"run_command","output":"done"}}}\n');
    await waitFor(() => child.killed === "SIGTERM");
    child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool:run_command" });
    host.close();
  });

  it("F4bはunsafe step_indexを相関不能としてkillする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"step_update","step_update":{"step_index":1.5,"state":"DONE","step_type":"tool","tool_name":"run_command"}}\n');
    await waitFor(() => child.killed === "SIGTERM");
    child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool:run_command" });
    host.close();
  });

  it("F4bはtop-levelとtool_infoのname矛盾を相関不能としてkillする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"must not publish"}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"future_vendor_tool","tool_info":{"name":"run_command","output":"done"}}}\n');
    await waitFor(() => child.killed === "SIGTERM");
    child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool:future_vendor_tool" });
    host.close();
  });

  it("child exit後のlate tool completionをstdout EOFまで待ってfail-stopにする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"must not publish"}}\n');
    child.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command"}}\n');
    await waitFor(() => child.killed === "SIGTERM");
    const stdoutEnded = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()));
    child.stdout.end();
    await stdoutEnded;
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    child.emit("close", 0, null);
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool:run_command" });
    await host.send("must not spawn");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
    host.close();
  });

  it("child error後の未観測tool完了はclose時にgate errorを優先してfreezeする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"must not publish"}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command"}}\n');
    await waitFor(() => child.killed === "SIGTERM");
    child.emit("error", new Error("kill failed"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    const stdoutEnded = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()));
    child.stdout.end();
    await stdoutEnded;
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    child.emit("close", 0, null);
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_unobserved_tool:run_command" });
    await host.send("must not spawn");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
    host.close();
  });

  it("turn後にcustomizationが改ざんされるとsessionをerrorにする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const customizationDir = calls[0]!.args.at(-1)!;
    writeFileSync(join(customizationDir, ".agents", "rules", "AGENTS.md"), "tampered");
    calls[0]!.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    calls[0]!.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect([...logs].reverse().find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_customization_tampered" });
    host.close();
  });

  it("interrupt後でもturn後customization改ざんをfail-stopにする", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const customizationDir = calls[0]!.args.at(-1)!;
    writeFileSync(join(customizationDir, ".agents", "rules", "AGENTS.md"), "tampered");
    await host.interrupt();
    calls[0]!.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_customization_tampered" });
    await host.send("must not spawn");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
    host.close();
  });

  it("vendor resultはturn integrityが通るまでrelayしない", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    calls[0]!.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    host.close();
  });

  it("setModelは次turn成功までeffective pairを変えず、account defaultをpromoteする", async () => {
    const cfg: AntigravityLaunchConfig = { ...config({ model: "gemini-3.6-flash-low", model_source: "config" }), approval: "on-request" };
    const { host, states, calls } = hostHarness({ config: cfg });
    await host.setModel("");
    expect(host.statusSnapshot()).toMatchObject({ effective: { model: "gemini-3.6-flash-low", model_source: "config" }, pending_model: "" });
    await host.send("switch");
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.args).not.toContain("--model");
    calls[0]!.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    calls[0]!.child.finish();
    await waitFor(() => states.some((envelope) => envelope.state === "done"));
    expect(states.at(-1)).toMatchObject({ ext: { effective: { model: "", model_source: "config" } } });
    host.close();
  });

  it("setModelの失敗はlast-known-goodへrollbackしswitch_errorを一度stampする", async () => {
    const cfg: AntigravityLaunchConfig = { ...config({ model: "gemini-3.6-flash-low", model_source: "config" }), approval: "on-request" };
    const { host, states, calls } = hostHarness({ config: cfg });
    await host.setModel("missing-model");
    await host.send("switch");
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--model", "missing-model"]));
    calls[0]!.child.stdout.write('{"event":"result","result":{"status":"ERROR","error":"unknown model"}}\n');
    calls[0]!.child.finish();
    await waitFor(() => states.some((envelope) => envelope.state === "error"));
    expect(states.find((envelope) => (envelope.ext?.switch_error as { requested?: string } | undefined)?.requested === "missing-model")).toMatchObject({ ext: {
      effective: { model: "gemini-3.6-flash-low", model_source: "config" },
      switch_error: { kind: "model", requested: "missing-model", reason: "turn_failed", rolled_back_to: "gemini-3.6-flash-low" },
    } });
    host.close();
  });

  it("default models probe control-flowの成功時はsnapshotではなく実測catalogをstampする", async () => {
    const states: Envelope[] = [];
    const cfg = config();
    const calls: string[][] = [];
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: (envelope) => states.push(envelope), runtimeAssetsAvailable: () => true,
      modelsProbeSpawn: (_command, args) => {
        calls.push(args);
        const child = new FakeAgy();
        queueMicrotask(() => {
          child.stdout.end(readFileSync(new URL("./fixtures/agy-models.stdout", import.meta.url), "utf8"));
          child.emit("exit", 0, null);
        });
        return child;
      },
    });
    await waitFor(() => states.some((envelope) => (envelope.ext?.models as { value: string }[] | undefined)?.some((model) => model.value === "gemini-3.6-flash-high") === true));
    expect(calls).toEqual([["models"]]);
    host.close();
  });

  it("a live models probe re-applies antigravity_extra_models, not only the pinned snapshot (issue #292)", async () => {
    const states: Envelope[] = [];
    const cfg = {
      ...config(),
      antigravity_extra_models: [
        // Overrides a value the live probe itself returns.
        { value: "claude-sonnet-4-6", display_name: "overridden" },
        // A value absent from both the snapshot and the live probe result.
        { value: "gemini-4-nova", display_name: "Gemini 4 Nova" },
      ],
    };
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: (envelope) => states.push(envelope), runtimeAssetsAvailable: () => true,
      modelsProbeSpawn: () => {
        const child = new FakeAgy();
        queueMicrotask(() => {
          child.stdout.end(readFileSync(new URL("./fixtures/agy-models.stdout", import.meta.url), "utf8"));
          child.emit("exit", 0, null);
        });
        return child;
      },
    });
    await waitFor(() => states.some((envelope) => (envelope.ext?.models as { value: string }[] | undefined)?.some((model) => model.value === "gemini-4-nova") === true));
    const models = states.at(-1)!.ext!.models as { value: string; display_name: string }[];
    expect(models.map((m) => m.value)).toContain("gemini-4-nova");
    expect(models.find((m) => m.value === "claude-sonnet-4-6")?.display_name).toBe("overridden");
    host.close();
  });

  it("QuestionBrokerのpendingはwaiting_questionを駆動しinterruptでcancelする", async () => {
    const states: Envelope[] = [];
    const cfg = config();
    let host: AntigravityHost | undefined;
    const questionBroker = new QuestionBroker({ config: cfg, send: () => {}, onPendingChange: (pending) => host?.setPendingQuestion(pending) });
    host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }), questionBroker,
      onState: (envelope) => states.push(envelope), runtimeAssetsAvailable: () => true,
    });
    const answer = questionBroker.decide([{ question: "continue?", header: "continue", multiSelect: false, options: [{ label: "yes", description: "yes" }, { label: "no", description: "no" }] }]);
    expect(states.at(-1)?.state).toBe("waiting_question");
    await host.interrupt();
    await expect(answer).resolves.toEqual({ cancelled: true });
    expect(states.at(-1)?.state).toBe("tool_running");
    host.close();
  });

  it("interrupt中にgate smokeが完了してもturn childをspawnしない", async () => {
    let resolveProbe!: (value: boolean) => void;
    const probe = new Promise<boolean>((resolve) => { resolveProbe = resolve; });
    const { host, calls } = hostHarness({ verifyGate: () => probe });
    await host.send("hello");
    await host.interrupt();
    resolveProbe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
    host.close();
  });

  it("gate smokeは期限切れでfail-closedになりturn childをspawnしない", async () => {
    const logs: Envelope[] = [];
    const calls: FakeAgy[] = [];
    const cfg = config();
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {}, onLog: (envelope) => logs.push(envelope), runtimeAssetsAvailable: () => true,
      verifyGate: async () => new Promise<boolean>(() => {}), gateProbeTimeoutMs: 5,
      spawn: () => { const child = new FakeAgy(); calls.push(child); return child as unknown as SpawnedAgy; },
    });
    await host.send("hello");
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_not_registered" });
    expect(calls).toHaveLength(0);
    host.close();
  });

  it("pure spawn errorはerror、stdout end、close後にagy_child_errorへ収束する", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.emit("error", new Error("ENOENT"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    const stdoutEnded = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()));
    child.stdout.end();
    await stdoutEnded;
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    child.emit("close", 0, null);
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "agy_child_error: ENOENT" });
    host.close();
  });

  // issue #300 round 3, finding M-B: this host had no per-engine choke
  // point at all -- both error_detail producers (#terminalError below,
  // and the ERROR-status stream result routed through
  // #publishTerminalResult) called makeResult directly with no masking
  // or clipping. The fix moved into makeResult itself
  // (@kaoiro/agent-common's state.ts, unit-tested there directly) since
  // that is the one function every engine's result envelope funnels
  // through unconditionally; these tests confirm antigravity's own two
  // real call sites actually reach it with the right text, end to end.
  it("#publishTerminalResult経由のerror_detailはmaskingされる (issue #300 round 3, finding M-B)", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.stdout.write('{"event":"result","result":{"status":"ERROR","error":"api_key=abcdef123456"}}\n');
    calls[0]!.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({
      is_error: true,
      error_detail: "api_key=********3456",
    });
    host.close();
  });

  it("#terminalError経由のerror_detailはmaskingされる (issue #300 round 3, finding M-B)", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.emit("error", new Error("Authorization: Bearer abcdef123456"));
    const stdoutEnded = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()));
    child.stdout.end();
    await stdoutEnded;
    child.emit("close", 0, null);
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({
      error_detail: "agy_child_error: Authorization: Bearer ********3456",
    });
    host.close();
  });

  it("#publishTerminalResult経由のerror_detailは16KiBにclipされる (issue #300 round 3, finding M-B)", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const oversized = "x".repeat(16_384 + 100);
    calls[0]!.child.stdout.write(`${JSON.stringify({ event: "result", result: { status: "ERROR", error: oversized } })}\n`);
    calls[0]!.child.finish();
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    const detail = logs.find((envelope) => envelope.type === "result")?.payload.error_detail as string;
    expect(Buffer.byteLength(detail, "utf8")).toBe(16_384);
    host.close();
  });
});
