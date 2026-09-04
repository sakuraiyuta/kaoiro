import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { antigravityCatalogSnapshot, catalogFromAgyModels } from "../src/catalog.js";
import { applyAntigravityEnvDefaultModel, applyAntigravitySources, resolveAntigravitySources } from "../src/source_resolution.js";

const config = (): WrapperConfig => ({
  agent_id: "a1",
  persona: { id: "momo", name: "もも", sprite_set: "momo" },
  display_name: "もも",
  server_url: "ws://localhost:4000",
});

describe("Antigravity catalog and source resolution", () => {
  it("1.1.26 snapshotはaccount defaultを先頭にし、model列挙を保持する", () => {
    expect(antigravityCatalogSnapshot().map((model) => model.value)).toEqual([
      "",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(catalogFromAgyModels(["gemini-3.6-flash-low", "gemini-3.6-flash-low", "gpt-oss-120b-medium"]).map((model) => model.value)).toEqual(["", "gemini-3.6-flash-low", "gpt-oss-120b-medium"]);
  });

  it("launch > env > account default のsourceを保持する", () => {
    const launch = { ...config(), model: "gemini-3.6-flash-low" };
    expect(resolveAntigravitySources(launch, "gemini-3.1-pro-high").modelSource).toBe("config");
    const env = config();
    expect(resolveAntigravitySources(env, "gemini-3.1-pro-high").modelSource).toBe("env");
    applyAntigravityEnvDefaultModel(env, "gemini-3.1-pro-high");
    expect(env.model).toBe("gemini-3.1-pro-high");
    expect(env.model_source).toBe("env");
    const configured = { ...config(), model: "gemini-3.6-flash-low", effort: "high" };
    applyAntigravitySources(configured, resolveAntigravitySources(configured, undefined));
    expect(configured).toMatchObject({ model_source: "config", effort_source: "config" });
    expect(resolveAntigravitySources(config(), undefined).modelSource).toBeUndefined();
  });
});
