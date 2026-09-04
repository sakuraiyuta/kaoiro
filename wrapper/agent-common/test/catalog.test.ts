import { describe, expect, it } from "vitest";
import { mergeExtraModels } from "../src/catalog.js";

// issue #292: shared with the runner's own copy of the same merge logic
// (runner/src/config.ts mergeExtraModels) -- keep behaviour identical.
describe("mergeExtraModels", () => {
  const base = [
    { value: "a", display_name: "A" },
    { value: "b", display_name: "B" },
  ];

  it("returns a copy of base when extra is undefined / empty", () => {
    expect(mergeExtraModels(base, undefined)).toEqual(base);
    expect(mergeExtraModels(base, [])).toEqual(base);
    expect(mergeExtraModels(base, undefined)).not.toBe(base);
  });

  it("a matching value overrides in place, keeping base's position", () => {
    const merged = mergeExtraModels(base, [
      { value: "a", display_name: "overridden" },
    ]);
    expect(merged.map((m) => m.value)).toEqual(["a", "b"]);
    expect(merged[0]?.display_name).toBe("overridden");
    expect(merged[1]).toEqual(base[1]);
  });

  it("a new value is appended in declaration order", () => {
    const merged = mergeExtraModels(base, [
      { value: "c", display_name: "C" },
      { value: "d", display_name: "D" },
    ]);
    expect(merged.map((m) => m.value)).toEqual(["a", "b", "c", "d"]);
  });

  it("override and append both apply when mixed in one declaration", () => {
    const merged = mergeExtraModels(base, [
      { value: "c", display_name: "C" },
      { value: "a", display_name: "overridden" },
    ]);
    expect(merged.map((m) => m.value)).toEqual(["a", "b", "c"]);
    expect(merged[0]?.display_name).toBe("overridden");
  });

  it("does not mutate base (immutable)", () => {
    mergeExtraModels(base, [{ value: "a", display_name: "overridden" }]);
    expect(base[0]?.display_name).toBe("A");
  });
});
