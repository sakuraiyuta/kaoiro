import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_ENGINE } from "../src/index.js";

describe("ANTIGRAVITY_ENGINE", () => {
  it("identifies the engine as antigravity", () => {
    expect(ANTIGRAVITY_ENGINE.id).toBe("antigravity");
  });
});
