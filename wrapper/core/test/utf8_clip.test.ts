import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { MAX_LOG_BYTES, clipText } from "../src/redact.js";
import {
  clipUtf16Head,
  clipUtf16Tail,
  clipUtf8Head,
  clipUtf8Tail,
  utf8HeadEnd,
} from "../src/utf8_clip.js";

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

const WIDTHS = [
  ["1-byte", "a"],
  ["2-byte", "é"],
  ["3-byte", "あ"],
  ["4-byte", "\u{1F600}"],
] as const;

// Padding 0 to 3 ASCII bytes moves the cut through every byte offset inside
// a character of each width.
const CASES = WIDTHS.flatMap(([name, char]) =>
  [0, 1, 2, 3].map((pad) => ({ name, char, pad })),
);

const CAP = 64;

describe("clipUtf8Head (issue #624)", () => {
  it.each(CASES)("$name character, $pad padding: whole-character prefix within the cap", ({ char, pad }) => {
    const text = "p".repeat(pad) + char.repeat(CAP);
    const out = clipUtf8Head(text, CAP);
    expect(text.startsWith(out)).toBe(true);
    expect(bytesOf(out)).toBeLessThanOrEqual(CAP);
    expect(bytesOf(out)).toBeGreaterThan(CAP - bytesOf(char));
    expect(out).not.toContain("�");
  });

  it("keeps text at the cap and one byte under it unchanged", () => {
    expect(clipUtf8Head("a".repeat(CAP), CAP)).toBe("a".repeat(CAP));
    expect(clipUtf8Head("a".repeat(CAP - 1), CAP)).toBe("a".repeat(CAP - 1));
  });

  it("clips one byte over the cap, with an ASCII or a straddling last character", () => {
    expect(clipUtf8Head("a".repeat(CAP + 1), CAP)).toBe("a".repeat(CAP));
    expect(clipUtf8Head(`${"a".repeat(CAP - 1)}é`, CAP)).toBe(
      "a".repeat(CAP - 1),
    );
  });

  it("returns an empty string for a cap of zero or less", () => {
    expect(clipUtf8Head("abc", 0)).toBe("");
    expect(clipUtf8Head("abc", -1)).toBe("");
  });

  it("keeps a lone surrogate at the boundary within the cap", () => {
    const text = `${"a".repeat(CAP - 2)}\ud800b`;
    expect(bytesOf(clipUtf8Head(text, CAP))).toBeLessThanOrEqual(CAP);
  });
});

describe("clipUtf8Tail (issue #624)", () => {
  it.each(CASES)("$name character, $pad padding: whole-character suffix within the cap", ({ char, pad }) => {
    const text = char.repeat(CAP) + "p".repeat(pad);
    const out = clipUtf8Tail(text, CAP);
    expect(text.endsWith(out)).toBe(true);
    expect(bytesOf(out)).toBeLessThanOrEqual(CAP);
    expect(bytesOf(out)).toBeGreaterThan(CAP - bytesOf(char));
    expect(out).not.toContain("�");
  });

  it("keeps text at the cap and one byte under it unchanged", () => {
    expect(clipUtf8Tail("a".repeat(CAP), CAP)).toBe("a".repeat(CAP));
    expect(clipUtf8Tail("a".repeat(CAP - 1), CAP)).toBe("a".repeat(CAP - 1));
  });

  it("clips one byte over the cap, with an ASCII or a straddling first character", () => {
    expect(clipUtf8Tail("a".repeat(CAP + 1), CAP)).toBe("a".repeat(CAP));
    expect(clipUtf8Tail(`é${"a".repeat(CAP - 1)}`, CAP)).toBe(
      "a".repeat(CAP - 1),
    );
  });

  it("returns an empty string for a cap of zero or less", () => {
    expect(clipUtf8Tail("abc", 0)).toBe("");
  });
});

describe("utf8HeadEnd (issue #624)", () => {
  it("steps back over a straddling character", () => {
    const bytes = Buffer.from(`abあ`, "utf8");
    expect(utf8HeadEnd(bytes, 3)).toBe(2);
    expect(utf8HeadEnd(bytes, 4)).toBe(2);
    expect(utf8HeadEnd(bytes, 5)).toBe(5);
  });

  it("stops after 3 steps inside a malformed run of continuation bytes", () => {
    const bytes = Uint8Array.from([0x61, ...Array<number>(10).fill(0x80)]);
    expect(utf8HeadEnd(bytes, 8)).toBe(5);
  });

  it("returns 0 for a cap of zero or less", () => {
    const bytes = Buffer.from("abc", "utf8");
    expect(utf8HeadEnd(bytes, 0)).toBe(0);
    expect(utf8HeadEnd(bytes, -1)).toBe(0);
  });

  it("never steps below zero", () => {
    expect(utf8HeadEnd(Uint8Array.from([0x80, 0x80, 0x80]), 1)).toBe(0);
  });
});

describe("clipText (issue #624)", () => {
  it("keeps the issue's example within MAX_LOG_BYTES", () => {
    const { text, truncated } = clipText("あ".repeat(7000));
    expect(truncated).toBe(true);
    expect(text).toBe("あ".repeat(5461));
    expect(bytesOf(text)).toBe(16_383);
  });

  it("does not flag text of exactly MAX_LOG_BYTES as truncated", () => {
    const text = "a".repeat(MAX_LOG_BYTES);
    expect(clipText(text)).toEqual({ text, truncated: false });
  });

  it.each(CASES)("$name character, $pad padding: within MAX_LOG_BYTES, no U+FFFD", ({ char, pad }) => {
    const { text, truncated } = clipText(
      "p".repeat(pad) + char.repeat(MAX_LOG_BYTES + 1),
    );
    expect(truncated).toBe(true);
    expect(bytesOf(text)).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(text).not.toContain("�");
  });
});

describe("clipUtf16Head / clipUtf16Tail (issue #630)", () => {
  const PAIR = "\u{1F600}";
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("steps back from a head cut that splits a surrogate pair", () => {
    expect(clipUtf16Head(`ab${PAIR}c`, 3)).toBe("ab");
    expect(clipUtf16Head(`ab${PAIR}c`, 4)).toBe(`ab${PAIR}`);
  });

  it("steps forward from a tail cut that splits a surrogate pair", () => {
    expect(clipUtf16Tail(`a${PAIR}bc`, 3)).toBe("bc");
    expect(clipUtf16Tail(`a${PAIR}bc`, 4)).toBe(`${PAIR}bc`);
  });

  it("keeps text within the limit and returns empty for a limit of zero", () => {
    expect(clipUtf16Head(PAIR, 2)).toBe(PAIR);
    expect(clipUtf16Tail(PAIR, 2)).toBe(PAIR);
    expect(clipUtf16Head("abc", 0)).toBe("");
    expect(clipUtf16Tail("abc", -1)).toBe("");
  });

  it("never exceeds the limit or leaves a lone surrogate", () => {
    const text = `a${PAIR.repeat(5)}b`;
    for (let max = 1; max <= text.length; max += 1) {
      for (const clipped of [clipUtf16Head(text, max), clipUtf16Tail(text, max)]) {
        expect(clipped.length).toBeLessThanOrEqual(max);
        expect(clipped).not.toMatch(LONE);
      }
    }
  });
});
