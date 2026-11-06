import "../../../scripts/test/fixtures/test-isolation.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const saved = { ...process.env };
const flag = "KAOIRO_CODEX_OPERATOR_STEER", list = "KAOIRO_CODEX_OPERATOR_STEER_PERSONAS";
afterEach(() => {
  delete process.env[flag];
  delete process.env[list];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
});

interface Legacy { flag?: string; list?: string; fileKey?: boolean; ceiling?: boolean }

async function compose(backend: "app-server", legacy: Legacy = {}, echoed: unknown = null,
  during: (linkOptions: Record<string, any>) => void = () => {}) {
  delete process.env[flag];
  delete process.env[list];
  if (legacy.flag !== undefined) process.env[flag] = legacy.flag;
  if (legacy.list !== undefined) process.env[list] = legacy.list;
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
  let linkOptions!: Record<string, any>;
  let hostOptions!: Record<string, any>;
  const sent: Envelope[] = [];
  const send = vi.fn(async () => {});
  const link = { close: () => {}, currentSessionId: () => null, send: (e: Envelope) => { sent.push(e); },
    operatorInputModes: () => echoed };
  const host = { state: "idle", statusExtSnapshot: () => ({}), send, run: async () => {
    linkOptions.onInstruction("STEER ME", undefined, "early");
    linkOptions.onInstruction("QUEUE ME", undefined, "normal");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    during(linkOptions);
  } };
  await runCodexCli({
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config,
      ...(legacy.ceiling === undefined ? {} : { in_flight_delivery_enabled: legacy.ceiling }),
      ...(legacy.fileKey === undefined ? {} : { operator_steer: legacy.fileKey }) }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      options.deliveryPolicy?.acceptJoin({}, options.deliveryPolicy.beginJoin());
      queueMicrotask(() => { (options.onPersonaPrompt as (prompt: string) => void)("system prompt"); });
      return link as never;
    },
    createHost: (_config, options) => { hostOptions = options as unknown as Record<string, any>; return host as never; },
    prepareStartup: async () => {},
  });
  const warnings = stderr.join("").split("\n").filter(line => line.startsWith("codex: warn - "));
  return { linkOptions, hostOptions, send, sent, warnings, stderr: stderr.join("") };
}

describe("operator steer without an opt-in", () => {
  it("declares operator_input_modes and wires the host for an app-server persona with no legacy input", async () => {
    const on = await compose("app-server", {}, { version: "v1", early: "steer" });
    expect(on.linkOptions.operatorInputModes).toEqual({ version: "v1", early: "steer" });
    expect(on.linkOptions.interAgentDeliveryModes).toEqual({ version: "v1", early: "steer", yield: "none", stage_reports: true });
    expect(on.hostOptions).toHaveProperty("interAgentSteer");
    expect(on.hostOptions.operatorSteer.available()).toBe(true);
    expect(on.hostOptions.permissionSyncPending()).toBe(true);
    expect(on.hostOptions.liveInputBlocked()).toBe(false);
    expect(on.send.mock.calls).toEqual([
      ["STEER ME", undefined, undefined, undefined, { source: "operator", intent: "early" }],
      ["QUEUE ME", undefined, undefined, undefined, { source: "operator", intent: "normal" }],
    ]);
    expect(on.stderr).toContain("codex: operator_steer=on\n");
    expect(on.warnings).toEqual([]);
  });

  it("is not changed by a retired input: a set zero, a list that omits the persona, a false key", async () => {
    for (const legacy of [{ flag: "0" }, { list: "other" }, { fileKey: false }, { flag: "0", list: "other", fileKey: false }]) {
      const on = await compose("app-server", legacy, { version: "v1", early: "steer" });
      expect(on.linkOptions.operatorInputModes, JSON.stringify(legacy)).toEqual({ version: "v1", early: "steer" });
      expect(on.hostOptions.operatorSteer.available(), JSON.stringify(legacy)).toBe(true);
    }
  });

  it("reports unavailability on a join without the echo", async () => {
    const on = await compose("app-server", {}, null, options => {
      options.onOperatorInputModes(false);
      options.onOperatorInputModes(true);
    });
    expect(on.hostOptions.operatorSteer.available()).toBe(false);
    const lines = on.sent.filter(e => e.type === "log" && (e.payload as { kind?: string }).kind === "system")
      .map(e => (e.payload as { text?: string }).text);
    expect(lines).toEqual(["Operator steering is unavailable: the server did not acknowledge operator_input_modes."]);
  });

  it("declares early none and no steering host options under a false ceiling, whatever the legacy inputs", async () => {
    for (const [backend, legacy] of [
      ["app-server", { ceiling: false }], ["app-server", { ceiling: false, flag: "1", list: "p", fileKey: true }],

    ] as const) {
      // The echo is present here: an acknowledged `none` must not wire steering.
      const off = await compose(backend, legacy, { version: "v1", early: "none" });
      const label = `${backend}/${JSON.stringify(legacy)}`;
      expect(off.linkOptions.operatorInputModes, label).toEqual({ version: "v1", early: "none" });
      expect(off.linkOptions, label).not.toHaveProperty("onOperatorInputModes");
      expect(off.hostOptions, label).not.toHaveProperty("operatorSteer");
      expect(off.linkOptions.interAgentDeliveryModes.early, label).toBe("none");
      expect(off.hostOptions, label).not.toHaveProperty("interAgentSteer");
      expect(off.hostOptions, label).not.toHaveProperty("permissionSyncPending");
      expect(off.hostOptions, label).not.toHaveProperty("liveInputBlocked");
    }
  });
});

describe("removed inputs of a directly launched wrapper", () => {
  const secret = "secret-persona-id";
  it.each([
    ["the flag variable", { flag: "0" }, [flag]],
    ["the persona-list variable", { list: secret }, [list]],
    ["a true file key", { fileKey: true }, ["operator_steer"]],
    ["a false file key", { fileKey: false }, ["operator_steer"]],
    ["all three", { flag: "1", list: secret, fileKey: true }, [flag, list, "operator_steer"]],
  ] as const)("ignores obsolete inputs without warning: %s", async (_name, legacy, _names) => {
    const on = await compose("app-server", legacy, { version: "v1", early: "steer" });
    expect(on.warnings).toEqual([]);
    expect(on.hostOptions.operatorSteer.available()).toBe(true);
    expect(on.stderr).not.toContain(secret);
  });

  it("prints nothing for an absent or empty input", async () => {
    expect((await compose("app-server")).warnings).toEqual([]);
    expect((await compose("app-server", { flag: "", list: "" })).warnings).toEqual([]);
  });


});
