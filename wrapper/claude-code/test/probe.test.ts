// projectModel (src/probe.ts) の ModelInfo -> ProbeModel 射影を pin する。
// resolved_model は read-only metadata なので「SDK が報告したときだけ載る /
// 欠落時は property 自体 absent」を両方向で固定する (ADR-0037 追補)。

import { describe, expect, it, vi } from "vitest";
import { projectModel, runProbe } from "../src/probe.js";
import type { query } from "@anthropic-ai/claude-agent-sdk";

describe("projectModel", () => {
  it("resolvedModel を resolved_model に透過する", () => {
    const out = projectModel({
      value: "sonnet",
      displayName: "Sonnet",
      description: "",
      resolvedModel: "claude-sonnet-5",
      supportedEffortLevels: ["low", "medium"],
    });
    expect(out?.resolved_model).toBe("claude-sonnet-5");
    expect(out?.effort_levels).toEqual(["low", "medium"]);
  });

  it("resolvedModel 欠落時は resolved_model を生やさない (absent = unknown)", () => {
    const out = projectModel({
      value: "sonnet",
      displayName: "Sonnet",
      description: "",
    });
    expect(out).not.toBeNull();
    expect("resolved_model" in out!).toBe(false);
    // 欠落行の wire 形状は field 追加前と完全一致する。
    expect(out).toEqual({
      value: "sonnet",
      display_name: "Sonnet",
      description: "",
    });
  });

  it("resolvedModel が空文字なら載せない (空/null を入れない不変条件)", () => {
    const out = projectModel({
      value: "sonnet",
      displayName: "Sonnet",
      description: "",
      resolvedModel: "",
    });
    expect("resolved_model" in out!).toBe(false);
  });

  it("resolvedModel が string 以外なら載せない", () => {
    const out = projectModel({
      value: "sonnet",
      displayName: "Sonnet",
      description: "",
      resolvedModel: 42,
    });
    expect("resolved_model" in out!).toBe(false);
  });
});

describe("optional usage probe", () => {
  it("keeps the runner catalog output unchanged without --usage", async () => {
    const usage = vi.fn();
    const fakeQuery = (() => ({
      initializationResult: async () => ({ models: [{ value: "sonnet", displayName: "Sonnet" }] }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
      close: () => {},
    })) as unknown as typeof query;
    const emitted: unknown[] = [];
    expect(await runProbe([], fakeQuery, (result) => emitted.push(result))).toBe(0);
    expect(usage).not.toHaveBeenCalled();
    expect(emitted).toMatchObject([{ ok: true, models: [{ value: "sonnet" }], source: "init" }]);
    expect(emitted[0]).not.toHaveProperty("rate_limits");
  });

  it("reports the catalog when /usage times out", async () => {
    let closed = false;
    const fakeQuery = (() => ({
      initializationResult: async () => ({ models: [{ value: "sonnet", displayName: "Sonnet" }] }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
      close: () => { closed = true; },
    })) as unknown as typeof query;
    const emitted: unknown[] = [];
    const code = await runProbe(["--usage"], fakeQuery, (result) => emitted.push(result), 5);
    expect(code).toBe(0);
    expect(emitted).toMatchObject([{ ok: true, models: [{ value: "sonnet" }] }]);
    expect(emitted[0]).not.toHaveProperty("rate_limits");
    expect(closed).toBe(true);
  });
});
