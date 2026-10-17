import { describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runClaudeCli } from "../src/cli.js";
import type { AgentHostOptions } from "../src/host.js";
import {
  NATIVE_CONTINUATIONS_ENV,
  resolveNativeContinuations,
} from "../src/native_continuations_setting.js";

const config: WrapperConfig = {
  agent_id: "self.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

const warning = (value: string) =>
  `[kaoiro] KAOIRO_CLAUDE_NATIVE_CONTINUATIONS=${JSON.stringify(value)} is neither ` +
  `0 nor 1; using the default (native continuations on)\n`;

describe("native continuation startup selection (issue #426)", () => {
  it.each([
    { name: "unset", value: undefined, on: true },
    { name: "1", value: "1", on: true },
    { name: "0", value: "0", on: false },
  ] as const)("selects $on for $name without a warning", ({ value, on }) => {
    const warnings: string[] = [];
    const env = value === undefined ? {} : { [NATIVE_CONTINUATIONS_ENV]: value };
    expect(resolveNativeContinuations(env, message => warnings.push(message))).toBe(on);
    expect(warnings).toEqual([]);
  });

  it.each(["", "true", "yes", "off", "false", " 0", "0 ", "00", "2", "0\n[kaoiro] forged", "\u001b[31m0"])(
    "keeps the default on for %j and warns once",
    value => {
      const warnings: string[] = [];
      expect(resolveNativeContinuations({ [NATIVE_CONTINUATIONS_ENV]: value }, message => warnings.push(message)))
        .toBe(true);
      expect(warnings).toEqual([warning(value)]);
      expect(warnings[0]!.indexOf("\n")).toBe(warnings[0]!.length - 1);
      expect(warnings[0]).not.toContain("\u001b");
    },
  );

  it.each([
    { name: "unset", value: undefined, on: true, warned: false },
    { name: "0", value: "0", on: false, warned: false },
    { name: "1", value: "1", on: true, warned: false },
    { name: "an unknown value", value: "off", on: true, warned: true },
  ] as const)("hands the CLI host the selection for $name", async ({ value, on, warned }) => {
    vi.stubEnv(NATIVE_CONTINUATIONS_ENV, value);
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    let hostOptions: AgentHostOptions | undefined;
    try {
      await runClaudeCli({
        parseCliArgs: () => ({ configPath: "test", prompt: undefined, resume: undefined }),
        loadConfig: () => ({ ...config }),
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return { close: () => {}, currentSessionId: () => null, send: () => {} } as never;
        },
        createHost: (_cfg, options) => {
          hostOptions = options;
          return { state: "idle", statusExtSnapshot: () => ({}), run: async () => {} } as never;
        },
      });
      expect(hostOptions?.nativeContinuations).toBe(on);
      expect(hostOptions?.nativeReplyBasis !== undefined).toBe(on);
      const lines = writes.filter(line => line.includes(NATIVE_CONTINUATIONS_ENV));
      expect(lines).toEqual(warned ? [warning(value!)] : []);
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
