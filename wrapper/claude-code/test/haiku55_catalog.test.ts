import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { AgentHost } from "../src/host.js";
import { projectModel } from "../src/probe.js";

const bytes = readFileSync(new URL("./fixtures/claude-agent-sdk-0.3.293.models.json", import.meta.url));
const sdkModels = JSON.parse(bytes.toString("utf8")) as ModelInfo[];
const catalog = sdkModels.flatMap(model => {
  const projected = projectModel(model);
  return projected === null ? [] : [projected];
});
const levels = ["low", "medium", "high", "xhigh", "max"] as const;
const config: WrapperConfig = {
  agent_id: "test.haiku55",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
  claude_engine_catalog: catalog,
};

function pinnedHost(model: string): AgentHost {
  return new AgentHost(config, {
    onState: () => {},
    modelSource: "config",
    queryOptions: { model },
  });
}

describe("SDK 0.3.293 captured Haiku catalog", () => {
  it("preserves the measured alias, legacy row and canonical-only join", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "637abfa8a2467d3e39c5eb5284ae0fc52b0b1e02d733d80da956fbc7747f3642",
    );
    expect(sdkModels).toHaveLength(13);
    expect(sdkModels.find(model => model.value === "haiku")).toMatchObject({
      resolvedModel: "claude-haiku-5-5",
      supportsEffort: true,
      supportedEffortLevels: levels,
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    });
    expect(sdkModels.some(model => model.value === "claude-haiku-5-5")).toBe(false);
    expect(catalog.find(model => model.value === "claude-haiku-4-5-20251001"))
      .toMatchObject({ resolved_model: "claude-haiku-4-5-20251001" });
  });

  it.each(["haiku", "claude-haiku-5-5"])("retains %s and accepts all five effort levels", async model => {
    const host = pinnedHost(model);
    try {
      await host.setModel(model);
      expect(host.statusExtSnapshot()).toMatchObject({
        model, model_source: "config",
        effective: { model, model_source: "config" },
        session_capabilities: { supports_effort_switch: true },
      });
      expect(host.statusExtSnapshot()).not.toHaveProperty("engine_fallback_model");
      for (const level of levels) {
        await expect(host.setEffort(level)).resolves.toBeUndefined();
        expect(host.statusExtSnapshot()).toMatchObject({ effort: level, effort_source: "config" });
      }
    } finally {
      host.close();
    }
  });

  it("retains the old canonical pin and rejects every effort level", async () => {
    const model = "claude-haiku-4-5-20251001";
    const host = pinnedHost(model);
    try {
      await host.setModel(model);
      expect(host.statusExtSnapshot()).toMatchObject({
        model, model_source: "config",
        session_capabilities: { supports_effort_switch: false },
      });
      for (const level of levels) {
        await expect(host.setEffort(level)).rejects.toThrow("effort_level_unsupported");
      }
    } finally {
      host.close();
    }
  });

  it("rejects a made-up canonical model instead of accepting a family prefix", async () => {
    const host = pinnedHost("haiku");
    try {
      await expect(host.setModel("claude-haiku-5-5-invented")).rejects.toThrow();
      expect(host.statusExtSnapshot().model).toBe("haiku");
    } finally {
      host.close();
    }
  });
});
