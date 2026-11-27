import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import type { RunnerConfig } from "../src/config.js";
import { extraModelsOptions } from "../src/extra-models-options.js";

const base: RunnerConfig = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/home/user/git/kaoiro"],
};

describe("extraModelsOptions (initial Supervisor construction, cli.ts)", () => {
  it("omits both keys when neither engine declares extra_models", () => {
    expect(extraModelsOptions(base)).toEqual({});
  });

  it("maps codex.extra_models to codexExtraModels", () => {
    const config: RunnerConfig = {
      ...base,
      codex: { extra_models: [{ value: "gpt-6-astra", display_name: "Astra" }] },
    };
    expect(extraModelsOptions(config)).toEqual({
      codexExtraModels: [{ value: "gpt-6-astra", display_name: "Astra" }],
    });
  });

  it("maps antigravity.extra_models to antigravityExtraModels", () => {
    const config: RunnerConfig = {
      ...base,
      antigravity: {
        extra_models: [{ value: "gemini-4-nova", display_name: "Gemini 4 Nova" }],
      },
    };
    expect(extraModelsOptions(config)).toEqual({
      antigravityExtraModels: [
        { value: "gemini-4-nova", display_name: "Gemini 4 Nova" },
      ],
    });
  });

  it("maps both engines' extra_models at once", () => {
    const config: RunnerConfig = {
      ...base,
      codex: { extra_models: [{ value: "gpt-6-astra", display_name: "Astra" }] },
      antigravity: {
        extra_models: [{ value: "gemini-4-nova", display_name: "Gemini 4 Nova" }],
      },
    };
    expect(extraModelsOptions(config)).toEqual({
      codexExtraModels: [{ value: "gpt-6-astra", display_name: "Astra" }],
      antigravityExtraModels: [
        { value: "gemini-4-nova", display_name: "Gemini 4 Nova" },
      ],
    });
  });
});
