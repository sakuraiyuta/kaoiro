import { describe, expect, it } from "vitest";
import {
  MAX_TASKLIST_ITEM_TEXT_BYTES,
  MAX_TASKLIST_ITEMS_JSON_BYTES,
  normalizeTasklist,
} from "../src/tasklist.js";

describe("normalizeTasklist", () => {
  it("先頭50件を残し、残りと完了数を明示する", () => {
    const snapshot = normalizeTasklist(
      Array.from({ length: 51 }, (_, index) => ({
        text: `todo ${index + 1}`,
        status: index === 50 ? "completed" : "pending",
      })),
    );

    expect(snapshot.items).toHaveLength(50);
    expect(snapshot.items[0]).toEqual({ text: "todo 1", status: "pending" });
    expect(snapshot.omitted).toEqual({ count: 1, completed: 1 });
  });

  it("50件ちょうどは省略せず、そのまま通す", () => {
    const source = Array.from({ length: 50 }, (_, index) => ({
      text: `todo ${index + 1}`,
      status: "pending" as const,
    }));

    expect(normalizeTasklist(source)).toEqual({ items: source });
  });

  it("text は UTF-8 の文字境界で切り、壊れた置換文字を作らない", () => {
    const snapshot = normalizeTasklist([
      { text: "あ".repeat(100), status: "in_progress" },
    ]);
    const text = snapshot.items[0]?.text ?? "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      MAX_TASKLIST_ITEM_TEXT_BYTES,
    );
    expect(text).not.toContain("\uFFFD");
    expect(text).toBe("あ".repeat(85));
  });

  it("text がちょうど256 UTF-8 bytes なら切らない", () => {
    const text = "a".repeat(MAX_TASKLIST_ITEM_TEXT_BYTES);

    expect(normalizeTasklist([{ text, status: "pending" }])).toEqual({
      items: [{ text, status: "pending" }],
    });
  });

  it("JSON escape を含めて上限を守り、省略を可視化する", () => {
    const source = Array.from({ length: 50 }, () => ({
      text: '"'.repeat(256),
      status: "pending" as const,
    }));
    const snapshot = normalizeTasklist(source);

    expect(snapshot.items.length).toBeLessThan(50);
    expect(snapshot.omitted).toEqual({
      count: 50 - snapshot.items.length,
      completed: 0,
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot.items), "utf8")).toBeLessThanOrEqual(
      MAX_TASKLIST_ITEMS_JSON_BYTES,
    );
  });

  it("items JSON がちょうど16,384 bytes なら省略しない", () => {
    // 50 × 256 ASCII chars is below the ceiling. Replacing 2,033 chars with
    // quotes adds exactly one escaped byte each, making the normalized JSON
    // hit the limit without exceeding the per-item text cap.
    let remainingQuotes = 2_033;
    const source = Array.from({ length: 50 }, () => {
      const quotes = Math.min(remainingQuotes, MAX_TASKLIST_ITEM_TEXT_BYTES);
      remainingQuotes -= quotes;
      return {
        text:
          '"'.repeat(quotes) +
          "a".repeat(MAX_TASKLIST_ITEM_TEXT_BYTES - quotes),
        status: "pending" as const,
      };
    });
    expect(remainingQuotes).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(source), "utf8")).toBe(
      MAX_TASKLIST_ITEMS_JSON_BYTES,
    );

    expect(normalizeTasklist(source)).toEqual({ items: source });
  });
});
