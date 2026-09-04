import { describe, expect, it } from "vitest";
import { mergeExtraModels } from "../src/catalog.js";

// issue #292: shared with the runner's own copy of the same merge logic
// (runner/src/config.ts mergeExtraModels) -- keep behaviour identical.

// Contract table (issue #292 SF-1): kept byte-identical in this file and in
// runner/test/config.test.ts's copy of the same describe block, so a
// behavioural drift between the runner's and the wrapper's independent
// mergeExtraModels implementations fails in BOTH suites rather than only
// the one a change happened to touch.
const MERGE_EXTRA_MODELS_TABLE: {
  name: string;
  extra: { value: string; display_name: string }[] | undefined;
  expectedValues: string[];
  expectedDisplayNames: Record<string, string>;
}[] = [
  {
    name: "undefined extra returns base's values unchanged",
    extra: undefined,
    expectedValues: ["a", "b"],
    expectedDisplayNames: { a: "A", b: "B" },
  },
  {
    name: "empty extra returns base's values unchanged",
    extra: [],
    expectedValues: ["a", "b"],
    expectedDisplayNames: { a: "A", b: "B" },
  },
  {
    name: "a matching value overrides in place, keeping base's position",
    extra: [{ value: "a", display_name: "overridden" }],
    expectedValues: ["a", "b"],
    expectedDisplayNames: { a: "overridden", b: "B" },
  },
  {
    name: "a new value is appended in declaration order",
    extra: [
      { value: "c", display_name: "C" },
      { value: "d", display_name: "D" },
    ],
    expectedValues: ["a", "b", "c", "d"],
    expectedDisplayNames: { a: "A", b: "B", c: "C", d: "D" },
  },
  {
    name: "override and append both apply when mixed in one declaration",
    extra: [
      { value: "c", display_name: "C" },
      { value: "a", display_name: "overridden" },
    ],
    expectedValues: ["a", "b", "c"],
    expectedDisplayNames: { a: "overridden", b: "B", c: "C" },
  },
];

describe("mergeExtraModels", () => {
  const base = [
    { value: "a", display_name: "A" },
    { value: "b", display_name: "B" },
  ];

  it.each(MERGE_EXTRA_MODELS_TABLE)(
    "$name",
    ({ extra, expectedValues, expectedDisplayNames }) => {
      const merged = mergeExtraModels(base, extra);
      expect(merged.map((m) => m.value)).toEqual(expectedValues);
      for (const [value, displayName] of Object.entries(expectedDisplayNames)) {
        expect(merged.find((m) => m.value === value)?.display_name).toBe(
          displayName,
        );
      }
    },
  );

  it("returns a copy, not the same array reference", () => {
    expect(mergeExtraModels(base, undefined)).not.toBe(base);
  });

  it("does not mutate base (non-destructive)", () => {
    const snapshot = base.map((m) => ({ ...m }));
    mergeExtraModels(base, [{ value: "a", display_name: "overridden" }]);
    expect(base).toEqual(snapshot);
  });
});
