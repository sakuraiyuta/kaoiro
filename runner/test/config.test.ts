import { describe, expect, it } from "vitest";
import {
  ConfigError,
  buildHeartbeat,
  buildRegister,
  parseRunnerConfig,
  wrapperUrlFrom,
} from "../src/config.js";

const valid = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  personas: [{ id: "mio", name: "澪", sprite_set: "mio" }],
  cwd_allowlist: ["/home/user/git/kaoiro"],
};

describe("parseRunnerConfig", () => {
  it("正しい設定をそのまま受け入れる", () => {
    expect(parseRunnerConfig(valid)).toEqual(valid);
  });

  it("capabilities を任意項目として受け入れる", () => {
    const withCaps = { ...valid, capabilities: ["claude"] };
    expect(parseRunnerConfig(withCaps).capabilities).toEqual(["claude"]);
  });

  it("host_id 欠落を弾く", () => {
    const { host_id: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseRunnerConfig(rest)).toThrow(ConfigError);
  });

  it("topic 非互換な host_id を弾く", () => {
    expect(() => parseRunnerConfig({ ...valid, host_id: "bad id" })).toThrow(
      ConfigError,
    );
  });

  it("ws:// / wss:// 以外の server_url を弾く", () => {
    expect(() =>
      parseRunnerConfig({ ...valid, server_url: "http://localhost:4000" }),
    ).toThrow(ConfigError);
  });

  it("personas が配列でなければ弾く", () => {
    expect(() => parseRunnerConfig({ ...valid, personas: {} })).toThrow(
      ConfigError,
    );
  });

  it("persona の必須フィールド欠落を弾く", () => {
    expect(() =>
      parseRunnerConfig({ ...valid, personas: [{ id: "mio", name: "澪" }] }),
    ).toThrow(ConfigError);
  });

  it("空の personas を弾く(spawn できない設定)", () => {
    expect(() => parseRunnerConfig({ ...valid, personas: [] })).toThrow(
      ConfigError,
    );
  });

  it("cwd_allowlist が配列でなければ弾く", () => {
    expect(() =>
      parseRunnerConfig({ ...valid, cwd_allowlist: "/home/user" }),
    ).toThrow(ConfigError);
  });

  it("空の cwd_allowlist を弾く(spawn 先が無い設定)", () => {
    expect(() => parseRunnerConfig({ ...valid, cwd_allowlist: [] })).toThrow(
      ConfigError,
    );
  });
});

describe("buildRegister", () => {
  it("config から version 付き register を組む", () => {
    expect(buildRegister(parseRunnerConfig(valid))).toEqual({
      version: "0",
      host_id: "lab-pc-1",
      personas: valid.personas,
      cwd_allowlist: valid.cwd_allowlist,
    });
  });

  it("capabilities があれば含める", () => {
    const config = parseRunnerConfig({ ...valid, capabilities: ["claude"] });
    expect(buildRegister(config).capabilities).toEqual(["claude"]);
  });
});

describe("buildHeartbeat", () => {
  it("version と host_id を持つ", () => {
    expect(buildHeartbeat("lab-pc-1")).toEqual({
      version: "0",
      host_id: "lab-pc-1",
    });
  });
});

describe("wrapperUrlFrom", () => {
  it("runner URL の origin を保ち /wrapper へ差し替える", () => {
    expect(wrapperUrlFrom("ws://localhost:4000/runner")).toBe(
      "ws://localhost:4000/wrapper",
    );
  });
  it("wss と非標準ポートを保つ", () => {
    expect(wrapperUrlFrom("wss://kaoiro.example:8443/runner")).toBe(
      "wss://kaoiro.example:8443/wrapper",
    );
  });
});
