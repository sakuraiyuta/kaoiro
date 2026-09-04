import { describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { relayAntigravityInstruction, runAntigravityCli } from "../src/cli.js";

function config(): WrapperConfig {
  return {
    agent_id: "a1",
    persona: { id: "momo", name: "Momo", sprite_set: "momo" },
    display_name: "Momo",
    server_url: "ws://localhost:4000",
  };
}

describe("Antigravity CLI", () => {
  it("relays an instruction as one user log before sending it to the host", () => {
    const logs: Envelope[] = [];
    const sent: string[] = [];

    relayAntigravityInstruction(
      config(),
      "waiting_input",
      (envelope) => logs.push(envelope),
      async (text) => { sent.push(text); },
      "Continue with the task.",
      () => "2026-09-05T00:00:00.000Z",
    );

    expect(logs).toEqual([
      expect.objectContaining({
        type: "log",
        state: "waiting_input",
        payload: { kind: "user", text: "Continue with the task." },
      }),
    ]);
    expect(sent).toEqual(["Continue with the task."]);
  });

  it("sends the configured default persona in an initial idle state_change", async () => {
    const defaultConfig: WrapperConfig = {
      ...config(),
      persona: { id: "default", name: "デフォルト", sprite_set: "default" },
      display_name: "デフォルト",
    };
    const envelopes: Envelope[] = [];
    const link = {
      close: () => {},
      send: (envelope: Envelope) => envelopes.push(envelope),
    };
    const host = {
      state: "idle" as const,
      statusExtSnapshot: () => ({
        engine: "antigravity",
        permission: { enforcement: "advisory" },
      }),
      run: async () => {},
    };

    await runAntigravityCli({
      parseCliArgs: () => ({
        configPath: "test",
        prompt: undefined,
        resume: undefined,
      }),
      loadConfig: () => ({ ...defaultConfig }),
      createServerLink: (_url, _agentId, options) => {
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: () => host as never,
    });

    expect(envelopes).toEqual([
      expect.objectContaining({
        type: "state_change",
        state: "idle",
        persona: defaultConfig.persona,
        display_name: defaultConfig.display_name,
        ext: { engine: "antigravity", permission: { enforcement: "advisory" } },
      }),
    ]);
  });
});
