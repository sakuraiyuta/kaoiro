import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/persona.js";

const valid = {
  agent_id: "lab-pc-1.claude-a",
  persona: { id: "mio", name: "澪", sprite_set: "mio" },
  server_url: "ws://localhost:4000/wrapper",
};

describe("parseConfig", () => {
  // Clear the env var across all tests so a developer who exports it in their
  // shell to test #60's env path does not break unrelated assertions that
  // expect parseConfig to leave permission_timeout_ms unset.
  beforeEach(() => {
    delete process.env.KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS;
  });

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

  it("文字種制約外の agent_id を弾く", () => {
    for (const bad of ["lab/claude", "a b", "日本語", "a:b"]) {
      expect(() => parseConfig({ ...valid, agent_id: bad })).toThrow(
        ConfigError,
      );
    }
  });

  it("許容文字種と上限境界の agent_id を受け入れる", () => {
    for (const good of ["lab_pc_1.claude-a", "A.b_c-9", "a".repeat(256)]) {
      expect(() => parseConfig({ ...valid, agent_id: good })).not.toThrow();
    }
  });

  it("persona 欠落を弾く", () => {
    expect(() => parseConfig({ agent_id: "x", server_url: valid.server_url })).toThrow(
      ConfigError,
    );
  });

  it("persona の必須フィールド欠落を弾く", () => {
    expect(() =>
      parseConfig({ ...valid, persona: { id: "mio", name: "澪" } }),
    ).toThrow(ConfigError);
  });

  it("persona.id の path traversal / 不正文字を弾く (ADR-0029)", () => {
    // persona.id rides join params and the sprite URL path; the charset
    // guard blocks '/' and '\\' so a malformed value cannot escape either.
    for (const bad of ["../etc", "a/b", "a\\b", "/abs", "日本語", "a:b"]) {
      expect(() =>
        parseConfig({
          ...valid,
          persona: { ...valid.persona, id: bad },
        }),
      ).toThrow(ConfigError);
    }
  });

  it("オブジェクト以外を弾く", () => {
    expect(() => parseConfig(null)).toThrow(ConfigError);
    expect(() => parseConfig("nope")).toThrow(ConfigError);
  });

  it("server_url 欠落は弾く (ADR-0029 F3 fail-closed)", () => {
    const { server_url: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseConfig(rest)).toThrow(ConfigError);
  });

  it("ws:// / wss:// 以外の server_url を弾く", () => {
    expect(() =>
      parseConfig({ ...valid, server_url: "http://localhost:4000" }),
    ).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, server_url: "" })).toThrow(
      ConfigError,
    );
  });

  it("server_token を受け入れる(任意フィールド)", () => {
    const withToken = { ...valid, server_token: "tok-1" };
    expect(parseConfig(withToken)).toEqual(withToken);
    expect(() => parseConfig({ ...valid, server_token: "" })).toThrow(
      ConfigError,
    );
  });

  it("Codex catalog contextを受け入れる", () => {
    expect(
      parseConfig({
        ...valid,
        codex_auth_mode: "chatgpt",
        codex_chatgpt_plan: "plus",
      }),
    ).toMatchObject({
      codex_auth_mode: "chatgpt",
      codex_chatgpt_plan: "plus",
    });
  });

  it("未知のCodex catalog contextを弾く", () => {
    expect(() =>
      parseConfig({ ...valid, codex_auth_mode: "oauth" }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ...valid, codex_chatgpt_plan: "team" }),
    ).toThrow(ConfigError);
  });

  it("permission_timeout_ms は正の整数のみ受け入れる", () => {
    expect(
      parseConfig({ ...valid, permission_timeout_ms: 1000 }),
    ).toMatchObject({ permission_timeout_ms: 1000 });

    for (const bad of [0, -1, 1.5, "1000", null]) {
      expect(() =>
        parseConfig({ ...valid, permission_timeout_ms: bad }),
      ).toThrow(ConfigError);
    }
  });

  describe("KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS env (#60)", () => {
    const ENV_KEY = "KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS";

    beforeEach(() => {
      delete process.env[ENV_KEY];
    });
    afterEach(() => {
      delete process.env[ENV_KEY];
    });

    it("config が無ければ env を取り込む", () => {
      process.env[ENV_KEY] = "5000";
      expect(parseConfig({ ...valid })).toMatchObject({
        permission_timeout_ms: 5000,
      });
    });

    it("config が明示されていれば env より優先する", () => {
      process.env[ENV_KEY] = "5000";
      expect(
        parseConfig({ ...valid, permission_timeout_ms: 1234 }),
      ).toMatchObject({ permission_timeout_ms: 1234 });
    });

    it("env が空文字なら未設定扱い (broker は SDK デフォルト)", () => {
      process.env[ENV_KEY] = "";
      expect(parseConfig({ ...valid })).not.toHaveProperty(
        "permission_timeout_ms",
      );
    });

    it("env が不正値なら ConfigError", () => {
      for (const bad of ["0", "-1", "1.5", "abc"]) {
        process.env[ENV_KEY] = bad;
        expect(() => parseConfig({ ...valid })).toThrow(ConfigError);
      }
    });
  });

  describe("permission_mode (#58)", () => {
    it("有効な PermissionMode を受け入れる", () => {
      for (const mode of [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "dontAsk",
        "auto",
      ]) {
        expect(
          parseConfig({ ...valid, permission_mode: mode }),
        ).toMatchObject({ permission_mode: mode });
      }
    });

    it("不正な permission_mode は ConfigError", () => {
      for (const bad of ["", "yolo", "DEFAULT", 1, null]) {
        expect(() =>
          parseConfig({ ...valid, permission_mode: bad }),
        ).toThrow(ConfigError);
      }
    });
  });

  it("allowed_tools は非空文字列の配列のみ受け入れる", () => {
    expect(
      parseConfig({ ...valid, allowed_tools: ["Read", "Edit", "Bash"] }),
    ).toMatchObject({ allowed_tools: ["Read", "Edit", "Bash"] });

    for (const bad of ["Read", [""], [1], [null], {}]) {
      expect(() => parseConfig({ ...valid, allowed_tools: bad })).toThrow(
        ConfigError,
      );
    }
  });

  it("allowed_tools の要素長は 256 が境界", () => {
    expect(
      parseConfig({ ...valid, allowed_tools: ["a".repeat(256)] }),
    ).toMatchObject({ allowed_tools: ["a".repeat(256)] });

    expect(() =>
      parseConfig({ ...valid, allowed_tools: ["a".repeat(257)] }),
    ).toThrow(ConfigError);
  });

  it("allowed_tools の件数上限は 64", () => {
    const max = Array.from({ length: 64 }, (_, i) => `Tool${i}`);
    expect(parseConfig({ ...valid, allowed_tools: max })).toMatchObject({
      allowed_tools: max,
    });

    expect(() =>
      parseConfig({ ...valid, allowed_tools: [...max, "Extra"] }),
    ).toThrow(ConfigError);
  });
});
