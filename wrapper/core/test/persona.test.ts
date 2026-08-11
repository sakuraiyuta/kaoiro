import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/protocol";
import { ConfigError, parseConfig } from "../src/persona.js";

const valid = {
  agent_id: "lab-pc-1.claude-a",
  persona: { id: "mio", name: "澪", sprite_set: "mio" },
  display_name: "澪",
  server_url: "ws://localhost:4000/wrapper",
};

// issue #167 (follow-up to #160): parseConfig copies WrapperConfig's optional
// fields by hand, one `if (raw.x !== undefined)` block per field — exactly
// the allow-list shape that let transition_id's copy line go missing once
// already, and (found while building this test, fixed alongside it)
// model_source/effort_source's copy blocks go missing a second time.
// WrapperConfigOptionalKey is derived from the WrapperConfig type itself, so
// ROUND_TRIP_CASES is a mapped type over that key set: adding a new optional
// field to WrapperConfig without adding a matching entry here is a compile
// error (`pnpm typecheck`), not a silently-skipped test case.
type OptionalKey<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type WrapperConfigOptionalKey = OptionalKey<WrapperConfig>;

const ROUND_TRIP_CASES: {
  [K in WrapperConfigOptionalKey]: { value: NonNullable<WrapperConfig[K]> };
} = {
  server_token: { value: "tok-1" },
  permission_timeout_ms: { value: 5000 },
  permission_mode: { value: "acceptEdits" },
  allowed_tools: { value: ["Read", "Edit"] },
  model: { value: "sonnet" },
  effort: { value: "high" },
  // Deliberately distinct from effort_source's value below: if the copy
  // logic ever cross-wired the two fields, a shared value would not catch
  // it, but distinct ones will.
  model_source: { value: "config" },
  effort_source: { value: "env" },
  codex_auth_mode: { value: "chatgpt" },
  codex_chatgpt_plan: { value: "plus" },
  codex_internal_subagents: { value: true },
  claude_engine_catalog: {
    value: [{ value: "sonnet", display_name: "Sonnet", description: "" }],
  },
  sandbox: { value: "workspace-write" },
  network_access: { value: true },
  resume_snapshot: { value: { model: "sonnet" } },
  transition_id: { value: "tr-99" },
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

  it("transition_id を保持する (phase-27, #160)", () => {
    expect(parseConfig({ ...valid, transition_id: "tr-1" })).toMatchObject({
      transition_id: "tr-1",
    });
  });

  it("transition_id 欠落は undefined のまま (legacy runner)", () => {
    expect(parseConfig(valid)).not.toHaveProperty("transition_id");
  });

  it("空文字 / 型不正の transition_id は throw せず落とす", () => {
    expect(parseConfig({ ...valid, transition_id: "" })).not.toHaveProperty(
      "transition_id",
    );
    expect(parseConfig({ ...valid, transition_id: 42 })).not.toHaveProperty(
      "transition_id",
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

  it("codex_internal_subagents の boolean を受け入れ、非 boolean を弾く", () => {
    expect(
      parseConfig({ ...valid, codex_internal_subagents: false }),
    ).toMatchObject({ codex_internal_subagents: false });
    expect(
      parseConfig({ ...valid, codex_internal_subagents: true }),
    ).toMatchObject({ codex_internal_subagents: true });
    expect(() =>
      parseConfig({ ...valid, codex_internal_subagents: "yes" }),
    ).toThrow(ConfigError);
  });

  it("claude_engine_catalog を array として受け入れ、非 array を弾く (ADR-0039 F9)", () => {
    const catalog = [
      { value: "sonnet", display_name: "Sonnet", description: "" },
    ];
    expect(
      parseConfig({ ...valid, claude_engine_catalog: catalog }),
    ).toMatchObject({ claude_engine_catalog: catalog });
    // 空 array も pass (runner 側で empty は輸送しない契約だが shape のみ検証)
    expect(
      parseConfig({ ...valid, claude_engine_catalog: [] }).claude_engine_catalog,
    ).toEqual([]);
    expect(() =>
      parseConfig({ ...valid, claude_engine_catalog: "not-array" }),
    ).toThrow(ConfigError);
  });

  it("claude_engine_catalog: effort_levels の非文字列 / 空文字要素を弾く", () => {
    // Error message 「non-empty strings」と判定を一致させるための実装ガード
    // (以前は typeof string のみで "" を許してしまっていた)。
    for (const bad of [[""], ["low", ""], ["low", 1], ["low", null]]) {
      expect(() =>
        parseConfig({
          ...valid,
          claude_engine_catalog: [
            {
              value: "sonnet",
              display_name: "Sonnet",
              description: "",
              effort_levels: bad,
            },
          ],
        }),
      ).toThrow(/effort_levels must be an array of non-empty strings/);
    }
  });

  it("claude_engine_catalog: default_effort の空文字 / 非文字列を弾く", () => {
    for (const bad of ["", 1, null, {}]) {
      expect(() =>
        parseConfig({
          ...valid,
          claude_engine_catalog: [
            {
              value: "sonnet",
              display_name: "Sonnet",
              description: "",
              default_effort: bad,
            },
          ],
        }),
      ).toThrow(/default_effort must be a non-empty string/);
    }
  });

  it("claude_engine_catalog: 有効な effort_levels + default_effort をそのまま受け入れる", () => {
    const catalog = [
      {
        value: "sonnet",
        display_name: "Sonnet",
        description: "",
        effort_levels: ["low", "medium", "high"],
        default_effort: "medium",
      },
    ];
    const parsed = parseConfig({ ...valid, claude_engine_catalog: catalog });
    expect(parsed.claude_engine_catalog).toEqual(catalog);
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

  describe("model_source / effort_source (#167, ADR-0014 F1 追補 P1)", () => {
    it("有効な ModelSource を受け入れる", () => {
      for (const source of ["launch", "env", "config", "default"]) {
        expect(
          parseConfig({ ...valid, model_source: source }),
        ).toMatchObject({ model_source: source });
        expect(
          parseConfig({ ...valid, effort_source: source }),
        ).toMatchObject({ effort_source: source });
      }
    });

    it("不正な model_source / effort_source は ConfigError", () => {
      for (const bad of ["", "yolo", "LAUNCH", 1, null]) {
        expect(() =>
          parseConfig({ ...valid, model_source: bad }),
        ).toThrow(ConfigError);
        expect(() =>
          parseConfig({ ...valid, effort_source: bad }),
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

  // Nested inside "parseConfig" (not a sibling top-level describe) so this
  // inherits the outer beforeEach clearing KAOIRO_WRAPPER_PERMISSION_TIMEOUT_MS
  // (藤 review #167 S2): 15 of these 16 cases leave permission_timeout_ms
  // unset, so without that cleanup a leftover/invalid env value made
  // parseConfig throw for every one of them when this describe ran standalone.
  describe("WrapperConfig optional field round-trip (issue #167, 型駆動)", () => {
    for (const field of Object.keys(
      ROUND_TRIP_CASES,
    ) as WrapperConfigOptionalKey[]) {
      it(`${field} が config JSON → parseConfig を round-trip する`, () => {
        const { value } = ROUND_TRIP_CASES[field];
        const raw = { ...valid, [field]: value };
        const parsed = parseConfig(raw);
        expect(parsed[field]).toEqual(value);
      });
    }
  });
});
