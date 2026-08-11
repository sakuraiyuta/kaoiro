import { describe, expect, it } from "vitest";
import { parseRunnerArgs } from "../src/args.js";

describe("parseRunnerArgs", () => {
  it("引数無しなら既定 configPath、version=false", () => {
    expect(parseRunnerArgs([])).toEqual({
      configPath: "runner.config.json",
      version: false,
    });
  });

  it("positional は configPath として使う", () => {
    expect(parseRunnerArgs(["my.config.json"])).toEqual({
      configPath: "my.config.json",
      version: false,
    });
  });

  // issue #228: --version は configPath の有無に関わらず検出できる —
  // main() 側がこれを config 読み込みより前でチェックする前提を支える。
  it("--version フラグを検出する", () => {
    expect(parseRunnerArgs(["--version"])).toEqual({
      configPath: "runner.config.json",
      version: true,
    });
  });

  it("--version と configPath を同時に指定してもどちらも読める", () => {
    expect(parseRunnerArgs(["my.config.json", "--version"])).toEqual({
      configPath: "my.config.json",
      version: true,
    });
  });
});
