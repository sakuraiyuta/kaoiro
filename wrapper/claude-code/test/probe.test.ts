// projectModel (src/probe.ts) の ModelInfo -> ProbeModel 射影を pin する。
// resolved_model は read-only metadata なので「SDK が報告したときだけ載る /
// 欠落時は property 自体 absent」を両方向で固定する (ADR-0037 追補)。

import { describe, expect, it } from "vitest";
import { projectModel } from "../src/probe.js";

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
