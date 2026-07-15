import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { resolveCodexSources } from "../src/source_resolution.js";

const baseConfig: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  server_url: "ws://localhost:4000/wrapper",
};

describe("resolveCodexSources (phase-23 P1 pair-aware, 藤 R3 unit)", () => {
  it("resume 由来 config.model_source (explicit Case 3) を preserve", () => {
    const out = resolveCodexSources(
      { ...baseConfig, model: "gpt-5.6-sol", model_source: "launch" },
      undefined,
    );
    expect(out.modelSource).toBe("launch");
  });

  it("config.model set / model_source なし (Case 4 legacy or fresh spawn) → 'config'", () => {
    const out = resolveCodexSources(
      { ...baseConfig, model: "gpt-5.5" },
      undefined,
    );
    expect(out.modelSource).toBe("config");
  });

  it("config.model なし / env default 有 → 'env'", () => {
    const out = resolveCodexSources(baseConfig, "gpt-5.4-mini");
    expect(out.modelSource).toBe("env");
  });

  it("config.model / env とも無し → undefined (host が default stamp)", () => {
    const out = resolveCodexSources(baseConfig, undefined);
    expect(out.modelSource).toBeUndefined();
  });

  it("config.effort_source (Case 3) を preserve", () => {
    const out = resolveCodexSources(
      { ...baseConfig, effort: "high", effort_source: "launch" },
      undefined,
    );
    expect(out.effortSource).toBe("launch");
  });

  it("config.effort set / effort_source なし → 'config'", () => {
    const out = resolveCodexSources(
      { ...baseConfig, effort: "medium" },
      undefined,
    );
    expect(out.effortSource).toBe("config");
  });

  it("config.effort なし → effortSource undefined", () => {
    const out = resolveCodexSources(baseConfig, undefined);
    expect(out.effortSource).toBeUndefined();
  });

  it("env が model_source を上書きしない (config.model_source が最優先)", () => {
    // Case 3 の pair rule: resume 由来 launch を env 経由の 'env' で上書きしない。
    const out = resolveCodexSources(
      { ...baseConfig, model: "gpt-5.6-sol", model_source: "launch" },
      "gpt-5.4-mini",
    );
    expect(out.modelSource).toBe("launch");
  });
});
