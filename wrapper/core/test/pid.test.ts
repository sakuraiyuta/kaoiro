import { describe, expect, it } from "vitest";
import { requirePositiveSafePid } from "../src/pid.js";

describe("requirePositiveSafePid", () => {
  it.each([
    [1, 1],
    [42, 42],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [" 42 ", 42],
    ["00042", 42],
  ])("accepts %s", (value, expected) => {
    expect(requirePositiveSafePid(value)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "",
    "  ",
    "0",
    "-0",
    "-1",
    "+1",
    "1.5",
    "NaN",
    "Infinity",
    "1e3",
    "0x10",
    "9007199254740992",
    0,
    -0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects %s", (value) => {
    expect(() => requirePositiveSafePid(value)).toThrow(RangeError);
  });
});
