import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.js";

describe("parseCliArgs", () => {
  it("引数なしは config を既定値にし prompt/resume は未設定", () => {
    expect(parseCliArgs([])).toEqual({
      configPath: "kaoiro.config.json",
      prompt: undefined,
      resume: undefined,
    });
  });

  it("位置引数 configPath / prompt を読む", () => {
    expect(parseCliArgs(["agent.json", "状態を列挙して"])).toEqual({
      configPath: "agent.json",
      prompt: "状態を列挙して",
      resume: undefined,
    });
  });

  it("--resume <session_id> を resume に取り出す", () => {
    expect(parseCliArgs(["agent.json", "続けて", "--resume", "sess-123"])).toEqual({
      configPath: "agent.json",
      prompt: "続けて",
      resume: "sess-123",
    });
  });

  it("prompt 省略 + --resume も成立する", () => {
    expect(parseCliArgs(["agent.json", "--resume", "sess-123"])).toEqual({
      configPath: "agent.json",
      prompt: undefined,
      resume: "sess-123",
    });
  });

  it("--resume が位置引数より前でも解釈する", () => {
    expect(parseCliArgs(["--resume", "sess-123", "agent.json"])).toEqual({
      configPath: "agent.json",
      prompt: undefined,
      resume: "sess-123",
    });
  });
});
