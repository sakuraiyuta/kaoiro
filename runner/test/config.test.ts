import { describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  buildHeartbeat,
  buildRegister,
  parseRunnerConfig,
  wrapperUrlFrom,
} from "../src/config.js";

/** Accept-all base config used by tests that don't care about the persona
 *  trust policy — ADR-0031 makes both persona fields optional. */
const valid = {
  host_id: "lab-pc-1",
  server_url: "ws://localhost:4000/runner",
  cwd_allowlist: ["/home/user/git/kaoiro"],
};

describe("parseRunnerConfig", () => {
  it("persona 関連を書かない設定は accept-all として通す", () => {
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

  describe("persona trust policy (ADR-0031)", () => {
    it("allowed_personas を string 配列として受け入れる", () => {
      const config = parseRunnerConfig({
        ...valid,
        allowed_personas: ["ao", "kuroe"],
      });
      expect(config.allowed_personas).toEqual(["ao", "kuroe"]);
      expect(config.blocked_personas).toBeUndefined();
      expect(config.personas).toBeUndefined();
    });

    it("blocked_personas を string 配列として受け入れる", () => {
      const config = parseRunnerConfig({
        ...valid,
        blocked_personas: ["fuji"],
      });
      expect(config.blocked_personas).toEqual(["fuji"]);
      expect(config.allowed_personas).toBeUndefined();
    });

    it("allowed_personas と blocked_personas の同時指定は弾く", () => {
      expect(() =>
        parseRunnerConfig({
          ...valid,
          allowed_personas: ["ao"],
          blocked_personas: ["fuji"],
        }),
      ).toThrow(ConfigError);
    });

    it("legacy personas + 新フィールドの同時指定は弾く", () => {
      expect(() =>
        parseRunnerConfig({
          ...valid,
          personas: [{ id: "ao", name: "あお", sprite_set: "ao" }],
          allowed_personas: ["ao"],
        }),
      ).toThrow(ConfigError);
    });

    it("legacy personas は allowlist 互換で受理し stderr に deprecation を書く", () => {
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        const config = parseRunnerConfig({
          ...valid,
          personas: [{ id: "ao", name: "あお", sprite_set: "ao" }],
        });
        expect(config.personas).toEqual([
          { id: "ao", name: "あお", sprite_set: "ao" },
        ]);
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining("deprecated"),
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it("allowed_personas の非文字列要素を弾く", () => {
      expect(() =>
        parseRunnerConfig({ ...valid, allowed_personas: [123] }),
      ).toThrow(ConfigError);
    });

    it("legacy persona の必須フィールド欠落を弾く", () => {
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        expect(() =>
          parseRunnerConfig({
            ...valid,
            personas: [{ id: "ao", name: "あお" }],
          }),
        ).toThrow(ConfigError);
      } finally {
        stderr.mockRestore();
      }
    });

    it("空の legacy personas を弾く(旧: spawn できない設定)", () => {
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        expect(() => parseRunnerConfig({ ...valid, personas: [] })).toThrow(
          ConfigError,
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });
});

describe("buildRegister", () => {
  it("accept-all の config はどのポリシー欄も含めない", () => {
    expect(buildRegister(parseRunnerConfig(valid))).toEqual({
      version: "0",
      host_id: "lab-pc-1",
      cwd_allowlist: valid.cwd_allowlist,
    });
  });

  it("allowed_personas を register に含める", () => {
    const config = parseRunnerConfig({
      ...valid,
      allowed_personas: ["ao", "kuroe"],
    });
    expect(buildRegister(config).allowed_personas).toEqual(["ao", "kuroe"]);
  });

  it("blocked_personas を register に含める", () => {
    const config = parseRunnerConfig({
      ...valid,
      blocked_personas: ["fuji"],
    });
    expect(buildRegister(config).blocked_personas).toEqual(["fuji"]);
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
