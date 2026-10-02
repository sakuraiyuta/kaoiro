import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("tmpdir isolation", () => {
  it("forces tmpdir into test-specific scratch root", () => {
    const current = tmpdir();
    expect(current).toContain("yuta384-vitest-scratch-");
    expect(current).not.toBe("/tmp");
  });
});
