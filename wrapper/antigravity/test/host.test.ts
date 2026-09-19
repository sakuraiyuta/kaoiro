import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionBroker, QuestionBroker, classifyInterAgentError, type Envelope, type InterAgentErrorClassifyInput, type WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, initialStatusExt, isGateRegistered, type AntigravityHostOptions, type GateProbe, type SpawnedAgy } from "../src/host.js";
import { AntigravityGate, GateServer, type AntigravityLaunchConfig } from "../src/gate.js";
import { ToolHost } from "../src/toolhost.js";
import type { PermissionSyncMessage } from "@kaoiro/protocol";

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

async function waitForDefaultChild(
  predicate: () => boolean,
  diagnostic: () => Record<string, unknown>,
): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for default child: ${JSON.stringify(diagnostic())}`);
}

function hostHarness(options: {
  resumeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  verifyGate?: boolean | (() => Promise<boolean>);
  config?: WrapperConfig;
  now?: () => string;
  onTurnEnd?: AntigravityHostOptions["onTurnEnd"];
  onToolStart?: AntigravityHostOptions["onToolStart"];
  onToolEnd?: AntigravityHostOptions["onToolEnd"];
  permissionSyncSupported?: boolean;
  waitForPermissionSync?: () => Promise<void>;
  toolHostListen?: AntigravityHostOptions["toolHostListen"];
  gateServerListen?: AntigravityHostOptions["gateServerListen"];
} = {}) {
  const states: Envelope[] = [];
  const logs: Envelope[] = [];
  const permissionLifecycle: unknown[] = [];
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeAgy }[] = [];
  const turnEnds: Array<Parameters<NonNullable<AntigravityHostOptions["onTurnEnd"]>>[0]> = [];
  const interruptRequests: Array<Parameters<NonNullable<AntigravityHostOptions["onInterruptRequested"]>>[0]> = [];
  const interruptSettlements: Array<Parameters<NonNullable<AntigravityHostOptions["onInterruptSettled"]>>[0]> = [];
  const sendRejections: Array<Parameters<NonNullable<AntigravityHostOptions["onSendRejected"]>>[0]> = [];
  const cfg = options.config ?? config();
  const broker = new PermissionBroker({ config: cfg, send: () => {} });
  const host = new AntigravityHost(cfg, {
    cwd: process.cwd(),
    appendSystemPrompt: "persona",
    permissionBroker: broker,
    onState: (envelope) => states.push(envelope),
    onLog: (envelope) => logs.push(envelope),
    onPermissionLifecycle: (event) => permissionLifecycle.push(event),
    runtimeAssetsAvailable: () => true,
    verifyGate: async () => typeof options.verifyGate === "function" ? options.verifyGate() : options.verifyGate ?? true,
    ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
    ...(options.dangerouslySkipPermissions === undefined ? {} : { dangerouslySkipPermissions: options.dangerouslySkipPermissions }),
    agyPath: "/test/agy",
    ...(options.now === undefined ? {} : { now: options.now }),
    onTurnEnd: (info) => {
      turnEnds.push(info);
      options.onTurnEnd?.(info);
    },
    ...(options.onToolStart === undefined ? {} : { onToolStart: options.onToolStart }),
    ...(options.onToolEnd === undefined ? {} : { onToolEnd: options.onToolEnd }),
    ...(options.permissionSyncSupported === undefined ? {} : { permissionSyncSupported: options.permissionSyncSupported }),
    ...(options.waitForPermissionSync === undefined ? {} : { waitForPermissionSync: options.waitForPermissionSync }),
    ...(options.toolHostListen === undefined ? {} : { toolHostListen: options.toolHostListen }),
    ...(options.gateServerListen === undefined ? {} : { gateServerListen: options.gateServerListen }),
    onInterruptRequested: (info) => interruptRequests.push(info),
    onInterruptSettled: (info) => interruptSettlements.push(info),
    onSendRejected: (info) => sendRejections.push(info),
    spawn: (command, args, spawnOptions) => {
      const child = new FakeAgy();
      calls.push({ command, args, env: spawnOptions.env, child });
      return child as unknown as SpawnedAgy;
    },
  });
  return { host, states, logs, calls, permissionLifecycle, turnEnds, interruptRequests, interruptSettlements, sendRejections };
}

describe("AntigravityHost", () => {
  it("starts an inter-agent turn only after the agy child is spawned and preserves its token through completion", async () => {
    const cfg = config();
    const calls: FakeAgy[] = [];
    const starts: string[] = [];
    const ends: Array<{ token: string; conversationIds: readonly string[] }> = [];
    let host!: AntigravityHost;
    host = new AntigravityHost(cfg, {
      cwd: process.cwd(),
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      runtimeAssetsAvailable: () => true,
      verifyGate: async () => true,
      agyPath: "/test/agy",
      spawn: () => {
        const child = new FakeAgy();
        calls.push(child);
        return child as unknown as SpawnedAgy;
      },
      onTurnStart: ({ turnToken, conversationIds }) => {
        expect(calls).toHaveLength(1);
        expect(host.activeInterAgentTurnToken()).toBe(turnToken);
        expect(conversationIds).toEqual(["cid-1"]);
        starts.push(turnToken);
      },
      onTurnEnd: ({ turnToken, conversationIds }) => ends.push({ token: turnToken, conversationIds }),
    });

    await host.send("inbound", undefined, ["cid-1"], "turn-1");
    await waitFor(() => starts.length === 1);
    calls[0]!.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
    calls[0]!.finish();
    await waitFor(() => ends.length === 1);

    expect(starts).toEqual(["turn-1"]);
    expect(ends).toEqual([{ token: "turn-1", conversationIds: ["cid-1"] }]);
    expect(host.activeInterAgentTurnToken()).toBeNull();
    host.close();
  });

  it("set_permission rejects when no ceiling is advertised (legacy runner, no max_*)", async () => {
    const { host } = hostHarness();
    await expect(
      host.setPermission({
        revision: 1,
        requested: { sandbox: "workspace-write", network_access: true, approval: "local" },
      }),
    ).rejects.toThrow("not advertised");
    host.close();
  });

  it("stages an in-ceiling switch, applies config at the boundary, and confirms applied only at engine init (issue #359, M4)", async () => {
    const cfg = config({
      approval: "on-request",
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    // Fresh spawn (no resumeSessionId): #sessionId starts null, so a fabricated
    // token would show up as the observation session_id if M4 regressed.
    const { host, states, permissionLifecycle, calls } = hostHarness({ config: cfg });
    await host.setPermission({
      revision: 2,
      requested: { sandbox: "workspace-write", network_access: false, approval: "local" },
    });
    // Pending control echoed; the running gate's cell is untouched, so
    // ext.permission still shows the pre-switch approval.
    const pending = states.at(-1)?.ext?.permission_control as unknown as Record<string, unknown>;
    expect(pending.status).toBe("pending");
    expect((pending.requested as Record<string, unknown>).approval).toBe("local");
    expect((states.at(-1)?.ext?.permission as Record<string, unknown>).approval).toBe(
      "on-request",
    );
    expect(permissionLifecycle).toHaveLength(0);

    void host.send("hello");
    // Config applies at the boundary -> control is `applying`, but no applied
    // observation is fabricated before the engine confirms the session id.
    await waitFor(() => {
      const c = states.at(-1)?.ext?.permission_control as unknown as
        | Record<string, unknown>
        | undefined;
      return c?.status === "applying";
    });
    expect(permissionLifecycle).toHaveLength(0);
    await waitFor(() => calls.length === 1);

    // The engine's init event confirms the session identity; only now does the
    // switch promote to `applied` with an engine-observed session_id.
    calls[0]!.child.stdout.write(
      '{"event":"init","conversation_id":"engine-sess-42","init":{"tools":[]}}\n',
    );
    await waitFor(() => permissionLifecycle.length === 1);
    const applied = permissionLifecycle[0] as Record<string, any>;
    expect(applied.kind).toBe("permission_applied");
    expect(applied.details.permission.approval).toBe("local");
    expect(applied.details.permission.enforcement).toBe("advisory");
    expect(applied.details.session_id).toBe("engine-sess-42");
    // turn_id is OMITTED — antigravity has no engine per-turn identity and
    // manufacturing one from the session id or a wrapper token is forbidden
    // (issue #359 M1, protocol.md "engine-observed identities").
    expect(applied.details).not.toHaveProperty("turn_id");
    // execution_id is the wrapper's own per-exec correlation id, distinct from
    // the engine session identity (protocol.md).
    expect(applied.details.execution_id).not.toBe("engine-sess-42");
    const appliedControl = states.at(-1)?.ext?.permission_control as unknown as Record<string, unknown>;
    expect(appliedControl.status).toBe("applied");
    host.close();
  });

  it("set_permission rejects an over-ceiling switch fail-closed with rolled_back_to (issue #359)", async () => {
    const cfg = config({
      approval: "on-request",
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    const { host, states, permissionLifecycle } = hostHarness({ config: cfg });
    await host.setPermission({
      revision: 3,
      requested: { sandbox: "workspace-write", network_access: false, approval: "never" },
    });
    expect(permissionLifecycle).toHaveLength(1);
    const failed = permissionLifecycle[0] as Record<string, any>;
    expect(failed.kind).toBe("permission_failed");
    expect(failed.details.reason).toBe("exceeds_launch_ceiling");
    expect(failed.details.rolled_back_to.approval).toBe("on-request");
    const control = states.at(-1)?.ext?.permission_control as unknown as Record<string, unknown>;
    expect(control.status).toBe("failed");
    expect((control.rolled_back_to as Record<string, unknown>).approval).toBe("on-request");
    // The effective cell is unchanged (no config mutation on a rejected switch).
    expect((states.at(-1)?.ext?.permission as Record<string, unknown>).approval).toBe(
      "on-request",
    );
    host.close();
  });

  it("advertises permission_switch_axes and supports_permission_switch when max_* is present and permission_sync is negotiated (issue #359 M1)", () => {
    const ext = initialStatusExt(
      config({
        max_sandbox: "workspace-write",
        max_approval: "local",
        max_network_access: false,
      }),
      undefined,
      true,
    );
    const caps = ext.session_capabilities as Record<string, unknown>;
    expect(caps.supports_permission_switch).toBe(true);
    expect(caps.permission_switch_axes).toEqual({
      sandbox: { max: "workspace-write" },
      network_access: { max: false },
      approval: { max: "local" },
    });
  });

  it("gates the selector on negotiation: max_* present but permission_sync NOT negotiated advertises nothing (issue #359 M1)", () => {
    const ext = initialStatusExt(
      config({
        max_sandbox: "workspace-write",
        max_approval: "local",
        max_network_access: false,
      }),
      undefined,
      false,
    );
    const caps = ext.session_capabilities as Record<string, unknown>;
    expect(caps).not.toHaveProperty("permission_switch_axes");
    expect(caps).not.toHaveProperty("supports_permission_switch");
  });

  it("omits permission_switch_axes when the runner relayed no ceiling (legacy)", () => {
    const ext = initialStatusExt(config(), undefined, true);
    const caps = ext.session_capabilities as Record<string, unknown>;
    expect(caps).not.toHaveProperty("permission_switch_axes");
    expect(caps).not.toHaveProperty("supports_permission_switch");
  });

  it("seeds a revision-0 baseline control when permission_sync is negotiated so the server can allocate revisions (issue #359 M1)", () => {
    const cfg = config({
      approval: "on-request",
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    const { host } = hostHarness({ config: cfg, permissionSyncSupported: true });
    const ext = host.statusExtSnapshot();
    expect((ext.session_capabilities as Record<string, unknown>).supports_permission_switch).toBe(
      true,
    );
    const ctrl = ext.permission_control as Record<string, unknown>;
    expect(ctrl.revision).toBe(0);
    expect(ctrl.status).toBe("pending");
    expect(ctrl.requested).toEqual({
      sandbox: "workspace-write",
      network_access: false,
      approval: "on-request",
    });
    // A baseline carries no submitted / effective evidence yet.
    expect(ctrl).not.toHaveProperty("submitted");
    expect(ctrl).not.toHaveProperty("effective");
    host.close();
  });

  it("advertises nothing and seeds no baseline when permission_sync was not negotiated (issue #359 M1)", () => {
    const cfg = config({
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    const { host } = hostHarness({ config: cfg, permissionSyncSupported: false });
    const ext = host.statusExtSnapshot();
    expect(ext).not.toHaveProperty("permission_control");
    expect(ext.session_capabilities as Record<string, unknown>).not.toHaveProperty(
      "supports_permission_switch",
    );
    host.close();
  });

  it("applyPermissionSync re-applies the durable next to config and adopts the control on reconnect (issue #359 M1)", () => {
    // Permissive ceiling so the durable next (a previously accepted switch) passes
    // the wrapper's final gate.
    const cfg = config({
      approval: "on-request",
      max_sandbox: "danger-full-access",
      max_approval: "never",
      max_network_access: true,
    });
    const { host } = hostHarness({ config: cfg, permissionSyncSupported: true });
    const nextCell = {
      sandbox: "danger-full-access" as const,
      network_access: true,
      approval: "never" as const,
    };
    const submission = { revision: 2, requested: nextCell, execution_id: "exec-2" };
    // A durable effective observation with turn_id OMITTED (antigravity).
    const effective = {
      ...submission,
      session_id: "sess-old",
      permission: { sandbox: "danger-full-access" as const, approval: "never" as const, enforcement: "advisory" as const },
      network_access: true,
    };
    const message: PermissionSyncMessage = {
      version: "0",
      control: {
        revision: 2,
        requested: nextCell,
        status: "applied",
        constraints: { approval: "never", enforcement: "advisory" },
        submitted: submission,
        effective,
        last_effective: effective,
      },
      next: { revision: 2, requested: nextCell },
    };
    host.applyPermissionSync(message);
    const ext = host.statusExtSnapshot();
    // The next-turn gate reads the re-applied cell.
    expect((ext.permission as Record<string, unknown>).sandbox).toBe("danger-full-access");
    expect((ext.permission as Record<string, unknown>).approval).toBe("never");
    const ctrl = ext.permission_control as Record<string, unknown>;
    expect(ctrl.revision).toBe(2);
    expect(ctrl.status).toBe("applied");
    host.close();
  });

  it("applyPermissionSync refuses an over-ceiling next fail-closed: failed + rolled_back_to, no config change (issue #359 M7)", () => {
    // Restrictive ceiling: a relayed next above it must NOT mutate config — the
    // wrapper is the final gate and the server can never widen past launch. It
    // reports failed with the SAME semantics as a live set_permission.
    const cfg = config({
      approval: "on-request",
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    const { host, permissionLifecycle } = hostHarness({ config: cfg, permissionSyncSupported: true });
    const overCell = {
      sandbox: "danger-full-access" as const,
      network_access: true,
      approval: "never" as const,
    };
    const message: PermissionSyncMessage = {
      version: "0",
      control: {
        revision: 5,
        requested: overCell,
        status: "pending",
        constraints: { approval: "local", enforcement: "advisory" },
      },
      next: { revision: 5, requested: overCell },
    };
    host.applyPermissionSync(message);
    const ext = host.statusExtSnapshot();
    // Config unchanged: the launch cell still governs the next gate.
    expect((ext.permission as Record<string, unknown>).sandbox).toBe("workspace-write");
    expect((ext.permission as Record<string, unknown>).approval).toBe("on-request");
    // Reported failed against the current cell, not left as a pending over-cell.
    const ctrl = ext.permission_control as Record<string, unknown>;
    expect(ctrl.status).toBe("failed");
    expect(ctrl.reason).toBe("exceeds_launch_ceiling");
    expect((ctrl.rolled_back_to as Record<string, unknown>).sandbox).toBe("workspace-write");
    expect((ctrl.rolled_back_to as Record<string, unknown>).approval).toBe("on-request");
    const failed = permissionLifecycle.at(-1) as Record<string, any>;
    expect(failed.kind).toBe("permission_failed");
    expect(failed.details.reason).toBe("exceeds_launch_ceiling");
    expect(failed.details.rolled_back_to.sandbox).toBe("workspace-write");
    host.close();
  });

  it("applyPermissionSync does not adopt an over-ceiling control's forged applied evidence (issue #359 M7)", () => {
    // A malicious/buggy server could relay an over-ceiling control claiming
    // status:applied with a forged effective. The ceiling check runs BEFORE any
    // adoption, so neither the effective nor last_effective is taken up.
    const cfg = config({
      approval: "on-request",
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    const { host, permissionLifecycle } = hostHarness({ config: cfg, permissionSyncSupported: true });
    const overCell = {
      sandbox: "danger-full-access" as const,
      network_access: true,
      approval: "never" as const,
    };
    const submission = { revision: 5, requested: overCell, execution_id: "e5" };
    const forgedEffective = {
      ...submission,
      session_id: "s5",
      permission: { sandbox: "danger-full-access" as const, approval: "never" as const, enforcement: "advisory" as const },
      network_access: true,
    };
    const message: PermissionSyncMessage = {
      version: "0",
      control: {
        revision: 5,
        requested: overCell,
        status: "applied",
        constraints: { approval: "never", enforcement: "advisory" },
        submitted: submission,
        effective: forgedEffective,
        last_effective: forgedEffective,
      },
      next: { revision: 5, requested: overCell },
    };
    host.applyPermissionSync(message);
    const ext = host.statusExtSnapshot();
    // Config stays at launch; the forged applied control is reported failed and
    // its evidence is not adopted.
    expect((ext.permission as Record<string, unknown>).sandbox).toBe("workspace-write");
    const ctrl = ext.permission_control as Record<string, unknown>;
    expect(ctrl.status).toBe("failed");
    expect(ctrl).not.toHaveProperty("effective");
    expect(ctrl).not.toHaveProperty("last_effective");
    const failed = permissionLifecycle.at(-1) as Record<string, any>;
    expect(failed.kind).toBe("permission_failed");
    host.close();
  });

  it("blocks a turn's gate until the permission_sync barrier resolves (issue #359 M1)", async () => {
    const cfg = config({
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const { host, calls } = hostHarness({
      config: cfg,
      permissionSyncSupported: true,
      waitForPermissionSync: () => barrier,
    });
    void host.send("hello");
    // While the barrier is pending, the gate is not built and no child is spawned.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls.length).toBe(0);
    releaseBarrier();
    await waitFor(() => calls.length === 1);
    host.close();
  });

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

  it("verifier control-flowは明示したtest executableでprobeをspawnする", async () => {
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
          child.emit("close", 0, null);
        });
        return child as unknown as GateProbe;
      },
      agyPath: "/test/agy",
      spawn: (command, args) => { const child = new FakeAgy(); calls.push({ command, args, child }); return child as unknown as SpawnedAgy; },
    });
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.finish();
    host.close();
  });

  it("waits for exit, remaining stdout, and close before accepting hook registration", async () => {
    const cfg = config();
    const probe = new FakeAgy();
    const calls: FakeAgy[] = [];
    let hookSource = "";
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {}, runtimeAssetsAvailable: () => true, agyPath: "/test/agy",
      probeModels: async () => null,
      probeSpawn: (_command, args) => {
        hookSource = join(args[args.lastIndexOf("--add-dir") + 1]!, ".agents", "hooks.json");
        return probe as unknown as GateProbe;
      },
      spawn: () => {
        const child = new FakeAgy();
        calls.push(child);
        return child as unknown as SpawnedAgy;
      },
    });
    await host.send("hello");
    await waitFor(() => hookSource !== "");
    probe.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toHaveLength(0);
    const command = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    probe.stdout.end(JSON.stringify({ hooks: [{ source: hookSource, actions: [{ event: "PreToolUse", matcher: "*", command, timeout_seconds: 3600 }] }] }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toHaveLength(0);
    probe.emit("close", 0, null);
    await waitFor(() => calls.length === 1);
    calls[0]!.finish();
    host.close();
  });

  it("uses one configured executable for models, hook verification, and the turn child", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-host-"));
    const executable = join(root, "agy with spaces");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const cfg = config({ antigravity_cli_path: executable, antigravity_probe_timeout_ms: 45_000 });
    const commands: string[] = [];
    try {
      const host = new AntigravityHost(cfg, {
        cwd: process.cwd(), appendSystemPrompt: "persona",
        permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
        onState: () => {}, runtimeAssetsAvailable: () => true,
        modelsProbeSpawn: (command) => {
          commands.push(command);
          const child = new FakeAgy();
          queueMicrotask(() => {
            child.stdout.end("gemini-3.6-flash-high\tGemini 3.6 Flash High\n");
            child.emit("exit", 0, null);
          });
          return child as unknown as GateProbe;
        },
        probeSpawn: (command, args) => {
          commands.push(command);
          const child = new FakeAgy();
          const source = join(args[args.lastIndexOf("--add-dir") + 1]!, ".agents", "hooks.json");
          const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
          queueMicrotask(() => {
            child.stdout.end(JSON.stringify({ hooks: [{ source, actions: [{ event: "PreToolUse", matcher: "*", command: hook, timeout_seconds: 3600 }] }] }));
            child.emit("close", 0, null);
          });
          return child as unknown as GateProbe;
        },
        spawn: (command) => {
          commands.push(command);
          const child = new FakeAgy();
          queueMicrotask(() => child.finish());
          return child as unknown as SpawnedAgy;
        },
      });
      await waitFor(() => commands.length >= 1);
      await host.send("hello");
      await waitFor(() => commands.length === 3);
      expect(commands).toEqual([executable, executable, executable]);
      host.close();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses the configured executable through default child processes for models, hooks, and a turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaoiro-agy-default-host-"));
    const executable = join(root, "agy fixture with spaces.mjs");
    const hook = `${process.execPath} ${new URL("../dist/hook.js", import.meta.url).pathname}`;
    writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("fixture-model\\tFixture Model\\n");
} else if (args[0] === "-p" && args[1] === "/hooks") {
  const customization = args[args.lastIndexOf("--add-dir") + 1];
  process.stdout.write(JSON.stringify({ hooks: [{ source: customization + "/.agents/hooks.json", actions: [{ event: "PreToolUse", matcher: "*", command: ${JSON.stringify(hook)}, timeout_seconds: 3600 }] }] }));
} else if (args[0] === "--print") {
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "fixture turn" } }) + "\\n");
} else {
  process.exitCode = 2;
}
`);
    chmodSync(executable, 0o755);
    const cfg = config({ antigravity_cli_path: executable });
    const logs: Envelope[] = [];
    const host = new AntigravityHost(cfg, {
      cwd: root,
      appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {},
      onLog: (envelope) => logs.push(envelope),
    });
    try {
      await waitForDefaultChild(() => (
        (host.statusExtSnapshot().models as { value: string }[])
          .some((model) => model.value === "fixture-model")
      ), () => ({ status: host.statusExtSnapshot(), logs }));
      await host.send("hello");
      await waitForDefaultChild(
        () => logs.some((envelope) => envelope.type === "result"),
        () => ({ status: host.statusExtSnapshot(), logs }),
      );
      expect(logs.at(-1)?.payload).toMatchObject({ text: "fixture turn" });
    } finally {
      host.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not spawn a turn when the configured executable is unavailable", async () => {
    const cfg = config({ antigravity_cli_path: "/definitely/not/agy" });
    const logs: Envelope[] = [];
    let turnSpawns = 0;
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {}, onLog: (envelope) => logs.push(envelope), runtimeAssetsAvailable: () => true,
      spawn: () => {
        turnSpawns += 1;
        return new FakeAgy() as unknown as SpawnedAgy;
      },
    });
    await host.send("hello");
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(turnSpawns).toBe(0);
    expect(logs.at(-1)?.payload).toMatchObject({ error_detail: "antigravity_cli_unavailable:executable_missing" });
    host.close();
  });

  it("F2のspawn引数、closed stdin、init session idとresultを結ぶ", async () => {
    const { host, states, logs, calls } = hostHarness();
    const sessionIds: string[] = [];
    const onSessionHost = new AntigravityHost(config(), {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: config(), send: () => {} }),
      onState: (envelope) => states.push(envelope), onLog: (envelope) => logs.push(envelope), onSessionId: (id) => sessionIds.push(id),
      verifyGate: async () => true, runtimeAssetsAvailable: () => true,
      agyPath: "/test/agy",
      spawn: (command, args, spawnOptions) => { const child = new FakeAgy(); calls.push({ command, args, env: spawnOptions.env, child }); return child as unknown as SpawnedAgy; },
    });
    await onSessionHost.send("hello");
    await waitFor(() => calls.length === 1);
    const call = calls[0]!;
    expect(call.command).toBe("/test/agy");
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

  it("maps quota exhaustion to a peer error and seven_day snapshot until success", async () => {
    const turnErrors: Array<InterAgentErrorClassifyInput | undefined> = [];
    const now = "2026-09-17T00:00:00.000Z";
    const { host, states, calls } = hostHarness({
      now: () => now,
      onTurnEnd: ({ error }) => turnErrors.push(error),
    });
    await host.send("quota", undefined, ["cid"], "turn-quota");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.stdout.write(`${JSON.stringify({
      event: "result",
      result: {
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 148h49m28s.",
      },
    })}\n`);
    calls[0]!.child.finish();
    await waitFor(() => turnErrors.length === 1);
    const expected = {
      seven_day: {
        status: "blocked",
        utilization: 1,
        resets_at: Math.floor(Date.parse(now) / 1_000) + 535_768,
      },
    };
    expect(turnErrors).toEqual([{
      reason: "blocking_limit",
      rateLimitResetSeconds: 535_768,
    }]);
    expect(classifyInterAgentError(turnErrors[0]!)).toEqual({
      code: "rate_limit",
      message: "the peer hit a rate limit; Resets in 148h49m28s",
    });
    expect(states.at(-1)?.ext?.rate_limits).toEqual(expected);
    expect(host.statusSnapshot().rate_limits).toEqual(expected);

    await host.send("recovered", undefined, ["cid"], "turn-success");
    await waitFor(() => calls.length === 2);
    calls[1]!.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
    calls[1]!.child.finish();
    await waitFor(() => turnErrors.length === 2);
    expect(turnErrors[1]).toBeUndefined();
    expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
    expect(states.at(-1)?.ext).not.toHaveProperty("rate_limits");
    host.close();
  });

  it("keeps an unrecognized terminal error on the api_error fallback", async () => {
    const turnErrors: Array<InterAgentErrorClassifyInput | undefined> = [];
    const { host, calls } = hostHarness({
      onTurnEnd: ({ error }) => turnErrors.push(error),
    });
    await host.send("failure", undefined, ["cid"], "turn-failure");
    await waitFor(() => calls.length === 1);
    calls[0]!.child.stdout.write('{"event":"result","result":{"status":"ERROR","error":"HTTP 500 backend unavailable"}}\n');
    calls[0]!.child.finish();
    await waitFor(() => turnErrors.length === 1);
    expect(turnErrors).toEqual([{ detail: "antigravity turn failed" }]);
    expect(classifyInterAgentError(turnErrors[0]!)).toEqual({
      code: "api_error",
      message: "the peer reported an unspecified error",
    });
    expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
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

  it("models probe control-flowの成功時はsnapshotではなく実測catalogをstampする", async () => {
    const states: Envelope[] = [];
    const cfg = config();
    const calls: string[][] = [];
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona", permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: (envelope) => states.push(envelope), runtimeAssetsAvailable: () => true,
      agyPath: "/test/agy",
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
      agyPath: "/test/agy",
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
      agyPath: "/test/agy", verifyGate: async () => new Promise<boolean>(() => {}), gateProbeTimeoutMs: 5,
      spawn: () => { const child = new FakeAgy(); calls.push(child); return child as unknown as SpawnedAgy; },
    });
    await host.send("hello");
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_gate_not_registered:timeout" });
    expect(calls).toHaveLength(0);
    host.close();
  });

  it.each([
    ["nonzero exit", (child: FakeAgy) => {
      child.stderr.end("permission denied");
      child.stdout.end("{}");
      child.emit("close", 1, null);
    }, "antigravity_gate_not_registered:nonzero_exit:permission denied"],
    ["invalid JSON", (child: FakeAgy) => {
      child.stdout.end("{");
      child.emit("close", 0, null);
    }, "antigravity_gate_not_registered:invalid_json"],
    ["registration mismatch", (child: FakeAgy) => {
      child.stdout.end(JSON.stringify({ hooks: [] }));
      child.emit("close", 0, null);
    }, "antigravity_gate_not_registered:registration_mismatch"],
    ["probe error", (child: FakeAgy) => child.emit("error", new Error("EACCES")), "antigravity_gate_not_registered:spawn_failure:EACCES"],
  ] as const)("gate probe %s is classified and fail-closed", async (_name, finishProbe, errorDetail) => {
    const cfg = config();
    const logs: Envelope[] = [];
    let turnSpawns = 0;
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {}, onLog: (envelope) => logs.push(envelope), runtimeAssetsAvailable: () => true,
      agyPath: "/test/agy", probeModels: async () => null,
      probeSpawn: () => {
        const child = new FakeAgy();
        queueMicrotask(() => finishProbe(child));
        return child as unknown as GateProbe;
      },
      spawn: () => {
        turnSpawns += 1;
        return new FakeAgy() as unknown as SpawnedAgy;
      },
    });
    await host.send("hello");
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(turnSpawns).toBe(0);
    expect(logs.at(-1)?.payload).toMatchObject({ error_detail: errorDetail });
    host.close();
  });

  it("settles a timeout, probe error, and close race once without spawning a turn", async () => {
    const cfg = config();
    const logs: Envelope[] = [];
    const probe = new FakeAgy();
    let turnSpawns = 0;
    const host = new AntigravityHost(cfg, {
      cwd: process.cwd(), appendSystemPrompt: "persona",
      permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
      onState: () => {}, onLog: (envelope) => logs.push(envelope), runtimeAssetsAvailable: () => true,
      agyPath: "/test/agy", probeModels: async () => null, gateProbeTimeoutMs: 5,
      probeSpawn: () => probe as unknown as GateProbe,
      spawn: () => {
        turnSpawns += 1;
        return new FakeAgy() as unknown as SpawnedAgy;
      },
    });
    await host.send("hello");
    await waitFor(() => probe.killed === "SIGTERM");
    probe.emit("error", new Error("late EACCES"));
    probe.stdout.end("{}");
    probe.emit("close", 0, null);
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.filter((envelope) => envelope.type === "result")).toHaveLength(1);
    expect(logs.at(-1)?.payload).toMatchObject({ error_detail: "antigravity_gate_not_registered:timeout" });
    expect(turnSpawns).toBe(0);
    host.close();
  });

  it("pure spawn errorはerror、stdout end、close後にagy_child_errorへ収束する", async () => {
    const { host, logs, calls } = hostHarness();
    await host.send("hello");
    await waitFor(() => calls.length === 1);
    const child = calls[0]!.child;
    child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    const stdoutEnded = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()));
    child.stdout.end();
    await stdoutEnded;
    expect(logs).not.toContainEqual(expect.objectContaining({ type: "result" }));
    child.emit("close", 0, null);
    await waitFor(() => logs.some((envelope) => envelope.type === "result"));
    expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({ error_detail: "antigravity_cli_executable_missing: ENOENT" });
    expect(logs.filter((envelope) => envelope.type === "result")).toHaveLength(1);
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
      error_detail: "antigravity_cli_spawn_failure: Authorization: ***************3456",
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

  describe("issue #371 interrupt settlement", () => {
    it("settles to waiting_input, once, when interrupted while ToolHost.listen is pending (no spawn)", async () => {
      let resolveListen!: (value: ToolHost) => void;
      const pending = new Promise<ToolHost>((resolve) => { resolveListen = resolve; });
      const { host, states, calls, turnEnds, interruptRequests, interruptSettlements } = hostHarness({
        toolHostListen: () => pending,
      });
      await host.send("hello");
      await host.interrupt();
      const real = await ToolHost.listen([]);
      resolveListen(real);
      await waitFor(() => turnEnds.length === 1);
      expect(calls).toHaveLength(0);
      expect(states.at(-1)?.state).toBe("waiting_input");
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]!.error).toEqual({ reason: "interrupted" });
      expect(turnEnds[0]!.cancellation).toEqual({ kind: "interrupt", reason: "interrupted" });
      expect(interruptRequests).toHaveLength(1);
      expect(interruptSettlements).toHaveLength(1);
      real.close();
      host.close();
    });

    it("does not leak a prior turn's exit code/signal into onInterruptSettled when this turn's child never spawned (review finding)", async () => {
      let resolveSync!: () => void;
      const pending = new Promise<void>((resolve) => { resolveSync = resolve; });
      let gate = false;
      const { host, calls, turnEnds, interruptSettlements } = hostHarness({
        waitForPermissionSync: () => (gate ? pending : Promise.resolve()),
      });
      // Turn 1 runs a real child to completion with a real exit code.
      await host.send("hello", undefined, [], "turn-1");
      await waitFor(() => calls.length === 1);
      calls[0]!.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      calls[0]!.child.finish();
      await waitFor(() => turnEnds.length === 1);
      // Turn 2 is interrupted before its own child ever spawns.
      gate = true;
      await host.send("world", undefined, [], "turn-2");
      await host.interrupt();
      resolveSync();
      await waitFor(() => turnEnds.length === 2);
      expect(calls).toHaveLength(1);
      expect(interruptSettlements).toHaveLength(1);
      expect(interruptSettlements[0]).toMatchObject({ turnToken: "turn-2", exitCode: null, signal: null });
      host.close();
    });

    it("settles to waiting_input, once, when interrupted while waitForPermissionSync is pending (no spawn)", async () => {
      let resolveSync!: () => void;
      const pending = new Promise<void>((resolve) => { resolveSync = resolve; });
      const { host, states, calls, turnEnds, interruptSettlements } = hostHarness({
        waitForPermissionSync: () => pending,
      });
      await host.send("hello");
      await host.interrupt();
      resolveSync();
      await waitFor(() => turnEnds.length === 1);
      expect(calls).toHaveLength(0);
      expect(states.at(-1)?.state).toBe("waiting_input");
      expect(turnEnds[0]!.error).toEqual({ reason: "interrupted" });
      expect(turnEnds[0]!.cancellation).toEqual({ kind: "interrupt", reason: "interrupted" });
      expect(interruptSettlements).toHaveLength(1);
      host.close();
    });

    it("settles to waiting_input, once, when interrupted while GateServer.listen is pending (no spawn)", async () => {
      let resolveListen!: (value: GateServer) => void;
      const pending = new Promise<GateServer>((resolve) => { resolveListen = resolve; });
      const { host, states, calls, turnEnds, interruptSettlements } = hostHarness({
        gateServerListen: () => pending,
      });
      await host.send("hello");
      await host.interrupt();
      const real = await GateServer.listen({ gate: new AntigravityGate({
        config: config(),
        cwd: process.cwd(),
        customizationDir: process.cwd(),
        nodePath: process.execPath,
        bridgePath: "/test/bridge.js",
        toolNames: () => new Set(),
        broker: new PermissionBroker({ config: config(), send: () => {} }),
      }) });
      resolveListen(real);
      await waitFor(() => turnEnds.length === 1);
      expect(calls).toHaveLength(0);
      expect(states.at(-1)?.state).toBe("waiting_input");
      expect(turnEnds[0]!.error).toEqual({ reason: "interrupted" });
      expect(turnEnds[0]!.cancellation).toEqual({ kind: "interrupt", reason: "interrupted" });
      expect(interruptSettlements).toHaveLength(1);
      real.close();
      host.close();
    });

    it("settles to waiting_input, once, when interrupted while gate registration verification is pending (no spawn)", async () => {
      let resolveProbe!: (value: boolean) => void;
      const probe = new Promise<boolean>((resolve) => { resolveProbe = resolve; });
      const { host, states, calls, turnEnds, interruptSettlements } = hostHarness({ verifyGate: () => probe });
      await host.send("hello");
      await host.interrupt();
      resolveProbe(true);
      await waitFor(() => turnEnds.length === 1);
      expect(calls).toHaveLength(0);
      expect(states.at(-1)?.state).toBe("waiting_input");
      expect(turnEnds[0]!.error).toEqual({ reason: "interrupted" });
      expect(turnEnds[0]!.cancellation).toEqual({ kind: "interrupt", reason: "interrupted" });
      expect(interruptSettlements).toHaveLength(1);
      host.close();
    });

    it("settles to waiting_input, once, when interrupted mid-tool-execution, and the next queued turn runs", async () => {
      const { host, states, calls, turnEnds, interruptSettlements } = hostHarness();
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      calls[0]!.child.stdout.write('{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}\n');
      await waitFor(() => states.at(-1)?.state === "tool_running");
      void host.send("queued while interrupting", undefined, [], "turn-2");
      await host.interrupt();
      calls[0]!.child.stdout.end();
      calls[0]!.child.emit("close", null, "SIGTERM");
      await waitFor(() => turnEnds.length === 1);
      expect(states.find((s) => s.state === "waiting_input")).toBeDefined();
      expect(turnEnds[0]!.error).toEqual({ reason: "interrupted" });
      expect(turnEnds[0]!.cancellation).toEqual({ kind: "interrupt", reason: "interrupted" });
      expect(interruptSettlements).toHaveLength(1);
      expect(interruptSettlements[0]).toMatchObject({ signal: "SIGTERM" });
      // The queued turn (issue #358) runs under the new generation.
      await waitFor(() => calls.length === 2);
      host.close();
    });

    it("an idle interrupt records nothing, and the next send starts a turn normally", async () => {
      const { host, calls, turnEnds, interruptRequests, interruptSettlements } = hostHarness();
      await host.interrupt();
      expect(interruptRequests).toHaveLength(0);
      expect(interruptSettlements).toHaveLength(0);
      expect(turnEnds).toHaveLength(0);
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      calls[0]!.child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      calls[0]!.child.finish();
      await waitFor(() => turnEnds.length === 1);
      expect(turnEnds[0]!.error).toBeUndefined();
      expect(turnEnds[0]!.cancellation).toBeUndefined();
      host.close();
    });

    it("close() racing a pending waitForPermissionSync keeps pre-#371 termination semantics: no synthetic result, no interrupt lifecycle, no queue resume (design addendum)", async () => {
      let resolveSync!: () => void;
      const pending = new Promise<void>((resolve) => { resolveSync = resolve; });
      const { host, calls, turnEnds, interruptRequests, interruptSettlements } = hostHarness({
        waitForPermissionSync: () => pending,
      });
      await host.send("hello", undefined, [], "turn-1");
      void host.send("queued before close", undefined, [], "turn-2");
      host.close();
      resolveSync();
      await waitFor(() => turnEnds.length === 1);
      expect(calls).toHaveLength(0);
      expect(turnEnds[0]!.error).toBeUndefined();
      expect(turnEnds[0]!.cancellation).toBeUndefined();
      expect(interruptRequests).toHaveLength(0);
      expect(interruptSettlements).toHaveLength(0);
      // The host is closed: #drainTurns's own top-of-function guard
      // withholds the queued turn regardless of this invariant.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(0);
    });

    it("a watchdog fail-stop racing a pending gate registration verification keeps pre-#371 termination semantics (design addendum)", async () => {
      let resolveProbe!: (value: boolean) => void;
      const probe = new Promise<boolean>((resolve) => { resolveProbe = resolve; });
      const { host, calls, turnEnds, interruptSettlements } = hostHarness({ verifyGate: () => probe });
      await host.send("hello");
      host.failStopForWatchdogAttributionUnknown();
      resolveProbe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // `#watchdogFailStopped` suppresses `#drainTurns`'s onTurnEnd entirely
      // for the active turn (the existing, unmodified guard at the top of
      // this block) — `onWatchdogFailStop` is that path's own notification.
      expect(calls).toHaveLength(0);
      expect(turnEnds).toHaveLength(0);
      expect(interruptSettlements).toHaveLength(0);
    });

    it("operator interrupt settles exactly once and the next queued turn runs under the new generation (design addendum pin)", async () => {
      let resolveSync!: () => void;
      const pending = new Promise<void>((resolve) => { resolveSync = resolve; });
      const { host, calls, turnEnds, interruptSettlements } = hostHarness({
        waitForPermissionSync: () => pending,
      });
      await host.send("hello", undefined, [], "turn-1");
      void host.send("queued while interrupting", undefined, [], "turn-2");
      await host.interrupt();
      resolveSync();
      await waitFor(() => turnEnds.length === 1);
      expect(interruptSettlements).toHaveLength(1);
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]!.cancellation).toEqual({ kind: "interrupt", reason: "interrupted" });
      await waitFor(() => calls.length === 1);
      host.close();
    });

    it("close() after interrupt() but before the turn settles suppresses the synthetic result too (normal-admission gate)", async () => {
      let resolveSync!: () => void;
      const pending = new Promise<void>((resolve) => { resolveSync = resolve; });
      const { host, calls, turnEnds, interruptSettlements } = hostHarness({
        waitForPermissionSync: () => pending,
      });
      await host.send("hello", undefined, [], "turn-1");
      await host.interrupt();
      host.close();
      resolveSync();
      await waitFor(() => turnEnds.length === 1);
      expect(calls).toHaveLength(0);
      // interrupt()'s record matched this turn, but close() moved the host
      // out of normal admission before settlement -- the synthetic
      // "interrupted" result must not fire even though the record matched.
      expect(turnEnds[0]!.error).toBeUndefined();
      expect(turnEnds[0]!.cancellation).toBeUndefined();
      expect(interruptSettlements).toHaveLength(0);
    });

    it("a watchdog fail-stop after interrupt() but before the turn settles also suppresses the synthetic result (kuroe review, turn 10)", async () => {
      // `normalAdmission` checks only `!this.#closed`, not
      // `!this.#watchdogFailStopped`, because the WHOLE settlement
      // invariant already sits inside `if (!this.#watchdogFailStopped)`
      // (unchanged pre-#371 code) -- once fail-stop sets that flag, this
      // entire block is skipped regardless of what interrupt() recorded
      // first, synchronously and with no `await` in between, so there is
      // no window where a fail-stop could land mid-invariant. This test
      // pins that guarantee directly rather than leaving it as reasoning
      // about the surrounding `if`.
      let resolveSync!: () => void;
      const pending = new Promise<void>((resolve) => { resolveSync = resolve; });
      const { host, calls, turnEnds, interruptSettlements } = hostHarness({
        waitForPermissionSync: () => pending,
      });
      await host.send("hello", undefined, [], "turn-1");
      await host.interrupt();
      host.failStopForWatchdogAttributionUnknown();
      resolveSync();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // `#watchdogFailStopped` suppresses `#drainTurns`'s onTurnEnd
      // entirely for the active turn -- `onWatchdogFailStop` is that
      // path's own notification, not exercised here.
      expect(calls).toHaveLength(0);
      expect(turnEnds).toHaveLength(0);
      expect(interruptSettlements).toHaveLength(0);
    });

    it("a settlement for an unrelated reason after interrupt is not misreported as interrupted (regression guard)", async () => {
      // Same scenario as "interrupt後でもturn後customization改ざんをfail-stopにする"
      // above, extended to assert the new fields this issue adds.
      const { host, logs, calls, turnEnds, interruptSettlements } = hostHarness();
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      const customizationDir = calls[0]!.args.at(-1)!;
      writeFileSync(join(customizationDir, ".agents", "rules", "AGENTS.md"), "tampered");
      await host.interrupt();
      calls[0]!.child.finish();
      await waitFor(() => logs.some((envelope) => envelope.type === "result"));
      await waitFor(() => turnEnds.length === 1);
      expect(turnEnds[0]!.error).toEqual({ detail: "antigravity_customization_tampered" });
      expect(turnEnds[0]!.cancellation).toBeUndefined();
      expect(interruptSettlements).toHaveLength(0);
      host.close();
    });

    it("send() on a closed host reports onSendRejected without starting a turn", async () => {
      const { host, calls, sendRejections } = hostHarness();
      host.close();
      await host.send("hello", undefined, [], "turn-1");
      expect(calls).toHaveLength(0);
      expect(sendRejections).toEqual([{ turnToken: "turn-1", reason: "closed" }]);
    });

    it("send() on a watchdog-fail-stopped host reports onSendRejected without starting a turn", async () => {
      const { host, calls, sendRejections } = hostHarness();
      host.failStopForWatchdogAttributionUnknown();
      await host.send("hello");
      expect(calls).toHaveLength(0);
      expect(sendRejections).toEqual([{ reason: "watchdog_fail_stopped" }]);
      host.close();
    });

    it("send() on a gate-broken host reports onSendRejected without starting a turn", async () => {
      const { host, logs, calls, sendRejections } = hostHarness();
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      const customizationDir = calls[0]!.args.at(-1)!;
      writeFileSync(join(customizationDir, ".agents", "rules", "AGENTS.md"), "tampered");
      calls[0]!.child.finish();
      await waitFor(() => logs.some((envelope) => envelope.type === "result"));
      await host.send("must not start", undefined, [], "turn-2");
      expect(calls).toHaveLength(1);
      expect(sendRejections).toEqual([{ turnToken: "turn-2", reason: "gate_broken" }]);
      host.close();
    });
  });

  describe("tool prompts and deadlines (issue #350)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("spawns agy with git/ssh prompts disabled and stdin closed", async () => {
      vi.stubEnv("GIT_SSH_COMMAND", "");
      const { host, calls } = hostHarness();
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      expect(calls[0]!.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      });
      expect(calls[0]!.child.stdin.writableEnded).toBe(true);
      host.close();
    });

    it("keeps an operator GIT_SSH_COMMAND while still disabling the other prompts", async () => {
      vi.stubEnv("GIT_SSH_COMMAND", "/opt/wrap-ssh --audit");
      const { host, calls } = hostHarness();
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      expect(calls[0]!.env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_SSH_COMMAND: "/opt/wrap-ssh --audit",
      });
      host.close();
    });

    it("reports tool ACTIVE and DONE by step index to the watchdog callbacks", async () => {
      const starts: unknown[] = [];
      const ends: unknown[] = [];
      const { host, calls, logs } = hostHarness({
        onToolStart: (info) => starts.push(info),
        onToolEnd: (info) => ends.push(info),
      });
      await host.send("hello", undefined, ["cid-1"], "turn-1");
      await waitFor(() => calls.length === 1);
      const child = calls[0]!.child;
      child.stdout.write('{"event":"init","conversation_id":"cid","init":{"tools":["call_mcp_tool"]}}\n');
      child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{}}}}\n');
      child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{}}}}\n');
      child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","output":"ok"}}}\n');
      child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      child.finish();
      await waitFor(() => logs.some((envelope) => envelope.type === "result"));
      expect(starts).toEqual([
        { turnToken: "turn-1", stepIndex: 2, toolName: "call_mcp_tool" },
        { turnToken: "turn-1", stepIndex: 2, toolName: "call_mcp_tool" },
      ]);
      expect(ends).toEqual([{ turnToken: "turn-1", stepIndex: 2 }]);
      expect(child.killed).toBeUndefined();
      host.close();
    });

    it("overrides the CLI terminal result with tool_timeout after a watchdog tool deadline", async () => {
      const ends: Array<{ error?: InterAgentErrorClassifyInput }> = [];
      const cfg = config();
      const states: Envelope[] = [];
      const logs: Envelope[] = [];
      const calls: FakeAgy[] = [];
      const host = new AntigravityHost(cfg, {
        cwd: process.cwd(), appendSystemPrompt: "persona",
        permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
        onState: (envelope) => states.push(envelope), onLog: (envelope) => logs.push(envelope),
        runtimeAssetsAvailable: () => true, verifyGate: async () => true, agyPath: "/test/agy",
        onTurnEnd: (info) => ends.push(info),
        spawn: () => { const child = new FakeAgy(); calls.push(child); return child as unknown as SpawnedAgy; },
      });
      await host.send("hello", undefined, ["cid-1"], "turn-1");
      await waitFor(() => calls.length === 1);
      const child = calls[0]!;
      child.stdout.write('{"event":"init","conversation_id":"cid","init":{"tools":["run_command"]}}\n');
      child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"git fetch origin"}}}}\n');
      expect(host.requestInterruptForTurn("turn-1", {
        kind: "tool_timeout", stepIndex: 2, toolName: "run_command", elapsedMs: 600_004, toolTimeoutMs: 600_000,
      })).toBe(true);
      expect(child.killed).toBe("SIGTERM");
      // Whatever agy prints on the way out is not the turn outcome.
      child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"still running"}}\n');
      child.finish();
      await waitFor(() => ends.length === 1);
      expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({
        is_error: true, error_subtype: "error_during_execution", error_detail: "tool_timeout",
      });
      expect(states.map((envelope) => envelope.state).slice(-2)).toEqual(["error", "waiting_input"]);
      expect(ends[0]!.error).toEqual({ reason: "timeout" });
      expect(classifyInterAgentError(ends[0]!.error!)).toMatchObject({ code: "timeout" });
      // The next turn starts clean: no leftover cause.
      await host.send("again", undefined, ["cid-2"], "turn-2");
      await waitFor(() => calls.length === 2);
      calls[1]!.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"fine"}}\n');
      calls[1]!.finish();
      await waitFor(() => ends.length === 2);
      expect(ends[1]!.error).toBeUndefined();
      host.close();
    });

    it.each([
      ["tool_name and tool_info.name disagree", '{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"view_file"}}', "run_command"],
      ["step_index is unsafe", '{"step_index":"x","state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command"}}', "run_command"],
      ["no name at all", '{"step_index":2,"state":"ACTIVE","step_type":"tool"}', "unknown"],
    ])("fails closed on an ACTIVE tool the deadline cannot key on (%s)", async (_label, step, failure) => {
      const starts: unknown[] = [];
      const { host, logs, calls } = hostHarness({ onToolStart: (info) => starts.push(info) });
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      const child = calls[0]!.child;
      child.stdout.write('{"event":"init","conversation_id":"cid","init":{"tools":["run_command"]}}\n');
      child.stdout.write(`{"event":"step_update","step_update":${step}}\n`);
      await waitFor(() => child.killed === "SIGTERM");
      child.finish();
      await waitFor(() => logs.some((envelope) => envelope.type === "result"));
      expect(starts).toEqual([]);
      expect(logs.find((envelope) => envelope.type === "result")?.payload).toMatchObject({
        is_error: true, error_detail: `antigravity_gate_unobserved_tool:${failure}`,
      });
      host.close();
    });

    it("synthesizes a turn token for an operator instruction so the watchdog can bound it", async () => {
      const starts: Array<{ turnToken: string; conversationIds: readonly string[] }> = [];
      const toolStarts: string[] = [];
      const ends: string[] = [];
      const cfg = config();
      const calls: FakeAgy[] = [];
      let host!: AntigravityHost;
      host = new AntigravityHost(cfg, {
        cwd: process.cwd(), appendSystemPrompt: "persona",
        permissionBroker: new PermissionBroker({ config: cfg, send: () => {} }),
        onState: () => {}, runtimeAssetsAvailable: () => true, verifyGate: async () => true, agyPath: "/test/agy",
        onTurnStart: (info) => {
          starts.push(info);
          expect(host.activeInterAgentTurnToken()).toBe(info.turnToken);
        },
        onToolStart: ({ turnToken }) => toolStarts.push(turnToken),
        onTurnEnd: ({ turnToken }) => ends.push(turnToken),
        spawn: () => { const child = new FakeAgy(); calls.push(child); return child as unknown as SpawnedAgy; },
      });
      await host.send("hello");
      await waitFor(() => calls.length === 1);
      calls[0]!.stdout.write('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command"}}}\n');
      calls[0]!.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      calls[0]!.finish();
      await waitFor(() => ends.length === 1);
      expect(starts).toEqual([{ turnToken: expect.stringMatching(/^[0-9a-f-]{36}$/), conversationIds: [] }]);
      expect(toolStarts).toEqual([starts[0]!.turnToken]);
      expect(ends).toEqual([starts[0]!.turnToken]);
      expect(host.activeInterAgentTurnToken()).toBeNull();
      host.close();
    });

    it("ignores a tool timeout request for a token that is not the active turn", async () => {
      const { host, calls } = hostHarness();
      await host.send("hello", undefined, ["cid-1"], "turn-1");
      await waitFor(() => calls.length === 1);
      expect(host.requestInterruptForTurn("turn-other", {
        kind: "tool_timeout", stepIndex: 1, toolName: "run_command", elapsedMs: 1, toolTimeoutMs: 1,
      })).toBe(false);
      expect(calls[0]!.child.killed).toBeUndefined();
      host.close();
    });
  });
});
