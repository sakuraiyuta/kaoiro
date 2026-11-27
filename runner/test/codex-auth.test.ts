import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import {
  CODEX_AUTH_MODE_UNSET_WARNING,
  type AuthModeResolveInput,
  resolveCodexAuthMode,
  shouldWarnUnsetCodexAuthMode,
} from "../src/codex-auth.js";
import { buildRegister, type RunnerConfig } from "../src/config.js";

function baseConfig(codex?: RunnerConfig["codex"]): RunnerConfig {
  return {
    host_id: "codex-auth-test",
    server_url: "ws://runner.invalid/runner",
    cwd_allowlist: ["/tmp"],
    capabilities: ["codex"],
    ...(codex === undefined ? {} : { codex }),
  };
}

describe("resolveCodexAuthMode", () => {
  it("returns unknown when Codex is disabled", async () => {
    expect(
      await resolveCodexAuthMode({
        nextCodex: { auth_mode: "chatgpt", chatgpt_plan: "plus" },
        nextEnabled: false,
      }),
    ).toBe("unknown");
  });

  it.each(["chatgpt", "apikey"] as const)(
    "returns explicit %s verbatim when Codex is enabled",
    async (mode) => {
      expect(
        await resolveCodexAuthMode({
          nextCodex: { auth_mode: mode },
          nextEnabled: true,
        }),
      ).toBe(mode);
    },
  );

  it("returns unknown when auth_mode is unset, without inferring from chatgpt_plan", async () => {
    expect(
      await resolveCodexAuthMode({
        nextCodex: undefined,
        nextEnabled: true,
      }),
    ).toBe("unknown");
    expect(
      await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: true,
      }),
    ).toBe("unknown");
  });
});

describe("shouldWarnUnsetCodexAuthMode", () => {
  it("documents apikey, chatgpt + chatgpt_plan, and standard-catalog scope in the warning text", () => {
    expect(CODEX_AUTH_MODE_UNSET_WARNING).toContain("runner: warn — ");
    expect(CODEX_AUTH_MODE_UNSET_WARNING).toContain("codex.auth_mode");
    expect(CODEX_AUTH_MODE_UNSET_WARNING).toContain("standard Codex model catalog is empty");
    expect(CODEX_AUTH_MODE_UNSET_WARNING).toContain('"apikey"');
    expect(CODEX_AUTH_MODE_UNSET_WARNING).toContain('"chatgpt"');
    expect(CODEX_AUTH_MODE_UNSET_WARNING).toContain("codex.chatgpt_plan");
  });

  it.each<[string, AuthModeResolveInput, boolean]>([
    [
      "Codex disabled on startup",
      { nextCodex: undefined, nextEnabled: false },
      false,
    ],
    [
      "enabled and unset on startup",
      { nextCodex: undefined, nextEnabled: true },
      true,
    ],
    [
      "enabled and unset with chatgpt_plan on startup",
      { nextCodex: { chatgpt_plan: "plus" as const }, nextEnabled: true },
      true,
    ],
    [
      "explicit apikey on startup",
      { nextCodex: { auth_mode: "apikey" as const }, nextEnabled: true },
      false,
    ],
  ])("%s", (_label, input, expected) => {
    expect(shouldWarnUnsetCodexAuthMode(input)).toBe(expected);
  });
});

describe("buildRegister with resolved codexAuthMode", () => {
  const codexModels = (config: RunnerConfig, mode: "chatgpt" | "apikey" | "unknown") =>
    buildRegister(config, undefined, mode).engines?.find((e) => e.id === "codex")
      ?.models ?? [];

  it("keeps extra_models when auth_mode is unset (unknown) while standard catalog is empty", () => {
    const extra = [{ value: "custom-model", display_name: "Custom" }];
    expect(codexModels(baseConfig(), "unknown")).toEqual([]);
    expect(codexModels(baseConfig({ extra_models: extra }), "unknown")).toEqual(
      extra,
    );
  });

  it("advertises standard catalog for apikey and for chatgpt with chatgpt_plan, but empty for chatgpt without plan", () => {
    expect(codexModels(baseConfig({ auth_mode: "apikey" }), "apikey").length).toBeGreaterThan(0);
    expect(codexModels(baseConfig({ auth_mode: "chatgpt" }), "chatgpt")).toEqual([]);
    expect(
      codexModels(
        baseConfig({ auth_mode: "chatgpt", chatgpt_plan: "plus" }),
        "chatgpt",
      ).length,
    ).toBeGreaterThan(0);
  });
});
