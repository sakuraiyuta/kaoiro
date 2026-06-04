import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/persona.js";

const valid = {
  agent_id: "lab-pc-1/claude-a",
  persona: { id: "mio", name: "澪", sprite_set: "mio" },
};

describe("parseConfig", () => {
  it("正しい設定をそのまま受け入れる", () => {
    expect(parseConfig(valid)).toEqual(valid);
  });

  it("agent_id 欠落を弾く", () => {
    const { agent_id: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseConfig(rest)).toThrow(ConfigError);
  });

  it("空文字の agent_id を弾く", () => {
    expect(() => parseConfig({ ...valid, agent_id: "  " })).toThrow(
      ConfigError,
    );
  });

  it("上限超過の文字列を弾く", () => {
    expect(() =>
      parseConfig({ ...valid, agent_id: "a".repeat(257) }),
    ).toThrow(ConfigError);
  });

  it("persona 欠落を弾く", () => {
    expect(() => parseConfig({ agent_id: "x" })).toThrow(ConfigError);
  });

  it("persona の必須フィールド欠落を弾く", () => {
    expect(() =>
      parseConfig({ ...valid, persona: { id: "mio", name: "澪" } }),
    ).toThrow(ConfigError);
  });

  it("オブジェクト以外を弾く", () => {
    expect(() => parseConfig(null)).toThrow(ConfigError);
    expect(() => parseConfig("nope")).toThrow(ConfigError);
  });
});
