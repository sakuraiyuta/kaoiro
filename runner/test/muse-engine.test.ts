import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { ENGINES, isEngine, resolveBundledLaunch } from "../src/engines.js";

describe("muse engine registration", () => {
  it("is a bundled engine with a run verb and no pinned artifact", () => {
    expect(isEngine("muse")).toBe(true);
    expect(Object.keys(ENGINES.muse.verbs)).toEqual(["run"]);
    expect(ENGINES.muse.artifactName).toBeUndefined();
  });

  it("resolves a bundled launch through the wrapper verb", () => {
    expect(resolveBundledLaunch("muse", ["kaoiro"])).toEqual({
      command: ["kaoiro", "wrapper", "muse"],
    });
  });

  it("is not an external engine id", () => {
    expect(isEngine("muse-acp")).toBe(false);
  });
});
