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

  it.each([
    "free",
    "go",
    "plus",
    "pro",
    "business",
    "enterprise",
  ])("codex.chatgpt_plan の closed enum %s を受け入れる", (plan) => {
    const config = parseRunnerConfig({
      ...valid,
      codex: { chatgpt_plan: plan },
    });
    expect(config.codex?.chatgpt_plan).toBe(plan);
  });

  it("codex 節と chatgpt_plan の省略を受け入れる", () => {
    expect(parseRunnerConfig(valid).codex).toBeUndefined();
    expect(parseRunnerConfig({ ...valid, codex: {} }).codex).toEqual({});
  });

  it("未知の codex.chatgpt_plan を loud config error にする", () => {
    expect(() =>
      parseRunnerConfig({
        ...valid,
        codex: { chatgpt_plan: "team" },
      }),
    ).toThrowError(
      "codex.chatgpt_plan must be one of: free, go, plus, pro, business, " +
        "enterprise",
    );
  });

  it("codex 節が object でなければ弾く", () => {
    expect(() => parseRunnerConfig({ ...valid, codex: "plus" })).toThrow(
      ConfigError,
    );
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
  it("accept-all の config はどのポリシー欄も含めず、既定 capabilities/engines を持つ", () => {
    const register = buildRegister(parseRunnerConfig(valid));
    expect(register).toMatchObject({
      version: "0",
      host_id: "lab-pc-1",
      cwd_allowlist: valid.cwd_allowlist,
      capabilities: ["claude-code", "codex"],
    });
    expect(register.personas).toBeUndefined();
    expect(register.allowed_personas).toBeUndefined();
    expect(register.blocked_personas).toBeUndefined();
    // engines カタログ: 両 engine とも models は空。claude-code は
    // post-spawn の ext.models 頼み、codex は ChatGPT-plan 認証で許容
    // model がアカウント依存・列挙不能のためアカウント既定を使う
    // (ADR-0032 F4bc、2026-07-11 実挙動で確定)
    expect(register.engines?.map((e) => e.id)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(register.engines?.[0]?.models).toEqual([]);
    expect(register.engines?.[1]?.models).toEqual([]);
  });

  it("allowed_personas を register に含める", () => {
    const config = parseRunnerConfig({
      ...valid,
      allowed_personas: ["ao", "kuroe"],
    });
    expect(buildRegister(config).allowed_personas).toEqual(["ao", "kuroe"]);
  });

  it("検出auth modeと申告planからCodex catalogを解決する", () => {
    const config = parseRunnerConfig({
      ...valid,
      codex: { chatgpt_plan: "plus" },
    });
    const codex = buildRegister(config, "chatgpt").engines?.find(
      (engine) => engine.id === "codex",
    );
    expect(codex?.models.map((model) => model.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  it("blocked_personas を register に含める", () => {
    const config = parseRunnerConfig({
      ...valid,
      blocked_personas: ["fuji"],
    });
    expect(buildRegister(config).blocked_personas).toEqual(["fuji"]);
  });

  it("capabilities があれば含める (旧値 claude は claude-code に正規化)", () => {
    const config = parseRunnerConfig({ ...valid, capabilities: ["claude"] });
    const register = buildRegister(config);
    expect(register.capabilities).toEqual(["claude-code"]);
    // codex を宣言しない host の engines に codex は載らない
    expect(register.engines?.map((e) => e.id)).toEqual(["claude-code"]);
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
