import { describe, expect, it } from "vitest";
import {
  isNewer,
  parseStatusLine,
  parseStatusLineHistory,
  parseStatusLineRow,
  parseStatusLineSettings,
  parseStatusLineSnapshot,
  type StatusLineRow,
} from "../src/lib/statusLine";
import { StatusLines } from "../src/lib/statusLines.svelte";

const SET = { seq: 3, head: "# Reviewing", truncated: false, bytes: 11, updated_at: "2026-10-03T12:00:00.000001Z" };

function set(seq: number, updatedAt: string, head = "line"): StatusLineRow {
  return { cleared: false, seq, head, truncated: false, bytes: head.length, updatedAt };
}

function cleared(seq: number, updatedAt: string): StatusLineRow {
  return { cleared: true, seq, updatedAt };
}

describe("parseStatusLineRow", () => {
  it("reads a set row and a stamped clear", () => {
    expect(parseStatusLineRow(SET)).toEqual({
      cleared: false, seq: 3, head: "# Reviewing", truncated: false, bytes: 11, updatedAt: SET.updated_at,
    });
    expect(parseStatusLineRow({ seq: 4, cleared: true, updated_at: "t" })).toEqual({
      cleared: true, seq: 4, updatedAt: "t",
    });
  });

  it("accepts an empty head only when it is truncated", () => {
    expect(parseStatusLineRow({ ...SET, head: "", truncated: true, bytes: 601 })).toMatchObject({ head: "" });
    expect(parseStatusLineRow({ ...SET, head: "", truncated: false })).toBeNull();
  });

  it.each([
    ["not an object", "x"],
    ["no seq", { ...SET, seq: undefined }],
    ["a zero seq", { ...SET, seq: 0 }],
    ["a fractional seq", { ...SET, seq: 1.5 }],
    ["no time", { ...SET, updated_at: "" }],
    ["a non-string head", { ...SET, head: 7 }],
    ["a non-boolean truncated", { ...SET, truncated: "no" }],
    ["no size", { ...SET, bytes: undefined }],
    ["a zero size", { ...SET, bytes: 0 }],
  ])("rejects %s", (_name, raw) => {
    expect(parseStatusLineRow(raw)).toBeNull();
  });
});

describe("the other parsers", () => {
  it("reads a live event with its agent", () => {
    expect(parseStatusLine({ ...SET, agent_id: "a.one" })).toMatchObject({ agentId: "a.one", row: { seq: 3 } });
    expect(parseStatusLine(SET)).toBeNull();
  });

  it("drops a malformed snapshot entry alone and reports incompleteness", () => {
    const snapshot = parseStatusLineSnapshot({
      agents: { "a.one": SET, "a.bad": { seq: 0 }, "a.cleared": { seq: 2, cleared: true, updated_at: "t" } },
      snapshot_incomplete: true,
    });

    expect(Object.keys(snapshot!.rows).sort()).toEqual(["a.cleared", "a.one"]);
    expect(snapshot!.incomplete).toBe(true);
    expect(parseStatusLineSnapshot({ agents: {} })!.incomplete).toBe(false);
    expect(parseStatusLineSnapshot({})).toBeNull();
  });

  it("reads the retention settings and rejects anything it cannot vouch for", () => {
    expect(parseStatusLineSettings({ retention: 20, source: "default", min: 1, max: 100 })).toEqual({
      retention: 20, source: "default", min: 1, max: 100,
    });
    expect(parseStatusLineSettings({ retention: 20, source: "nowhere", min: 1, max: 100 })).toBeNull();
    expect(parseStatusLineSettings({ retention: 0, source: "stored", min: 1, max: 100 })).toBeNull();
  });

  it("reads a change log newest first, with clears, and drops a malformed entry alone", () => {
    const entries = parseStatusLineHistory({
      entries: [
        { seq: 3, text: null, updated_at: "c" },
        { seq: 2, text: "full", bytes: 4, updated_at: "b" },
        { seq: 0, text: "bad", updated_at: "x" },
        { seq: 1, text: 5, updated_at: "a" },
      ],
    });

    expect(entries).toEqual([
      { seq: 3, text: null, bytes: null, updatedAt: "c" },
      { seq: 2, text: "full", bytes: 4, updatedAt: "b" },
    ]);
    expect(parseStatusLineHistory({})).toBeNull();
  });
});

describe("isNewer", () => {
  it("compares the time first and the sequence only on a tie", () => {
    expect(isNewer({ seq: 1, updatedAt: "2026-10-03T12:00:01Z" }, { seq: 57, updatedAt: "2026-10-03T12:00:00Z" })).toBe(true);
    expect(isNewer({ seq: 99, updatedAt: "2026-10-03T12:00:00Z" }, { seq: 1, updatedAt: "2026-10-03T12:00:01Z" })).toBe(false);
    expect(isNewer({ seq: 2, updatedAt: "t" }, { seq: 1, updatedAt: "t" })).toBe(true);
    expect(isNewer({ seq: 1, updatedAt: "t" }, { seq: 1, updatedAt: "t" })).toBe(false);
  });
});

describe("StatusLines", () => {
  it("shows no row before the snapshot, and unset after a complete one", () => {
    const lines = new StatusLines();
    expect(lines.view("a")).toEqual({ kind: "none" });

    lines.applySnapshot({ b: set(1, "t1") }, false);

    expect(lines.view("a")).toEqual({ kind: "unset" });
    expect(lines.view("b")).toMatchObject({ kind: "set", head: "line" });
  });

  it("never turns an incomplete snapshot into unset, but still shows the lines it has", () => {
    const lines = new StatusLines();
    lines.applySnapshot({ b: set(1, "t1") }, true);

    expect(lines.view("a")).toEqual({ kind: "none" });
    expect(lines.view("b")).toMatchObject({ kind: "set" });
  });

  it("a complete snapshot on rejoin clears an earlier incomplete state", () => {
    const lines = new StatusLines();
    lines.applySnapshot({}, true);
    lines.applySnapshot({ a: set(1, "t1") }, false);

    expect(lines.view("a")).toMatchObject({ kind: "set" });
    expect(lines.view("other")).toEqual({ kind: "unset" });
  });

  it("ignores a live event that is not newer than the held row", () => {
    const lines = new StatusLines();
    lines.applySnapshot({ a: set(5, "2026-10-03T12:00:05Z", "newest") }, false);

    lines.applyLive("a", set(4, "2026-10-03T12:00:04Z", "older"));
    lines.applyLive("a", set(5, "2026-10-03T12:00:05Z", "same"));

    expect(lines.view("a")).toMatchObject({ head: "newest" });
  });

  // The server's store can be reset: seq restarts at 1 while the time moves on.
  it("applies a newer time even when its sequence restarted", () => {
    const lines = new StatusLines();
    lines.applySnapshot({ a: set(57, "2026-10-03T12:00:00Z", "before reset") }, false);

    lines.applyLive("a", set(1, "2026-10-03T12:30:00Z", "after reset"));

    expect(lines.view("a")).toMatchObject({ head: "after reset" });
  });

  it("keeps a stamped clear, so an older set arriving later is rejected", () => {
    const lines = new StatusLines();
    lines.applySnapshot({ a: set(1, "2026-10-03T12:00:01Z") }, false);
    lines.applyLive("a", cleared(2, "2026-10-03T12:00:02Z"));

    expect(lines.view("a")).toEqual({ kind: "unset" });
    lines.applyLive("a", set(1, "2026-10-03T12:00:01Z", "stale"));

    expect(lines.view("a")).toEqual({ kind: "unset" });
  });

  it("holds a line that arrives before anything else about its agent", () => {
    const lines = new StatusLines();
    lines.applyLive("early", set(1, "t1", "first"));

    expect(lines.view("early")).toMatchObject({ kind: "set", head: "first" });
    expect(lines.view("other")).toEqual({ kind: "none" });
  });

  it("drops an agent on removal, and everything on reset", () => {
    const lines = new StatusLines();
    lines.applySnapshot({ a: set(1, "t1"), b: set(1, "t1") }, false);

    lines.remove("a");
    expect(lines.view("a")).toEqual({ kind: "unset" });
    expect(lines.view("b")).toMatchObject({ kind: "set" });

    lines.reset();
    expect(lines.view("b")).toEqual({ kind: "none" });
  });

  it("names the stamp of the held row so a dialog can notice a new line", () => {
    const lines = new StatusLines();
    expect(lines.stampOf("a")).toBeNull();

    lines.applyLive("a", set(2, "t2"));

    expect(lines.stampOf("a")).toBe("t2#2");
  });
});
