import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  PHOENIX_HEARTBEAT_LOGS_ENV,
  SERVER_URL_ENV,
  applyServerUrlOverride,
  buildHeartbeat,
  buildRegister,
  isPhoenixHeartbeatLoggingEnabled,
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

  it.each([60.5, 100])(
    "context_work_budget_percent の有限な (0, 100] の値 %p を受け入れる",
    (percent) => {
      expect(
        parseRunnerConfig({ ...valid, context_work_budget_percent: percent }),
      ).toMatchObject({ context_work_budget_percent: percent });
    },
  );

  it.each([0, -1, 100.1, Infinity, NaN, "60"])(
    "不正な context_work_budget_percent %p は fail-fast で弾く",
    (invalid) => {
      expect(() =>
        parseRunnerConfig({ ...valid, context_work_budget_percent: invalid }),
      ).toThrowError(
        "context_work_budget_percent must be a finite number greater than 0 and at most 100",
      );
    },
  );

  it("buildRegister は claudeCatalogOverride を claude-code entry に反映する (ADR-0039)", () => {
    const cfg = parseRunnerConfig({
      ...valid,
      capabilities: ["claude-code"],
    });
    const override = [
      {
        value: "sonnet",
        display_name: "Sonnet",
        description: "",
      },
    ];
    const reg = buildRegister(cfg, "unknown", override);
    const claude = reg.engines?.find((e) => e.id === "claude-code");
    expect(claude?.models).toEqual(override);
  });

  it("buildRegister は claudeCatalogOverride 未指定なら bootstrap を使う", () => {
    const cfg = parseRunnerConfig({
      ...valid,
      capabilities: ["claude-code"],
    });
    const reg = buildRegister(cfg, "unknown");
    const claude = reg.engines?.find((e) => e.id === "claude-code");
    // ADR-0037 F1 で BOOTSTRAP は default 1 エントリのみ
    expect(claude?.models.map((m) => m.value)).toEqual(["default"]);
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

  it("codex.internal_subagents の boolean を受け入れる", () => {
    expect(
      parseRunnerConfig({ ...valid, codex: { internal_subagents: true } })
        .codex?.internal_subagents,
    ).toBe(true);
    expect(
      parseRunnerConfig({ ...valid, codex: { internal_subagents: false } })
        .codex?.internal_subagents,
    ).toBe(false);
  });

  it("codex.internal_subagents 省略は undefined (既定=有効)", () => {
    expect(
      parseRunnerConfig({ ...valid, codex: {} }).codex?.internal_subagents,
    ).toBeUndefined();
  });

  it("codex.internal_subagents が boolean でなければ loud config error にする", () => {
    expect(() =>
      parseRunnerConfig({
        ...valid,
        codex: { internal_subagents: "yes" },
      }),
    ).toThrowError("codex.internal_subagents must be a boolean");
  });

  // Phase-24: explicit `codex.auth_mode` closed enum for the dogfood
  // 環境依存回帰対策。旧 config 互換 (auth_mode 省略 = doctor fallback)
  // も同時に pin する。
  it.each(["chatgpt", "apikey"] as const)(
    "codex.auth_mode の closed enum %s を受け入れる (Phase-24)",
    (mode) => {
      const config = parseRunnerConfig({
        ...valid,
        codex: { auth_mode: mode },
      });
      expect(config.codex?.auth_mode).toBe(mode);
    },
  );

  it("codex.auth_mode 省略は undefined (旧 config 互換 / doctor fallback 経路)", () => {
    expect(
      parseRunnerConfig({ ...valid, codex: {} }).codex?.auth_mode,
    ).toBeUndefined();
  });

  it("未知の codex.auth_mode を loud config error にする (fail-fast)", () => {
    expect(() =>
      parseRunnerConfig({
        ...valid,
        codex: { auth_mode: "oauth" },
      }),
    ).toThrowError("codex.auth_mode must be one of: chatgpt, apikey");
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
    // Claude exposes a default-floor bootstrap so LaunchDialog always has a
    // safe choice before SDK init resolves the account catalog (ADR-0037 F1);
    // Codex remains empty without auth/plan.
    expect(register.engines?.map((e) => e.id)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(register.engines?.[0]?.models.map((m) => m.value)).toEqual([
      "default",
    ]);
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

  // issue #228: build_revision/build_dirty は buildInfo が渡されたときだけ
  // 載る。渡されなければ既存呼び出し (register/reload の3箇所すべてが
  // buildInfo を渡すよう更新済みだが、テストの後方互換のため) と同じ
  // 形のまま — フィールド自体が現れない。
  it("buildInfo を渡すと build_revision/build_dirty が register に載る", () => {
    const config = parseRunnerConfig(valid);
    const register = buildRegister(config, "unknown", undefined, {
      revision: "abc123def456",
      dirty: false,
      built_at: "2026-08-12T00:00:00.000Z",
    });
    expect(register.build_revision).toBe("abc123def456");
    expect(register.build_dirty).toBe(false);
  });

  it("buildInfo の version/channel も register に載る", () => {
    const config = parseRunnerConfig(valid);
    const register = buildRegister(config, "unknown", undefined, {
      revision: "0123456789abcdef0123456789abcdef01234567",
      dirty: false,
      built_at: "2026-08-12T00:00:00.000Z",
      version: "2026.9.0",
      channel: "release",
    });
    expect(register.build_version).toBe("2026.9.0");
    expect(register.build_channel).toBe("release");
  });

  it("release の矛盾した buildInfo は unknown/dev に fail-soft する", () => {
    const config = parseRunnerConfig(valid);
    const register = buildRegister(config, "unknown", undefined, {
      revision: "unknown",
      dirty: true,
      built_at: "2026-08-12T00:00:00.000Z",
      version: "2026.9.0",
      channel: "release",
    });
    expect(register.build_revision).toBe("unknown");
    expect(register.build_dirty).toBe(false);
    expect(register.build_version).toBe("unknown");
    expect(register.build_channel).toBe("dev");
  });

  it("dirty な buildInfo は build_dirty=true として載る", () => {
    const config = parseRunnerConfig(valid);
    const register = buildRegister(config, "unknown", undefined, {
      revision: "abc123def456",
      dirty: true,
      built_at: "2026-08-12T00:00:00.000Z",
    });
    expect(register.build_dirty).toBe(true);
  });

  it("buildInfo を渡さなければ build_revision/build_dirty は現れない", () => {
    const config = parseRunnerConfig(valid);
    const register = buildRegister(config);
    expect(register.build_revision).toBeUndefined();
    expect(register.build_dirty).toBeUndefined();
    expect("build_revision" in register).toBe(false);
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

describe("applyServerUrlOverride (issue #140)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(`${SERVER_URL_ENV} 未設定なら config をそのまま返す`, () => {
    vi.stubEnv(SERVER_URL_ENV, "");
    const config = parseRunnerConfig(valid);
    expect(applyServerUrlOverride(config)).toEqual(config);
  });

  it(`${SERVER_URL_ENV} 設定時は server_url を上書きする (env > config file)`, () => {
    vi.stubEnv(SERVER_URL_ENV, "wss://prod.example:4000/runner");
    const config = parseRunnerConfig(valid);
    expect(applyServerUrlOverride(config)).toEqual({
      ...config,
      server_url: "wss://prod.example:4000/runner",
    });
  });

  it("ws:// / wss:// 以外は ConfigError にする", () => {
    vi.stubEnv(SERVER_URL_ENV, "http://prod.example:4000/runner");
    const config = parseRunnerConfig(valid);
    expect(() => applyServerUrlOverride(config)).toThrow(ConfigError);
  });

  it("config 自体は変更せず新しいオブジェクトを返す", () => {
    vi.stubEnv(SERVER_URL_ENV, "wss://prod.example:4000/runner");
    const config = parseRunnerConfig(valid);
    const overridden = applyServerUrlOverride(config);
    expect(overridden).not.toBe(config);
    expect(config.server_url).toBe(valid.server_url);
  });
});

describe("isPhoenixHeartbeatLoggingEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("未設定では heartbeat wire log を抑止する", () => {
    vi.stubEnv(PHOENIX_HEARTBEAT_LOGS_ENV, undefined);
    expect(isPhoenixHeartbeatLoggingEnabled()).toBe(false);
  });

  it("値 1 のときだけ全量 wire log を有効化する", () => {
    vi.stubEnv(PHOENIX_HEARTBEAT_LOGS_ENV, "1");
    expect(isPhoenixHeartbeatLoggingEnabled()).toBe(true);
    vi.stubEnv(PHOENIX_HEARTBEAT_LOGS_ENV, "true");
    expect(isPhoenixHeartbeatLoggingEnabled()).toBe(false);
  });
});
