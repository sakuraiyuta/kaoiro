import { describe, expect, it } from "vitest";
import type { RunnerConfig } from "../src/config.js";
import {
  extraModelsOptions,
  extraModelsRuntimeUpdate,
} from "../src/extra-models-options.js";

// issue #292 SF-2: cli.ts's config -> Supervisor mapping for
// `codex.extra_models` / `antigravity.extra_models` was previously inline
// at both the initial-construction and reload call sites, with no test
// exercising the mapping itself -- every prior test injected the
// Supervisor's `codexExtraModels` field directly, so dropping the mapper
// line in cli.ts would have stayed green. cli.ts itself cannot be imported
// from a test (it runs `main()` unconditionally as the process entry
// point), so the mapping lives in its own module (extra-models-options.ts)
// that cli.ts imports and this test imports identically -- pinning the
// SAME function production actually calls, not a re-implementation.

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

describe("extraModelsRuntimeUpdate (config hot-reload, cli.ts)", () => {
  it("keeps both keys present with undefined when neither engine declares extra_models", () => {
    expect(extraModelsRuntimeUpdate(base)).toEqual({
      codexExtraModels: undefined,
      antigravityExtraModels: undefined,
    });
  });

  it("maps codex.extra_models to codexExtraModels", () => {
    const config: RunnerConfig = {
      ...base,
      codex: { extra_models: [{ value: "gpt-6-astra", display_name: "Astra" }] },
    };
    expect(extraModelsRuntimeUpdate(config)).toEqual({
      codexExtraModels: [{ value: "gpt-6-astra", display_name: "Astra" }],
      antigravityExtraModels: undefined,
    });
  });

  it("maps antigravity.extra_models to antigravityExtraModels", () => {
    const config: RunnerConfig = {
      ...base,
      antigravity: {
        extra_models: [{ value: "gemini-4-nova", display_name: "Gemini 4 Nova" }],
      },
    };
    expect(extraModelsRuntimeUpdate(config)).toEqual({
      codexExtraModels: undefined,
      antigravityExtraModels: [
        { value: "gemini-4-nova", display_name: "Gemini 4 Nova" },
      ],
    });
  });
});
