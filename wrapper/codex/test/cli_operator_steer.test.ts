import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { operatorSteerSource, runCodexCli } from "../src/cli.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const saved = { ...process.env };
afterEach(() => {
  delete process.env.KAOIRO_CODEX_OPERATOR_STEER;
  delete process.env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS;
  Object.assign(process.env, saved);
});

async function compose(backend: "exec" | "app-server", optIn: boolean, echoed: unknown = null,
  during: (linkOptions: Record<string, any>) => void = () => {}) {
  delete process.env.KAOIRO_CODEX_OPERATOR_STEER;
  if (optIn) process.env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS = "other, p";
  else delete process.env.KAOIRO_CODEX_OPERATOR_STEER_PERSONAS;
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
    backend,
    parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
    loadConfig: () => ({ ...config }),
    createServerLink: (_url, _agentId, options) => {
      linkOptions = options as unknown as Record<string, any>;
      queueMicrotask(() => { (options.onPersonaPrompt as (prompt: string) => void)("system prompt"); });
      return link as never;
    },
    createHost: (_config, options) => { hostOptions = options as unknown as Record<string, any>; return host as never; },
    prepareStartup: async () => {},
  });
  return { linkOptions, hostOptions, send, sent };
}

describe("operator steer opt-in", () => {
  it("parses the flag and persona list like the Claude phase-2 flag", () => {
    expect(operatorSteerSource("p", "1", undefined)).toBe("flag");
    expect(operatorSteerSource("p", undefined, "a, p")).toBe("persona_list");
    expect(operatorSteerSource("p", undefined, "a,b")).toBe("off");
    expect(operatorSteerSource("p", undefined, "p,bad id")).toBe("off");
    expect(operatorSteerSource("p", "0", undefined)).toBe("off");
  });

  it("declares operator_input_modes and wires the host only for an opted-in app-server persona", async () => {
    const on = await compose("app-server", true, { version: "v1", early: "steer" });
    expect(on.linkOptions.operatorInputModes).toEqual({ version: "v1", early: "steer" });
    expect(on.linkOptions.interAgentDeliveryModes).toEqual({ version: "v1", early: "none", yield: "none", stage_reports: true });
    expect(on.hostOptions.operatorSteer.available()).toBe(true);
    expect(on.hostOptions.permissionSyncPending()).toBe(true);
    expect(on.hostOptions.liveInputBlocked()).toBe(false);
    expect(on.send.mock.calls).toEqual([
      ["STEER ME", undefined, undefined, undefined, { source: "operator", intent: "early" }],
      ["QUEUE ME", undefined, undefined, undefined, { source: "operator", intent: "normal" }],
    ]);
  });

  it("reports unavailability on a join without the echo", async () => {
    const on = await compose("app-server", true, null, options => {
      options.onOperatorInputModes(false);
      options.onOperatorInputModes(true);
    });
    expect(on.hostOptions.operatorSteer.available()).toBe(false);
    const lines = on.sent.filter(e => e.type === "log" && (e.payload as { kind?: string }).kind === "system")
      .map(e => (e.payload as { text?: string }).text);
    expect(lines).toEqual(["Operator steering is unavailable: the server did not acknowledge operator_input_modes."]);
  });

  it("leaves the exec and opted-out compositions without any steer surface", async () => {
    for (const [backend, optIn] of [["exec", true], ["app-server", false], ["exec", false]] as const) {
      const off = await compose(backend, optIn);
      expect(off.linkOptions, `${backend}/${optIn}`).not.toHaveProperty("operatorInputModes");
      expect(off.linkOptions).not.toHaveProperty("onOperatorInputModes");
      expect(off.hostOptions).not.toHaveProperty("operatorSteer");
      expect(off.hostOptions).not.toHaveProperty("permissionSyncPending");
      expect(off.hostOptions).not.toHaveProperty("liveInputBlocked");
    }
  });
});
