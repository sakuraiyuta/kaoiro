import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { runAntigravityCli } from "../src/cli.js";
import {
  TOOL_TIMEOUT_ENV,
  resolveTurnWatchdogSettings,
} from "../src/turn_watchdog.js";

const EPOCH_IDLE_MS_ENV = "KAOIRO_ANTIGRAVITY_EPOCH_IDLE_MS";

describe("antigravity.epoch_idle_ms (accepted and ignored)", () => {
  it("starts with the setting in the config and the variable, and reports neither", async () => {
    const previous = process.env[EPOCH_IDLE_MS_ENV];
    // Below the old reader's floor, so a wrapper that still read it would throw.
    process.env[EPOCH_IDLE_MS_ENV] = "999";
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const config: WrapperConfig = {
      agent_id: "a1",
      persona: { id: "momo", name: "Momo", sprite_set: "momo" },
      display_name: "Momo",
      server_url: "ws://localhost:4000",
      antigravity_epoch_idle_ms: 3000,
    };
    const host = {
      state: "idle" as const,
      abortGraceMs: 60_000,
      statusExtSnapshot: () => ({ engine: "antigravity" }),
      run: async () => {},
    };
    try {
      await runAntigravityCli({
        parseCliArgs: () => ({ configPath: "test" }),
        loadConfig: () => config,
        createServerLink: (_url, _agentId, options) => {
          queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
          return { close: () => {}, send: () => {} } as never;
        },
        createHost: () => host as never,
      });
      // Both settings lines were captured, so their silence about the epoch is
      // an observation.
      expect(lines.filter((line) => line.includes("tool_timeout_ms="))).toHaveLength(2);
      expect(lines.filter((line) => line.includes("epoch"))).toEqual([]);
    } finally {
      stderr.mockRestore();
      if (previous === undefined) delete process.env[EPOCH_IDLE_MS_ENV];
      else process.env[EPOCH_IDLE_MS_ENV] = previous;
    }
  });
});

describe("tool timeout setting (issue #469)", () => {
  it("selects the config field, then the variable, then the default, with its source", () => {
    const sourceOf = (env: Record<string, string>, config?: number) =>
      resolveTurnWatchdogSettings(
        env,
        () => {},
        config === undefined ? undefined : { antigravity_tool_timeout_ms: config },
      );
    expect(sourceOf({}).settings.toolTimeoutMs).toBe(600_000);
    expect(sourceOf({}).sources.toolTimeoutMs).toBe("default");
    expect(sourceOf({ [TOOL_TIMEOUT_ENV]: "2000" }).settings.toolTimeoutMs).toBe(2000);
    expect(sourceOf({ [TOOL_TIMEOUT_ENV]: "2000" }).sources.toolTimeoutMs).toBe("env");
    const withConfig = sourceOf({ [TOOL_TIMEOUT_ENV]: "2000" }, 3000);
    expect(withConfig.settings.toolTimeoutMs).toBe(3000);
    expect(withConfig.sources.toolTimeoutMs).toBe("config");
  });
});
