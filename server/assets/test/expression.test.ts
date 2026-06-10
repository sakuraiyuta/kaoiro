import { describe, expect, it } from "vitest";
import { expressionFor, KNOWN_STATES } from "../src/lib/expression";

describe("expressionFor", () => {
  it("全 8 状態に固有の表情バリアントを返す", () => {
    const variants = KNOWN_STATES.map((s) => expressionFor(s).variant);
    expect(new Set(variants).size).toBe(KNOWN_STATES.length);
    for (const state of KNOWN_STATES) {
      expect(expressionFor(state).variant).toBe(state);
    }
  });

  it("未知の状態は idle 表情へフォールバックする(前方互換)", () => {
    expect(expressionFor("future_state").variant).toBe("idle");
  });
});
