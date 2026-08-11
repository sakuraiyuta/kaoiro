import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { resolveClaudeSources } from "../src/source_resolution.js";
import { CLAUDE_EFFORT_LEVELS } from "../src/host.js";

const baseConfig: WrapperConfig = {
  agent_id: "test.agent",
  persona: { id: "p", name: "P", sprite_set: "p" },
  display_name: "P",
  server_url: "ws://localhost:4000/wrapper",
};

describe("resolveClaudeSources (phase-23 P1 pair-aware, 藤 R3 unit)", () => {
  describe("model source priority", () => {
    it("resume 由来 config.model_source (Case 3) を preserve", () => {
      const out = resolveClaudeSources(
        { ...baseConfig, model: "opus[1m]", model_source: "launch" },
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.modelSource).toBe("launch");
    });

    it("config.model set / model_source なし → 'config' fallback", () => {
      const out = resolveClaudeSources(
        { ...baseConfig, model: "sonnet" },
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.modelSource).toBe("config");
    });

    it("config.model なし / env default 有 → 'env'", () => {
      const out = resolveClaudeSources(
        baseConfig,
        "default",
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.modelSource).toBe("env");
    });

    it("config.model / env とも無し → undefined (host が default stamp)", () => {
      const out = resolveClaudeSources(
        baseConfig,
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.modelSource).toBeUndefined();
    });

    it("config.model_source は env と competition しても最優先 (Case 3 preserve invariant)", () => {
      const out = resolveClaudeSources(
        { ...baseConfig, model: "opus[1m]", model_source: "launch" },
        "sonnet",
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.modelSource).toBe("launch");
    });
  });

  describe("effort catalog filter + pair drop", () => {
    it("valid effort + effort_source (Case 3) を preserve", () => {
      const out = resolveClaudeSources(
        { ...baseConfig, effort: "high", effort_source: "launch" },
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.effort).toBe("high");
      expect(out.effortSource).toBe("launch");
      expect(out.warnings).toEqual([]);
    });

    it("valid effort / effort_source なし → 'config' fallback", () => {
      const out = resolveClaudeSources(
        { ...baseConfig, effort: "medium" },
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.effort).toBe("medium");
      expect(out.effortSource).toBe("config");
      expect(out.warnings).toEqual([]);
    });

    it("invalid effort → value と source を **両方** undefined + warn (pair drop invariant, 藤 R3 pin)", () => {
      const out = resolveClaudeSources(
        {
          ...baseConfig,
          effort: "ultra",
          // 攻撃/バグ payload の想定: source が set でも invalid effort なら
          // value も source も drop されなければならない。
          effort_source: "launch",
        },
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.effort).toBeUndefined();
      expect(out.effortSource).toBeUndefined();
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toContain("unsupported claude-code effort");
      expect(out.warnings[0]).toContain("value and source both dropped");
    });

    it("effort 未指定 → 何も stamp しない / warn 無し", () => {
      const out = resolveClaudeSources(
        baseConfig,
        undefined,
        CLAUDE_EFFORT_LEVELS,
      );
      expect(out.effort).toBeUndefined();
      expect(out.effortSource).toBeUndefined();
      expect(out.warnings).toEqual([]);
    });
  });
});
