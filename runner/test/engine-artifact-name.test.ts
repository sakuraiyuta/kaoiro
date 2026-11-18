import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { ENGINES } from "../src/engines.js";

describe("engine artifact names", () => {
  it("selects Claude libc variants and the Codex Linux package", () => {
    expect(ENGINES["claude-code"].artifactName!("linux", "x64", "glibc"))
      .toBe("@anthropic-ai/claude-agent-sdk-linux-x64");
    expect(ENGINES["claude-code"].artifactName!("linux", "x64", "musl"))
      .toBe("@anthropic-ai/claude-agent-sdk-linux-x64-musl");
    expect(ENGINES.codex.artifactName!("linux", "x64", "glibc"))
      .toBe("@openai/codex-linux-x64");
  });
});
