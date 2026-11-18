import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "../src/args.js";

describe("parseCliArgs", () => {
  it("reads `run <launch file>`", () => {
    expect(parseCliArgs(["run", "agent.json"])).toEqual({ configPath: "agent.json" });
  });

  it.each([
    [[]],
    [["run"]],
    [["agent.json"]],
    [["start", "agent.json"]],
    [["run", "agent.json", "first instruction"]],
    [["run", "agent.json", "--resume", "sess-123"]],
  ])("rejects %j as a usage error", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
  });
});
